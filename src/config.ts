// Configuração via variáveis de ambiente (veja .env.example)
function num(v: string | undefined, padrao: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : padrao;
}

export const config = {
  porta: num(process.env.PORT, 8080),
  host: process.env.HOST ?? '0.0.0.0',
  bancoArquivo: process.env.DB_FILE ?? 'data/schoolpass.db',
  // Token simples para proteger o painel e a API. TROQUE em produção.
  tokenAdmin: process.env.ADMIN_TOKEN ?? 'troque-este-token',
  fusoHorario: process.env.TZ_ESCOLA ?? 'America/Manaus',

  henry: {
    // Tempo (s) que a catraca fica liberada esperando o giro
    tempoLiberacao: num(process.env.HENRY_TEMPO_LIBERACAO, 5),
    // Intervalo (ms) para reconectar quando a catraca cai
    reconexaoMs: num(process.env.HENRY_RECONEXAO_MS, 5000),
    // Intervalo (min) para acertar o relógio das catracas
    sincronizacaoMin: num(process.env.HENRY_SINCRONIZACAO_MIN, 60),
  },

  notificacao: {
    // 'console' | 'webhook' | 'whatsapp'
    canal: process.env.NOTIFICACAO_CANAL ?? 'console',
    webhookUrl: process.env.NOTIFICACAO_WEBHOOK_URL,
    whatsappToken: process.env.WHATSAPP_TOKEN,
    whatsappPhoneId: process.env.WHATSAPP_PHONE_ID,
    whatsappTemplate: process.env.WHATSAPP_TEMPLATE ?? 'aviso_catraca',
    nomeEscola: process.env.NOME_ESCOLA ?? 'Escola',
  },

  facial: {
    // Chave que o terminal facial (quando instalado) usa para chamar /api/facial/reconhecimento
    chave: process.env.FACIAL_CHAVE,
  },
};
