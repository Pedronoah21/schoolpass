import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { SimuladorLumen } from '../src/sim/simulador-lumen.js';
import { semear, em } from './apoio.js';
import type { Aviso } from '../src/notificacao/notificador.js';

process.env.FACIAL_CHAVE = 'chave-teste';
process.env.ADMIN_TOKEN = 'token-teste';
process.env.HENRY_RECONEXAO_MS = '100';
const { criarApp } = await import('../src/app.js');

const avisos: Aviso[] = [];
const sim = new SimuladorLumen();
let ctx: Awaited<ReturnType<typeof criarApp>>;
let hora = '07:00';
const auth = { authorization: 'Bearer token-teste' };

const esperar = async (cond: () => boolean, ms = 3000) => {
  const fim = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fim) throw new Error('tempo esgotado esperando condição');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const eventos = () => ctx.db.prepare('SELECT * FROM eventos ORDER BY id').all() as Array<Record<string, unknown>>;

before(async () => {
  const porta = await sim.escutar(0);
  ctx = await criarApp({
    arquivoBanco: ':memory:', log: false, relogio: () => em(hora),
    canal: { nome: 'teste', enviar: async (a) => { avisos.push(a); } },
  });
  semear(ctx.db);
  ctx.db.prepare(`INSERT INTO catracas (id, nome, ip, porta) VALUES (1, 'Portaria', '127.0.0.1', ?)`).run(porta);
  const conectou = once(sim, 'conectou');
  await ctx.app.ready();
  await conectou;
  await esperar(() => ctx.central.conexao(1)?.status.conectada === true);
});

after(async () => {
  await ctx.app.close();
  await sim.fechar();
});

test('modo online: libera, confirma o giro e avisa a responsável', async () => {
  const display = once(sim, 'display');
  sim.apresentar('12345', 'e');
  const [d] = await display;
  assert.equal(d.liberou, true);
  assert.equal(d.texto, 'BEM-VINDO ANA');
  await esperar(() => eventos().some((e) => e.resultado === 'passou'));
  await esperar(() => avisos.length === 1);
  assert.equal(eventos().length, 1, 'a tentativa deve virar uma única linha (liberado → passou)');
  assert.equal(avisos[0].nomeAluno, 'Ana Souza');
  assert.equal(avisos[0].sentido, 'entrada');
});

test('modo online: nega fora do horário e registra o motivo', async () => {
  hora = '09:00';
  const display = once(sim, 'display');
  sim.apresentar('12345', 'e');
  const [d] = await display;
  assert.equal(d.liberou, false);
  await esperar(() => eventos().some((e) => e.motivo === 'fora do horario de entrada'));
  hora = '07:00';
});

test('desistência não conta como passagem nem gera aviso', async () => {
  const antes = avisos.length;
  sim.desistirProxima = true;
  sim.apresentar('777', 'e');
  await esperar(() => eventos().some((e) => e.resultado === 'desistiu'));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(avisos.length, antes);
});

test('registro offline vindo da memória da catraca é importado uma única vez', async () => {
  const quando = new Date(2026, 10, 9, 6, 40, 0);
  sim.registroOffline('12345', 'e', quando);
  sim.registroOffline('12345', 'e', quando);
  await esperar(() => eventos().some((e) => e.origem === 'offline'));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(eventos().filter((e) => e.origem === 'offline').length, 1);
});

test('liberação manual pelo painel', async () => {
  const r = await ctx.app.inject({
    method: 'POST', url: '/api/catracas/1/liberar', headers: auth,
    payload: { sentido: 'saida', pessoa_id: 1, motivo: 'saída antecipada autorizada pela mãe' },
  });
  assert.equal(r.statusCode, 200);
  await esperar(() => eventos().some((e) => e.resultado === 'manual'));
  assert.equal(eventos().find((e) => e.resultado === 'manual')?.sentido, 'saida');
});

test('reconhecimento facial libera a catraca', async () => {
  const display = once(sim, 'display');
  const r = await ctx.app.inject({
    method: 'POST', url: '/api/facial/reconhecimento', headers: { 'x-chave-facial': 'chave-teste' },
    payload: { catraca_id: 1, id_facial: 'face-ana', sentido: 'entrada' },
  });
  assert.equal(r.json().liberado, true);
  const [d] = await display;
  assert.equal(d.liberou, true);
  await esperar(() => eventos().some((e) => e.origem === 'facial' && e.resultado === 'passou'));
});

test('API exige token e relatório do dia mostra presença', async () => {
  assert.equal((await ctx.app.inject({ url: '/api/pessoas' })).statusCode, 401);
  const r = await ctx.app.inject({ url: '/api/relatorios/dia?data=2026-11-09', headers: auth });
  const ana = r.json().find((l: { nome: string }) => l.nome === 'Ana Souza');
  assert.equal(ana.presente, true);
  assert.equal(ana.entrada, '06:40');
});

test('lista offline em CSV traz as credenciais ativas', async () => {
  const r = await ctx.app.inject({ url: '/api/offline/lista.csv', headers: auth });
  assert.match(r.body, /12345;Ana Souza;2026001;cartao/);
  assert.doesNotMatch(r.body, /face-ana/);
});
