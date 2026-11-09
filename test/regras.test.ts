import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidirAcesso } from '../src/acesso/regras.js';
import { bancoDeTeste, em } from './apoio.js';

const TODOS = ['cartao', 'biometria', 'qrcode'] as const;

test('aluno entra dentro do horário da turma', () => {
  const d = decidirAcesso(bancoDeTeste(), [...TODOS], '12345', 'entrada', em('07:00'));
  assert.equal(d.liberado, true);
  assert.equal(d.mensagem, 'BEM-VINDO ANA');
});

test('cartão com zeros à esquerda bate com o cadastro', () => {
  const d = decidirAcesso(bancoDeTeste(), [...TODOS], '0000012345', 'entrada', em('07:00'));
  assert.equal(d.liberado, true);
});

test('aluno não entra fora do horário nem sai antes da hora', () => {
  const db = bancoDeTeste();
  assert.equal(decidirAcesso(db, [...TODOS], '12345', 'entrada', em('08:15')).motivo, 'fora do horario de entrada');
  assert.equal(decidirAcesso(db, [...TODOS], '12345', 'saida', em('10:00')).motivo, 'fora do horario de saida');
  assert.equal(decidirAcesso(db, [...TODOS], '12345', 'saida', em('11:45')).liberado, true);
});

test('sábado sem horário e feriado bloqueiam aluno, mas não funcionário', () => {
  const db = bancoDeTeste();
  assert.equal(decidirAcesso(db, [...TODOS], '12345', 'entrada', em('07:00', '2026-11-14', 6)).liberado, false);
  db.exec(`INSERT INTO dias_sem_aula (data, descricao) VALUES ('2026-11-09', 'Feriado')`);
  assert.equal(decidirAcesso(db, [...TODOS], '12345', 'entrada', em('07:00')).motivo, 'dia sem aula');
  assert.equal(decidirAcesso(db, [...TODOS], '777', 'entrada', em('07:00')).liberado, true);
});

test('cartão desconhecido, pessoa inativa e cadastro vencido são negados', () => {
  const db = bancoDeTeste();
  assert.equal(decidirAcesso(db, [...TODOS], '999', 'entrada', em('07:00')).mensagem, 'NAO CADASTRADO');
  db.exec(`UPDATE pessoas SET valido_ate = '2026-11-01' WHERE id = 2`);
  assert.equal(decidirAcesso(db, [...TODOS], '777', 'entrada', em('07:00')).motivo, 'cadastro vencido');
  db.exec(`UPDATE pessoas SET ativo = 0 WHERE id = 1`);
  assert.equal(decidirAcesso(db, [...TODOS], '12345', 'entrada', em('07:00')).motivo, 'cadastro inativo');
});

test('sem sentido informado, alterna entre entrada e saída', () => {
  const db = bancoDeTeste();
  assert.equal(decidirAcesso(db, [...TODOS], '12345', null, em('07:00')).sentido, 'entrada');
  db.exec(`INSERT INTO eventos (pessoa_id, sentido, resultado, ocorrido_em) VALUES (1, 'entrada', 'passou', '2026-11-09 07:01:00')`);
  const d = decidirAcesso(db, [...TODOS], '12345', null, em('11:40'));
  assert.equal(d.sentido, 'saida');
  assert.equal(d.liberado, true);
});

test('facial usa a mesma regra de horário', () => {
  const db = bancoDeTeste();
  assert.equal(decidirAcesso(db, 'facial', 'face-ana', 'entrada', em('07:00')).liberado, true);
  assert.equal(decidirAcesso(db, 'facial', 'face-ana', 'entrada', em('09:00')).liberado, false);
});
