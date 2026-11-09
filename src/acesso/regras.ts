import type { DB } from '../db/db.js';
import type { Agora } from '../tempo.js';

export type TipoCredencial = 'cartao' | 'biometria' | 'qrcode' | 'facial';
export type Sentido = 'entrada' | 'saida';

export interface Decisao {
  liberado: boolean;
  sentido: Sentido;
  pessoaId: number | null;
  nome: string | null;
  motivo: string;          // registrado no banco
  mensagem: string;        // exibido no display da catraca (curto)
}

interface PessoaRow {
  id: number; nome: string; tipo: 'aluno' | 'funcionario' | 'visitante';
  turma_id: number | null; ativo: number; acesso_livre: number; valido_ate: string | null;
}

interface HorarioRow {
  entrada_inicio: string; entrada_fim: string; saida_inicio: string; saida_fim: string;
}

function primeiroNome(nome: string): string {
  return nome.trim().split(/\s+/)[0] ?? nome;
}

function dentro(hora: string, ini: string, fim: string): boolean {
  return hora >= ini && hora <= fim;
}

/** Sentido provável quando a catraca não informa: alterna com a última passagem do dia. */
export function sentidoProvavel(db: DB, pessoaId: number, data: string): Sentido {
  const ultimo = db.prepare(
    `SELECT sentido FROM eventos
      WHERE pessoa_id = ? AND resultado IN ('passou','manual') AND ocorrido_em >= ?
      ORDER BY ocorrido_em DESC, id DESC LIMIT 1`,
  ).get(pessoaId, `${data} 00:00:00`) as { sentido: Sentido } | undefined;
  return ultimo?.sentido === 'entrada' ? 'saida' : 'entrada';
}

/** Procura a pessoa dona da credencial, testando os tipos na ordem dada. */
export function buscarPorCredencial(
  db: DB, tipos: TipoCredencial[], valor: string,
): { pessoa: PessoaRow; tipo: TipoCredencial } | null {
  const stmt = db.prepare(
    `SELECT p.id, p.nome, p.tipo, p.turma_id, p.ativo, p.acesso_livre, p.valido_ate
       FROM credenciais c JOIN pessoas p ON p.id = c.pessoa_id
      WHERE c.tipo = ? AND c.valor = ? AND c.ativa = 1`,
  );
  for (const tipo of tipos) {
    const pessoa = stmt.get(tipo, normalizarCredencial(tipo, valor)) as PessoaRow | undefined;
    if (pessoa) return { pessoa, tipo };
  }
  return null;
}

/**
 * Decide se libera. `tipos` lista os tipos de credencial a testar: a Lumen envia o mesmo
 * campo numérico para cartão, digital e QR, então no modo online testamos os três.
 */
export function decidirAcesso(
  db: DB,
  tipos: TipoCredencial | TipoCredencial[],
  valor: string,
  sentidoInformado: Sentido | null,
  agora: Agora,
): Decisao & { tipoCredencial: TipoCredencial | null } {
  const lista = Array.isArray(tipos) ? tipos : [tipos];
  const achado = buscarPorCredencial(db, lista, valor);
  return { ...avaliar(db, achado?.pessoa, sentidoInformado, agora), tipoCredencial: achado?.tipo ?? null };
}

function avaliar(db: DB, p: PessoaRow | undefined, sentidoInformado: Sentido | null, agora: Agora): Decisao {
  const negar = (motivo: string, mensagem: string, p?: PessoaRow, sentido: Sentido = sentidoInformado ?? 'entrada'): Decisao =>
    ({ liberado: false, sentido, pessoaId: p?.id ?? null, nome: p?.nome ?? null, motivo, mensagem });

  if (!p) return negar('credencial nao cadastrada', 'NAO CADASTRADO');
  if (!p.ativo) return negar('cadastro inativo', 'ACESSO BLOQUEADO', p);
  if (p.valido_ate && agora.data > p.valido_ate) return negar('cadastro vencido', 'CADASTRO VENCIDO', p);

  const sentido = sentidoInformado ?? sentidoProvavel(db, p.id, agora.data);
  const ok = (motivo: string): Decisao => ({
    liberado: true, sentido, pessoaId: p.id, nome: p.nome, motivo,
    mensagem: `${sentido === 'entrada' ? 'BEM-VINDO' : 'ATE LOGO'} ${primeiroNome(p.nome).toUpperCase()}`,
  });

  if (p.acesso_livre || p.tipo === 'funcionario') return ok('acesso livre');
  if (p.tipo === 'visitante') {
    return p.valido_ate ? ok('visitante dentro da validade') : negar('visitante sem validade definida', 'PROCURE A RECEPCAO', p, sentido);
  }

  // Aluno
  const semAula = db.prepare('SELECT 1 FROM dias_sem_aula WHERE data = ?').get(agora.data);
  if (semAula) return negar('dia sem aula', 'HOJE NAO HA AULA', p, sentido);
  if (!p.turma_id) return negar('aluno sem turma', 'PROCURE A SECRETARIA', p, sentido);

  const horarios = db.prepare(
    `SELECT h.entrada_inicio, h.entrada_fim, h.saida_inicio, h.saida_fim
       FROM horarios_turma h JOIN turmas t ON t.id = h.turma_id
      WHERE h.turma_id = ? AND h.dia_semana = ? AND t.ativa = 1`,
  ).all(p.turma_id, agora.diaSemana) as HorarioRow[];
  if (horarios.length === 0) return negar('turma sem aula neste dia', 'SEM AULA HOJE', p, sentido);

  const permitido = horarios.some((h) =>
    sentido === 'entrada'
      ? dentro(agora.hora, h.entrada_inicio, h.entrada_fim)
      : dentro(agora.hora, h.saida_inicio, h.saida_fim),
  );
  if (!permitido) {
    return negar(
      sentido === 'entrada' ? 'fora do horario de entrada' : 'fora do horario de saida',
      'PROCURE A SECRETARIA', p, sentido,
    );
  }
  return ok('dentro do horario da turma');
}

/**
 * Cartões RFID chegam da catraca com zeros à esquerda e tamanhos variados.
 * Guardamos sem zeros à esquerda para o mesmo cartão sempre bater.
 */
export function normalizarCredencial(tipo: TipoCredencial, valor: string): string {
  const v = valor.trim();
  if (tipo === 'cartao' || tipo === 'biometria') return v.replace(/^0+(?=\d)/, '');
  return v;
}
