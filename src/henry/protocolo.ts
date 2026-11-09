/**
 * Protocolo TCP das catracas Henry (família 7x/8x, usada também pela Lumen).
 *
 * Quadro: STX(0x02) | tamanho (2 bytes, little-endian) | corpo | checksum (1 byte) | ETX(0x03)
 *   - checksum = XOR de todos os bytes do tamanho + corpo
 *   - corpo    = "<índice>+<COMANDO>+<erro/versão>+<dados>"
 *   - dados    = campos separados por "]" (parâmetros) e "[" (subcampos)
 *
 * A catraca é o SERVIDOR (porta padrão 3000); o SchoolPass conecta como cliente.
 */

const STX = 0x02;
const ETX = 0x03;

export interface MensagemHenry {
  indice: string;     // 2 dígitos, ecoado na resposta
  comando: string;    // REON, RC, EC, EH, RR, ...
  status: string;     // código de erro/versão
  dados: string;      // restante após o terceiro '+'
}

export function checksum(bytes: Uint8Array): number {
  let cs = 0;
  for (const b of bytes) cs ^= b;
  return cs;
}

/** Monta o quadro binário de uma mensagem. */
export function montarQuadro(corpo: string): Buffer {
  const dados = Buffer.from(semAcentos(corpo), 'latin1');
  if (dados.length > 0xffff) throw new Error('mensagem grande demais');
  const tamanho = Buffer.alloc(2);
  tamanho.writeUInt16LE(dados.length);
  const cs = checksum(Buffer.concat([tamanho, dados]));
  return Buffer.concat([Buffer.from([STX]), tamanho, dados, Buffer.from([cs, ETX])]);
}

export function montarMensagem(m: MensagemHenry): Buffer {
  return montarQuadro(`${m.indice}+${m.comando}+${m.status}+${m.dados}`);
}

export function interpretarCorpo(corpo: string): MensagemHenry {
  const p = corpo.split('+');
  if (p.length < 3) throw new Error(`corpo inválido: ${corpo}`);
  return { indice: p[0], comando: p[1], status: p[2], dados: p.slice(3).join('+') };
}

/**
 * Acumula bytes vindos do socket e devolve as mensagens completas.
 * Descarta lixo antes do STX e quadros com checksum errado.
 */
export class LeitorQuadros {
  private buf = Buffer.alloc(0);
  descartados = 0;

  alimentar(pedaco: Buffer): MensagemHenry[] {
    this.buf = Buffer.concat([this.buf, pedaco]);
    const saida: MensagemHenry[] = [];
    for (;;) {
      const ini = this.buf.indexOf(STX);
      if (ini < 0) { this.buf = Buffer.alloc(0); break; }
      if (ini > 0) this.buf = this.buf.subarray(ini);
      if (this.buf.length < 3) break;
      const tam = this.buf.readUInt16LE(1);
      const total = 1 + 2 + tam + 1 + 1;
      if (this.buf.length < total) break;
      const quadro = this.buf.subarray(0, total);
      this.buf = this.buf.subarray(total);
      const csEsperado = checksum(quadro.subarray(1, 3 + tam));
      if (quadro[total - 1] !== ETX || quadro[total - 2] !== csEsperado) {
        this.descartados++;
        continue;
      }
      try {
        saida.push(interpretarCorpo(quadro.subarray(3, 3 + tam).toString('latin1')));
      } catch {
        this.descartados++;
      }
    }
    return saida;
  }
}

/** O display da catraca não mostra acentos de forma confiável. */
export function semAcentos(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
