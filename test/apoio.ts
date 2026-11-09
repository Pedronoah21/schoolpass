import { abrirBanco, type DB } from '../src/db/db.js';
import type { Agora } from '../src/tempo.js';

/** Banco em memória com uma turma (seg–sex), um aluno com cartão e responsável, e um funcionário. */
export function bancoDeTeste(): DB {
  return semear(abrirBanco(':memory:'));
}

export function semear(db: DB): DB {
  db.exec(`
    INSERT INTO turmas (id, nome, turno) VALUES (1, '6º Ano A', 'manhã');
    INSERT INTO horarios_turma (turma_id, dia_semana, entrada_inicio, entrada_fim, saida_inicio, saida_fim)
      VALUES (1,1,'06:30','07:30','11:30','12:30'), (1,2,'06:30','07:30','11:30','12:30'),
             (1,3,'06:30','07:30','11:30','12:30'), (1,4,'06:30','07:30','11:30','12:30'),
             (1,5,'06:30','07:30','11:30','12:30');
    INSERT INTO pessoas (id, nome, tipo, matricula, turma_id) VALUES (1, 'Ana Souza', 'aluno', '2026001', 1);
    INSERT INTO credenciais (pessoa_id, tipo, valor) VALUES (1, 'cartao', '12345'), (1, 'facial', 'face-ana');
    INSERT INTO responsaveis (pessoa_id, nome, telefone) VALUES (1, 'Maria Souza', '+5592999990000');
    INSERT INTO pessoas (id, nome, tipo, acesso_livre) VALUES (2, 'Carlos Lima', 'funcionario', 1);
    INSERT INTO credenciais (pessoa_id, tipo, valor) VALUES (2, 'cartao', '777');
  `);
  return db;
}

/** 2026-11-09 é uma segunda-feira. */
export function em(hora: string, data = '2026-11-09', diaSemana = 1): Agora {
  return { data, hora, diaSemana, completo: `${data} ${hora}:00` };
}
