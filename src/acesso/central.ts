import { EventEmitter } from 'node:events';
import type { DB } from '../db/db.js';
import { config } from '../config.js';
import { ConexaoHenry, type StatusConexao } from '../henry/conexao.js';
import { codigos } from '../henry/codigos.js';
import type { MensagemHenry } from '../henry/protocolo.js';
import { agoraNaEscola, deHenry, type Agora } from '../tempo.js';
import { decidirAcesso, type Decisao, type Sentido, type TipoCredencial } from './regras.js';
import type { Notificador } from '../notificacao/notificador.js';

export interface Catraca {
  id: number; nome: string; ip: string; porta: number;
  modo: 'online' | 'offline'; sentido_invertido: number; ativa: number;
}

interface Pendente {
  eventoId: number;
  decisao: Decisao;
  credencial: string;
  tipo: TipoCredencial | null;
  origem: 'online' | 'facial' | 'manual';
  timer: NodeJS.Timeout;
}

/** Eventos emitidos para o painel em tempo real: 'evento' (linha registrada), 'status'. */
export class CentralCatracas extends EventEmitter {
  private conexoes = new Map<number, ConexaoHenry>();
  private catracas = new Map<number, Catraca>();
  private pendentes = new Map<number, Pendente>(); // um por catraca
  /** Se 0, a liberação já conta como passagem (para firmwares que não avisam o giro). */
  private confirmaGiro = process.env.HENRY_CONFIRMA_GIRO !== '0';

  constructor(
    private db: DB,
    private notificador: Notificador,
    private relogio: () => Agora = () => agoraNaEscola(),
  ) {
    super();
  }

  iniciar(): void {
    const lista = this.db.prepare('SELECT * FROM catracas WHERE ativa = 1').all() as Catraca[];
    for (const c of lista) this.conectar(c);
  }

  parar(): void {
    for (const c of this.conexoes.values()) c.parar();
    for (const p of this.pendentes.values()) clearTimeout(p.timer);
    this.conexoes.clear();
    this.pendentes.clear();
  }

  /** Recarrega uma catraca depois de editar no painel. */
  recarregar(id: number): void {
    this.conexoes.get(id)?.parar();
    this.conexoes.delete(id);
    this.catracas.delete(id);
    const c = this.db.prepare('SELECT * FROM catracas WHERE id = ? AND ativa = 1').get(id) as Catraca | undefined;
    if (c) this.conectar(c);
  }

  statusTodas(): Array<Catraca & { conexao: StatusConexao }> {
    const lista = this.db.prepare('SELECT * FROM catracas ORDER BY nome').all() as Catraca[];
    return lista.map((c) => ({
      ...c,
      conexao: this.conexoes.get(c.id)?.status ?? { conectada: false, desde: null, ultimaMensagem: null, erro: 'desativada' },
    }));
  }

  conexao(id: number): ConexaoHenry | undefined {
    return this.conexoes.get(id);
  }

  private conectar(c: Catraca): void {
    const con = new ConexaoHenry(c.id, c.ip, c.porta, config.henry.reconexaoMs);
    con.on('mensagem', (m: MensagemHenry) => this.tratarMensagem(c.id, m));
    con.on('conectou', () => this.emit('status', { catracaId: c.id, conectada: true }));
    con.on('caiu', (motivo: string) => this.emit('status', { catracaId: c.id, conectada: false, motivo }));
    this.catracas.set(c.id, c);
    this.conexoes.set(c.id, con);
    con.iniciar();
  }

  // ------------------------------------------------------------------ mensagens da catraca

  tratarMensagem(catracaId: number, m: MensagemHenry): void {
    if (m.comando !== 'REON') return; // respostas de RC/EC/EH etc. são tratadas por quem enviou
    const campos = m.dados.split(']');
    const codigo = campos[0];
    try {
      if (codigo === codigos.solicitacaoAcesso) this.aoSolicitar(catracaId, m.indice, campos);
      else if (codigo === codigos.giroConcluido) this.aoGirar(catracaId, campos);
      else if (codigo === codigos.desistencia) this.aoDesistir(catracaId);
      // aguardandoGiro e outros códigos: apenas informativos
    } catch (e) {
      console.error(`[catraca ${catracaId}] erro tratando ${m.dados}:`, e);
    }
  }

  private sentidoDaCatraca(catracaId: number, bruto: string | undefined): Sentido | null {
    let s: Sentido | null =
      bruto === codigos.sentidoEntrada ? 'entrada' : bruto === codigos.sentidoSaida ? 'saida' : null;
    if (s && this.catracas.get(catracaId)?.sentido_invertido) s = s === 'entrada' ? 'saida' : 'entrada';
    return s;
  }

