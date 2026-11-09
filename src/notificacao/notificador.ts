import type { DB } from '../db/db.js';
import { config } from '../config.js';

export interface Aviso {
  telefone: string | null;
  email: string | null;
  nomeResponsavel: string;
  nomeAluno: string;
  sentido: 'entrada' | 'saida';
  horario: string;        // 'YYYY-MM-DD HH:MM:SS'
  catraca: string | null;
}

export interface CanalAviso {
  nome: string;
  enviar(a: Aviso): Promise<void>;
}

export function textoAviso(a: Aviso): string {
  const hora = a.horario.slice(11, 16);
  const [ano, mes, dia] = a.horario.slice(0, 10).split('-');
  const acao = a.sentido === 'entrada' ? 'entrou na' : 'saiu da';
  return `${config.notificacao.nomeEscola}: ${a.nomeAluno} ${acao} escola às ${hora} de ${dia}/${mes}/${ano}.`;
}

/** Só registra no log. Útil para testes e enquanto o WhatsApp não está configurado. */
export const canalConsole: CanalAviso = {
  nome: 'console',
  async enviar(a) { console.log(`[aviso] para ${a.nomeResponsavel} (${a.telefone ?? a.email}): ${textoAviso(a)}`); },
};

/** POST JSON para qualquer URL (n8n, Zapier, um bot próprio de WhatsApp, etc.). */
export function canalWebhook(url: string): CanalAviso {
  return {
    nome: 'webhook',
    async enviar(a) {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...a, texto: textoAviso(a) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`webhook respondeu ${r.status}`);
    },
  };
}

/**
 * WhatsApp Cloud API (Meta). Mensagens iniciadas pela escola exigem um modelo (template)
 * aprovado pela Meta. O modelo padrão "aviso_catraca" deve ter 3 variáveis:
 * {{1}} nome do aluno, {{2}} "entrou na"/"saiu da", {{3}} horário.
 */
export function canalWhatsApp(token: string, phoneId: string, template: string): CanalAviso {
  return {
    nome: 'whatsapp',
    async enviar(a) {
      if (!a.telefone) throw new Error('responsável sem telefone');
      const para = a.telefone.replace(/\D/g, '');
      const hora = `${a.horario.slice(11, 16)} de ${a.horario.slice(8, 10)}/${a.horario.slice(5, 7)}`;
      const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: para,
          type: 'template',
          template: {
            name: template,
            language: { code: 'pt_BR' },
            components: [{
              type: 'body',
              parameters: [
                { type: 'text', text: a.nomeAluno },
                { type: 'text', text: a.sentido === 'entrada' ? 'entrou na' : 'saiu da' },
                { type: 'text', text: hora },
              ],
            }],
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`WhatsApp respondeu ${r.status}: ${(await r.text()).slice(0, 200)}`);
    },
  };
}

export function canalConfigurado(): CanalAviso {
  const n = config.notificacao;
  if (n.canal === 'whatsapp' && n.whatsappToken && n.whatsappPhoneId) {
    return canalWhatsApp(n.whatsappToken, n.whatsappPhoneId, n.whatsappTemplate);
  }
  if (n.canal === 'webhook' && n.webhookUrl) return canalWebhook(n.webhookUrl);
  if (n.canal !== 'console') console.warn(`[aviso] canal "${n.canal}" sem configuração completa; usando console`);
  return canalConsole;
}

const MAX_TENTATIVAS = 5;

/** Fila persistente: sobrevive a reinícios e tenta de novo quando o envio falha. */
export class Notificador {
  private rodando = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private db: DB, private canal: CanalAviso) {}

  /** Cria um aviso para cada responsável do aluno. Só alunos e só passagens recentes. */
  enfileirar(eventoId: number): number {
    const ev = this.db.prepare(
      `SELECT e.id, e.ocorrido_em, p.tipo FROM eventos e JOIN pessoas p ON p.id = e.pessoa_id
        WHERE e.id = ? AND e.resultado IN ('passou','manual') AND e.notificado = 0`,
    ).get(eventoId) as { id: number; ocorrido_em: string; tipo: string } | undefined;
    if (!ev || ev.tipo !== 'aluno') return 0;

    const r = this.db.prepare(
      `INSERT INTO notificacoes (evento_id, responsavel_id, canal)
       SELECT ?, r.id, ? FROM responsaveis r
         JOIN eventos e ON e.pessoa_id = r.pessoa_id
        WHERE e.id = ? AND r.notificar = 1`,
    ).run(eventoId, this.canal.nome, eventoId);
    this.db.prepare('UPDATE eventos SET notificado = 1 WHERE id = ?').run(eventoId);
    if (r.changes > 0) setImmediate(() => void this.processar());
    return r.changes;
  }

  iniciar(intervaloMs = 30_000): void {
    this.timer = setInterval(() => void this.processar(), intervaloMs);
  }

  parar(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async processar(): Promise<void> {
    if (this.rodando) return;
    this.rodando = true;
    try {
      const pendentes = this.db.prepare(
        `SELECT n.id, n.tentativas, r.nome AS responsavel, r.telefone, r.email,
                p.nome AS aluno, e.sentido, e.ocorrido_em, c.nome AS catraca
           FROM notificacoes n
           JOIN responsaveis r ON r.id = n.responsavel_id
           JOIN eventos e ON e.id = n.evento_id
           JOIN pessoas p ON p.id = e.pessoa_id
           LEFT JOIN catracas c ON c.id = e.catraca_id
          WHERE n.status = 'pendente' ORDER BY n.id LIMIT 50`,
      ).all() as Array<{
        id: number; tentativas: number; responsavel: string; telefone: string | null; email: string | null;
        aluno: string; sentido: 'entrada' | 'saida'; ocorrido_em: string; catraca: string | null;
      }>;
      for (const n of pendentes) {
        try {
          await this.canal.enviar({
            telefone: n.telefone, email: n.email, nomeResponsavel: n.responsavel,
            nomeAluno: n.aluno, sentido: n.sentido, horario: n.ocorrido_em, catraca: n.catraca,
          });
          this.db.prepare(`UPDATE notificacoes SET status='enviada', tentativas=tentativas+1, erro=NULL WHERE id=?`).run(n.id);
        } catch (e) {
          const t = n.tentativas + 1;
          this.db.prepare(`UPDATE notificacoes SET status=?, tentativas=?, erro=? WHERE id=?`)
            .run(t >= MAX_TENTATIVAS ? 'falhou' : 'pendente', t, String((e as Error).message ?? e), n.id);
        }
      }
    } finally {
      this.rodando = false;
    }
  }
}
