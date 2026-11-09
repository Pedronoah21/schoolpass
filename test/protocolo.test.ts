import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LeitorQuadros, montarQuadro, checksum, interpretarCorpo } from '../src/henry/protocolo.js';

test('monta quadro com STX, tamanho LE, checksum XOR e ETX', () => {
  const q = montarQuadro('01+REON+00+6]5]OLA]2');
  assert.equal(q[0], 0x02);
  assert.equal(q.readUInt16LE(1), 20);
  assert.equal(q[q.length - 1], 0x03);
  assert.equal(q[q.length - 2], checksum(q.subarray(1, q.length - 2)));
});

test('remove acentos do texto do display', () => {
  const q = montarQuadro('01+REON+00+6]5]Até logo João]2');
  assert.match(q.toString('latin1'), /Ate logo Joao/);
});

test('leitor junta pedaços, ignora lixo e quadros corrompidos', () => {
  const a = montarQuadro('01+REON+000+0]123]09/11/2026 07:00:00]1]0]');
  const b = montarQuadro('02+REON+000+81]123]09/11/2026 07:00:02]1]0]');
  const ruim = Buffer.from(montarQuadro('03+REON+000+0]999'));
  ruim[ruim.length - 2] ^= 0xff; // checksum errado
  const fluxo = Buffer.concat([Buffer.from([0x41, 0x42]), a, ruim, b]);
  const leitor = new LeitorQuadros();
  const msgs = [...leitor.alimentar(fluxo.subarray(0, 10)), ...leitor.alimentar(fluxo.subarray(10))];
  assert.deepEqual(msgs.map((m) => m.indice), ['01', '02']);
  assert.equal(msgs[1].dados.split(']')[0], '81');
  assert.equal(leitor.descartados, 1);
});

test('interpreta corpo mantendo + dentro dos dados', () => {
  const m = interpretarCorpo('05+REON+00+6]5]A+B]2');
  assert.equal(m.comando, 'REON');
  assert.equal(m.dados, '6]5]A+B]2');
});