  private aoSolicitar(catracaId: number, indice: string, campos: string[]): void {
    const catraca = this.catracas.get(catracaId);
    const credencial = (campos[1] ?? '').trim();
    const sentido = this.sentidoDaCatraca(catracaId, campos[3]);
    const agora = this.relogio();

    // Em modo offline a própria catraca decide; só registramos o que ela informar.
    if (catraca?.modo === 'offline') return;

    const d = decidirAcesso(this.db, ['cartao', 'biometria', 'qrcode'], credencial, sentido, agora);
    const codigo = !d.liberado ? codigos.negar
      : sentido === null ? codigos.liberarAmbos
      : d.sentido === 'entrada' ? codigos.liberarEntrada : codigos.liberarSaida;
    this.responder(catracaId, indice, codigo, d.mensagem, d.liberado);

    const eventoId = this.registrar({
      catracaId, pessoaId: d.pessoaId, tipo: d.tipoCredencial, valor: credencial, sentido: d.sentido,
      resultado: d.liberado ? 'liberado' : 'negado', motivo: d.motivo, origem: 'online', quando: agora.completo,
    });
    if (d.liberado) this.aguardarGiro(catracaId, { eventoId, decisao: d, credencial, tipo: d.tipoCredencial, origem: 'online' });
  }

  private aguardarGiro(catracaId: number, p: Omit<Pendente, 'timer'>): void {
    this.cancelarPendente(catracaId);
    if (!this.confirmaGiro) {
      this.confirmarPassagem(catracaId, p, p.decisao.sentido);
      return;
    }
    const espera = (config.henry.tempoLiberacao + 5) * 1000;
    const timer = setTimeout(() => {
      this.pendentes.delete(catracaId);
      this.registrarDesistencia(catracaId, p, 'catraca nao confirmou o giro');
    }, espera);
    this.pendentes.set(catracaId, { ...p, timer });
  }

  private cancelarPendente(catracaId: number): Pendente | undefined {
    const p = this.pendentes.get(catracaId);
    if (p) { clearTimeout(p.timer); this.pendentes.delete(catracaId); }
    return p;
  }

  private aoGirar(catracaId: number, campos: string[]): void {
    const p = this.cancelarPendente(catracaId);
    const sentido = this.sentidoDaCatraca(catracaId, campos[3]);
    if (p) {
      this.confirmarPassagem(catracaId, p, sentido ?? p.decisao.sentido);
      return;
    }
    // Giro sem solicitação nossa: catraca em modo offline decidindo sozinha
    const credencial = (campos[1] ?? '').trim();
    if (credencial) {
      const quando = (campos[2] && deHenry(campos[2])) || this.relogio().completo;
      this.importarOffline(catracaId, credencial, sentido, quando);
    }
  }

  private aoDesistir(catracaId: number): void {
    const p = this.cancelarPendente(catracaId);
    if (p) this.registrarDesistencia(catracaId, p, 'tempo esgotado sem giro');
  }

  /**
   * Cada tentativa é uma única linha em `eventos`: nasce como 'liberado' e é concluída aqui
   * como 'passou'/'manual' (com o horário real do giro) ou 'desistiu'.
   */
  private confirmarPassagem(_catracaId: number, p: Omit<Pendente, 'timer'>, sentido: Sentido): void {
    this.concluir(p.eventoId, p.origem === 'manual' ? 'manual' : 'passou', sentido, p.decisao.motivo);
    if (p.decisao.pessoaId) this.notificador.enfileirar(p.eventoId);
  }

  private registrarDesistencia(_catracaId: number, p: Omit<Pendente, 'timer'>, motivo: string): void {
    this.concluir(p.eventoId, 'desistiu', p.decisao.sentido, motivo);
  }

  private concluir(eventoId: number, resultado: string, sentido: Sentido, motivo: string): void {
    this.db.prepare('UPDATE eventos SET resultado = ?, sentido = ?, motivo = ?, ocorrido_em = ? WHERE id = ?')
      .run(resultado, sentido, motivo, this.relogio().completo, eventoId);
    this.emitirEvento(eventoId);
  }

  /** Passagem que a catraca autorizou sozinha (modo offline ou memória de contingência). */
  importarOffline(catracaId: number, credencial: string, sentido: Sentido | null, quando: string): number | null {
    const d = decidirAcesso(this.db, ['cartao', 'biometria', 'qrcode'], credencial, sentido, agoraNaEscola(new Date(quando.replace(' ', 'T') + 'Z'), 'UTC'));
    const r = this.db.prepare(
      `INSERT OR IGNORE INTO eventos
        (catraca_id, pessoa_id, credencial_tipo, credencial_valor, sentido, resultado, motivo, origem, ocorrido_em)
       VALUES (?, ?, ?, ?, ?, 'passou', 'registro da memoria da catraca', 'offline', ?)`,
    ).run(catracaId, d.pessoaId, d.tipoCredencial, credencial, sentido ?? d.sentido, quando);
    if (r.changes === 0) return null;
    const id = Number(r.lastInsertRowid);
    this.emitirEvento(id);
    // Só avisa os pais se o registro for recente (evita rajada de avisos antigos ao reconectar)
    if (d.pessoaId && minutosEntre(quando, this.relogio().completo) <= 30) this.notificador.enfileirar(id);
    return id;
  }

