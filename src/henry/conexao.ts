import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { LeitorQuadros, montarMensagem, type MensagemHenry } from './protocolo.js';

export interface StatusConexao {
  conectada: boolean;
  desde: string | null;
  ultimaMensagem: string | null;
  erro: string | null;
}

/**
 * Mantém a conexão TCP com uma catraca Henry, reconectando sozinha quando cai.
 * Eventos: 'mensagem' (MensagemHenry), 'conectou', 'caiu' (motivo).
 */
export class ConexaoHenry extends EventEmitter {
  private socket: Socket | null = null;
  private leitor = new LeitorQuadros();
  private timerReconexao: NodeJS.Timeout | null = null;
  private encerrada = false;
  private proximoIndice = 1;
  status: StatusConexao = { conectada: false, desde: null, ultimaMensagem: null, erro: null };

  constructor(
    readonly catracaId: number,
    readonly ip: string,
    readonly porta: number,
    private readonly reconexaoMs = 5000,
  ) {
    super();
  }

  iniciar(): void {
    this.encerrada = false;
    this.conectar();
  }

  parar(): void {
    this.encerrada = true;
    if (this.timerReconexao) clearTimeout(this.timerReconexao);
    this.socket?.destroy();
    this.socket = null;
  }

  /** Índice de 2 dígitos para mensagens iniciadas pelo SchoolPass. */
  novoIndice(): string {
    const i = this.proximoIndice;
    this.proximoIndice = (this.proximoIndice % 99) + 1;
    return String(i).padStart(2, '0');
  }

  enviar(m: MensagemHenry): boolean {
    if (!this.socket || !this.status.conectada) return false;
    this.socket.write(montarMensagem(m));
    return true;
  }

  private conectar(): void {
    if (this.encerrada) return;
    const s = new Socket();
    this.socket = s;
    s.setNoDelay(true);
    s.setKeepAlive(true, 10_000);
    s.setTimeout(0);

    s.connect(this.porta, this.ip, () => {
      this.leitor = new LeitorQuadros();
      this.status = { conectada: true, desde: new Date().toISOString(), ultimaMensagem: null, erro: null };
      this.emit('conectou');
    });

    s.on('data', (pedaco: Buffer) => {
      this.status.ultimaMensagem = new Date().toISOString();
      for (const msg of this.leitor.alimentar(pedaco)) this.emit('mensagem', msg);
    });

    s.on('error', (e) => { this.status.erro = e.message; });

    s.on('close', () => {
      const estava = this.status.conectada;
      this.status.conectada = false;
      if (estava) this.emit('caiu', this.status.erro ?? 'conexao encerrada');
      if (!this.encerrada) {
        this.timerReconexao = setTimeout(() => this.conectar(), this.reconexaoMs);
      }
    });
  }
}
