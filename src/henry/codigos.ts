/**
 * Códigos do protocolo Henry usados no modo online.
 *
 * ATENÇÃO: os valores abaixo seguem implementações públicas do protocolo Henry 7x/8x
 * (ex.: github.com/juliolvfilho/henry-php). Firmwares diferentes da Lumen podem usar
 * códigos distintos. Valide com o simulador de comunicação da Henry ou com o manual de
 * protocolo fornecido pelo revendedor e, se preciso, ajuste via HENRY_CODIGOS (JSON), ex.:
 *   HENRY_CODIGOS='{"liberarSaida":"7","giroConcluido":"81"}'
 */
export interface CodigosHenry {
  // Eventos que chegam da catraca (campo de dados antes do primeiro "]")
  solicitacaoAcesso: string;   // pessoa apresentou cartão/digital/QR
  aguardandoGiro: string;      // catraca liberada, esperando girar
  giroConcluido: string;       // pessoa passou
  desistencia: string;         // tempo esgotou sem girar
  // Respostas que o SchoolPass envia
  liberarEntrada: string;
  liberarSaida: string;
  liberarAmbos: string;
  negar: string;
  liberacaoRemota: string;     // abrir sem leitura prévia (botão no painel / facial)
  // Sentido informado pela catraca no evento
  sentidoEntrada: string;
  sentidoSaida: string;
}

const padrao: CodigosHenry = {
  solicitacaoAcesso: '0',
  aguardandoGiro: '80',
  giroConcluido: '81',
  desistencia: '82',
  liberarEntrada: '6',
  liberarSaida: '5',
  liberarAmbos: '1',
  negar: '30',
  liberacaoRemota: '4',
  sentidoEntrada: '1',
  sentidoSaida: '2',
};

function carregar(): CodigosHenry {
  const extra = process.env.HENRY_CODIGOS;
  if (!extra) return padrao;
  try {
    return { ...padrao, ...JSON.parse(extra) };
  } catch {
    console.warn('[henry] HENRY_CODIGOS inválido, usando padrão');
    return padrao;
  }
}

export const codigos = carregar();