  // ------------------------------------------------------------------ ações do painel / facial

  /** Libera a catraca sem leitura (botão no painel). */
  liberarManual(catracaId: number, sentido: Sentido, pessoaId: number | null, motivo: string): boolean {
    const nome = pessoaId
      ? (this.db.prepare('SELECT nome FROM pessoas WHERE id = ?').get(pessoaId) as { nome: string } | undefined)?.nome ?? null
      : null;
    const decisao: Decisao = {
      liberado: true, sentido, pessoaId, nome, motivo: `manual: ${motivo}`,
      mensagem: nome ? `LIBERADO ${nome.split(' ')[0].toUpperCase()}` : 'LIBERADO',
    };
    return this.liberarRemoto(catracaId, decisao, '', null, 'manual');
  }

  /** Reconhecimento facial vindo de um terminal externo. */
  reconhecimentoFacial(catracaId: number, idFacial: string, sentido: Sentido | null): Decisao & { enviado: boolean } {
    const agora = this.relogio();
    const d = decidirAcesso(this.db, 'facial', idFacial, sentido, agora);
    if (!d.liberado) {
      this.registrar({
        catracaId, pessoaId: d.pessoaId, tipo: 'facial', valor: idFacial, sentido: d.sentido,
        resultado: 'negado', motivo: d.motivo, origem: 'facial', quando: agora.completo,
      });
      return { ...d, enviado: false };
    }
    return { ...d, enviado: this.liberarRemoto(catracaId, d, idFacial, 'facial', 'facial') };
  }

  private liberarRemoto(
    catracaId: number, d: Decisao, credencial: string, tipo: TipoCredencial | null, origem: 'manual' | 'facial',
  ): boolean {
    const con = this.conexoes.get(catracaId);
    if (!con) return false;
    const enviado = con.enviar({
      indice: con.novoIndice(), comando: 'REON', status: '00',
      dados: `${codigos.liberacaoRemota}]${config.henry.tempoLiberacao}]${d.mensagem}]${d.sentido === 'entrada' ? '1' : '2'}`,
    });
    if (!enviado) return false;
    const eventoId = this.registrar({
      catracaId, pessoaId: d.pessoaId, tipo, valor: credencial, sentido: d.sentido,
      resultado: 'liberado', motivo: d.motivo, origem, quando: this.relogio().completo,
    });
    this.aguardarGiro(catracaId, { eventoId, decisao: d, credencial, tipo, origem });
    return true;
  }

  // ------------------------------------------------------------------ utilidades

  private responder(catracaId: number, indice: string, codigo: string, mensagem: string, liberado = false): void {
    this.conexoes.get(catracaId)?.enviar({
      indice, comando: 'REON', status: '00',
      dados: `${codigo}]${config.henry.tempoLiberacao}]${mensagem.slice(0, 32)}]${liberado ? '2' : '1'}`,
    });
  }

  private registrar(e: {
    catracaId: number; pessoaId: number | null; tipo: TipoCredencial | null; valor: string;
    sentido: Sentido; resultado: string; motivo: string; origem: string; quando: string;
  }): number {
    const r = this.db.prepare(
      `INSERT INTO eventos (catraca_id, pessoa_id, credencial_tipo, credencial_valor, sentido, resultado, motivo, origem, ocorrido_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(e.catracaId, e.pessoaId, e.tipo, e.valor || null, e.sentido, e.resultado, e.motivo, e.origem, e.quando);
    const id = Number(r.lastInsertRowid);
    this.emitirEvento(id);
    return id;
  }

  private emitirEvento(id: number): void {
    const linha = this.db.prepare(
      `SELECT e.*, p.nome AS pessoa_nome, c.nome AS catraca_nome FROM eventos e
         LEFT JOIN pessoas p ON p.id = e.pessoa_id LEFT JOIN catracas c ON c.id = e.catraca_id WHERE e.id = ?`,
    ).get(id);
    this.emit('evento', linha);
  }
}

function minutosEntre(a: string, b: string): number {
  const ms = (s: string) => Date.parse(s.replace(' ', 'T') + 'Z');
  return Math.abs(ms(b) - ms(a)) / 60_000;
}
