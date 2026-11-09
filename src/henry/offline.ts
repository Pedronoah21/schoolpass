/**
 * Suporte ao modo offline da Lumen.
 *
 * No modo offline a catraca decide sozinha com a lista gravada na memória dela.
 * O SchoolPass:
 *   1. gera a lista de quem pode passar (CSV para importar no software da Henry);
 *   2. acerta o relógio da catraca (comando EH);
 *   3. importa as passagens que a catraca envia ao reconectar (ver CentralCatracas.importarOffline).
 *
 * O envio direto da lista pela rede (comandos de cadastro de cartões/usuários) depende do
 * manual de protocolo da Lumen, que a Henry fornece a integradores. Quando você tiver o
 * manual, implemente `montarComandosCadastro` e o restante já está ligado.
 */
import type { DB } from '../db/db.js';
import type { ConexaoHenry } from './conexao.js';
import { agoraNaEscola, paraHenry } from '../tempo.js';

export interface ItemListaOffline {
  pessoaId: number;
  nome: string;
  matricula: string | null;
  tipo: 'cartao' | 'biometria' | 'qrcode';
  credencial: string;
  validoAte: string | null;
  turma: string | null;
}

export function listaAutorizada(db: DB, hoje = agoraNaEscola().data): ItemListaOffline[] {
  return db.prepare(
    `SELECT p.id AS pessoaId, p.nome, p.matricula, c.tipo, c.valor AS credencial,
            p.valido_ate AS validoAte, t.nome AS turma
       FROM pessoas p
       JOIN credenciais c ON c.pessoa_id = p.id AND c.ativa = 1 AND c.tipo IN ('cartao','biometria','qrcode')
       LEFT JOIN turmas t ON t.id = p.turma_id
      WHERE p.ativo = 1 AND (p.valido_ate IS NULL OR p.valido_ate >= ?)
      ORDER BY p.nome`,
  ).all(hoje) as ItemListaOffline[];
}

export function listaCsv(itens: ItemListaOffline[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const linhas = itens.map((i) =>
    [i.credencial, i.nome, i.matricula, i.tipo, i.turma, i.validoAte].map(esc).join(';'));
  return ['credencial;nome;matricula;tipo;turma;valido_ate', ...linhas].join('\n') + '\n';
}

/** Acerta data e hora da catraca com o horário da escola. */
export function acertarRelogio(con: ConexaoHenry): boolean {
  return con.enviar({
    indice: con.novoIndice(), comando: 'EH', status: '00',
    dados: `${paraHenry(agoraNaEscola().completo)}]00/00/00]00/00/00`,
  });
}

export class ProtocoloCadastroAusente extends Error {
  constructor() {
    super('Envio da lista pela rede ainda não configurado: falta o manual de protocolo de cadastro da Lumen. Use a exportação CSV.');
  }
}

/** Implementar com o manual de protocolo da Henry (comandos de inclusão de cartões/usuários). */
export function montarComandosCadastro(_itens: ItemListaOffline[]): string[] {
  throw new ProtocoloCadastroAusente();
}

export function enviarListaOffline(con: ConexaoHenry, itens: ItemListaOffline[]): number {
  const comandos = montarComandosCadastro(itens);
  let enviados = 0;
  for (const dados of comandos) {
    const [comando, ...resto] = dados.split('+');
    if (con.enviar({ indice: con.novoIndice(), comando, status: '00', dados: resto.join('+') })) enviados++;
  }
  return enviados;
}
