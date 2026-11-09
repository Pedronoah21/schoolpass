/**
 * Simulador de catraca Henry Lumen para testar sem o equipamento.
 *
 *   npm run simulador            (escuta na porta 3000)
 *   PORTA_SIM=3001 npm run simulador
 *
 * Cadastre no painel uma catraca com IP 127.0.0.1 e a porta do simulador e digite aqui:
 *   e 12345      -> apresenta o cartão 12345 querendo ENTRAR
 *   s 12345      -> apresenta o cartão 12345 querendo SAIR
 *   x 12345      -> apresenta sem sentido definido
 *   d            -> próxima liberação termina em desistência (não gira)
 *   o 12345 e    -> envia registro antigo (como se estivesse offline há 1 hora)
 */
import { createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { LeitorQuadros, montarMensagem, type MensagemHenry } from '../henry/protocolo.js';
import { codigos } from '../henry/codigos.js';

function dataHenry(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export class SimuladorLumen extends EventEmitter {
  private servidor = createServer((s) => this.aoConectar(s));
  private cliente: Socket | null = null;
  private leitor = new LeitorQuadros();
  private indice = 1;
  private ultimoCartao = '';
  private ultimoSentido = '0';
  desistirProxima = false;
  /** Atraso (ms) entre a liberação e o giro simulado. */
  atrasoGiro = 50;

  escutar(porta: number, host = '127.0.0.1'): Promise<number> {
    return new Promise((ok) => this.servidor.listen(porta, host, () => {
      const end = this.servidor.address();
      ok(typeof end === 'object' && end ? end.port : porta);
    }));
  }

  fechar(): Promise<void> {
    this.cliente?.destroy();
    return new Promise((ok) => this.servidor.close(() => ok()));
  }

  get conectado(): boolean { return this.cliente !== null; }

  private aoConectar(s: Socket): void {
    this.cliente?.destroy();
    this.cliente = s;
    this.leitor = new LeitorQuadros();
    this.emit('conectou');
    s.on('data', (b: Buffer) => { for (const m of this.leitor.alimentar(b)) this.aoReceber(m); });
    s.on('close', () => { if (this.cliente === s) this.cliente = null; this.emit('desconectou'); });
    s.on('error', () => {});
  }

  private enviar(dados: string, indice?: string): void {
    const i = indice ?? String(this.indice++ % 100).padStart(2, '0');
    this.cliente?.write(montarMensagem({ indice: i, comando: 'REON', status: '000', dados }));
  }

  /** Simula alguém apresentando cartão/digital/QR. sentido: 'e' | 's' | 'x' */
  apresentar(cartao: string, sentido: 'e' | 's' | 'x' = 'x', quando = new Date()): void {
    this.ultimoCartao = cartao;
    this.ultimoSentido = sentido === 'e' ? codigos.sentidoEntrada : sentido === 's' ? codigos.sentidoSaida : '0';
    this.enviar(`${codigos.solicitacaoAcesso}]${cartao}]${dataHenry(quando)}]${this.ultimoSentido}]0]`);
  }

  /** Simula uma passagem que a catraca liberou sozinha (modo offline) e informa depois. */
  registroOffline(cartao: string, sentido: 'e' | 's', quando: Date): void {
    const s = sentido === 'e' ? codigos.sentidoEntrada : codigos.sentidoSaida;
    this.enviar(`${codigos.giroConcluido}]${cartao}]${dataHenry(quando)}]${s}]0]`);
  }

  private aoReceber(m: MensagemHenry): void {
    this.emit('mensagem', m);
    if (m.comando !== 'REON') return;
    const [codigo, , texto, sentidoRemoto] = m.dados.split(']');
    const liberou = [codigos.liberarEntrada, codigos.liberarSaida, codigos.liberarAmbos, codigos.liberacaoRemota].includes(codigo);
    this.emit('display', { liberou, texto, codigo });
    if (!liberou) return;
    const sentidoGiro = codigo === codigos.liberarEntrada ? codigos.sentidoEntrada
      : codigo === codigos.liberarSaida ? codigos.sentidoSaida
      : codigo === codigos.liberacaoRemota ? (sentidoRemoto === '2' ? codigos.sentidoSaida : codigos.sentidoEntrada)
      : this.ultimoSentido !== '0' ? this.ultimoSentido : codigos.sentidoEntrada;
    const cartao = codigo === codigos.liberacaoRemota ? '' : this.ultimoCartao;
    setTimeout(() => {
      if (this.desistirProxima) {
        this.desistirProxima = false;
        this.enviar(`${codigos.desistencia}]${cartao}]${dataHenry()}]${sentidoGiro}]0]`);
      } else {
        this.enviar(`${codigos.giroConcluido}]${cartao}]${dataHenry()}]${sentidoGiro}]0]`);
      }
    }, this.atrasoGiro);
  }
}

// ---------------------------------------------------------------- uso pelo terminal
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sim = new SimuladorLumen();
  sim.atrasoGiro = 1500;
  const porta = await sim.escutar(Number(process.env.PORTA_SIM ?? 3000), '0.0.0.0');
  console.log(`Simulador Lumen escutando na porta ${porta}. Aguardando o SchoolPass conectar...`);
  sim.on('conectou', () => console.log('> SchoolPass conectado'));
  sim.on('desconectou', () => console.log('> SchoolPass desconectado'));
  sim.on('display', (d: { liberou: boolean; texto: string }) =>
    console.log(d.liberou ? `  [VERDE] ${d.texto} — girando...` : `  [VERMELHO] ${d.texto}`));
  sim.on('mensagem', (m: MensagemHenry) => { if (m.comando !== 'REON') console.log(`  < ${m.comando} ${m.dados}`); });

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (linha) => {
    const [cmd, cartao, s] = linha.trim().split(/\s+/);
    if (!sim.conectado) return console.log('SchoolPass ainda não conectou.');
    if ((cmd === 'e' || cmd === 's' || cmd === 'x') && cartao) sim.apresentar(cartao, cmd);
    else if (cmd === 'd') { sim.desistirProxima = true; console.log('Próxima liberação não vai girar.'); }
    else if (cmd === 'o' && cartao) sim.registroOffline(cartao, (s as 'e' | 's') ?? 'e', new Date(Date.now() - 3600_000));
    else console.log('Comandos: e <cartao> | s <cartao> | x <cartao> | d | o <cartao> [e|s]');
  });
}
