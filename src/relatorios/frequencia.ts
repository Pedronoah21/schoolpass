import type { DB } from '../db/db.js';

export interface LinhaDia {
  pessoa_id: number; nome: string; matricula: string | null; turma: string | null;
  entrada: string | null; saida: string | null; presente: boolean;
}

/** Quem entrou e saiu em um dia. Presença = ao menos uma entrada (ou saída) registrada. */
export function frequenciaDoDia(db: DB, data: string, turmaId?: number): LinhaDia[] {
  const linhas = db.prepare(
    `SELECT p.id AS pessoa_id, p.nome, p.matricula, t.nome AS turma,
            MIN(CASE WHEN e.sentido = 'entrada' THEN substr(e.ocorrido_em, 12, 5) END) AS entrada,
            MAX(CASE WHEN e.sentido = 'saida'   THEN substr(e.ocorrido_em, 12, 5) END) AS saida,
            COUNT(e.id) AS passagens
       FROM pessoas p
       LEFT JOIN turmas t ON t.id = p.turma_id
       LEFT JOIN eventos e ON e.pessoa_id = p.id AND e.resultado IN ('passou','manual')
                          AND e.ocorrido_em BETWEEN ? AND ?
      WHERE p.tipo = 'aluno' AND p.ativo = 1 AND (? IS NULL OR p.turma_id = ?)
      GROUP BY p.id ORDER BY t.nome, p.nome`,
  ).all(`${data} 00:00:00`, `${data} 23:59:59`, turmaId ?? null, turmaId ?? null) as Array<
    Omit<LinhaDia, 'presente'> & { passagens: number }
  >;
  return linhas.map(({ passagens, ...l }) => ({ ...l, presente: passagens > 0 }));
}

export interface LinhaPeriodo {
  pessoa_id: number; nome: string; matricula: string | null; turma: string | null;
  dias_letivos: number; dias_presente: number; percentual: number;
}

function* diasEntre(inicio: string, fim: string): Generator<{ data: string; diaSemana: number }> {
  const d = new Date(`${inicio}T12:00:00Z`);
  const f = new Date(`${fim}T12:00:00Z`);
  while (d <= f) {
    yield { data: d.toISOString().slice(0, 10), diaSemana: d.getUTCDay() };
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

/** Frequência por aluno em um período: dias letivos da turma x dias com passagem. */
export function frequenciaDoPeriodo(db: DB, inicio: string, fim: string, turmaId?: number): LinhaPeriodo[] {
  const semAula = new Set(
    (db.prepare('SELECT data FROM dias_sem_aula WHERE data BETWEEN ? AND ?').all(inicio, fim) as { data: string }[])
      .map((r) => r.data),
  );
  const diasPorTurma = new Map<number, Set<number>>();
  for (const h of db.prepare('SELECT DISTINCT turma_id, dia_semana FROM horarios_turma').all() as
    { turma_id: number; dia_semana: number }[]) {
    if (!diasPorTurma.has(h.turma_id)) diasPorTurma.set(h.turma_id, new Set());
    diasPorTurma.get(h.turma_id)!.add(h.dia_semana);
  }
  const letivos = new Map<number, number>();
  for (const [turma, dias] of diasPorTurma) {
    let n = 0;
    for (const d of diasEntre(inicio, fim)) if (dias.has(d.diaSemana) && !semAula.has(d.data)) n++;
    letivos.set(turma, n);
  }

  const alunos = db.prepare(
    `SELECT p.id AS pessoa_id, p.nome, p.matricula, p.turma_id, t.nome AS turma,
            COUNT(DISTINCT substr(e.ocorrido_em, 1, 10)) AS dias_presente
       FROM pessoas p
       LEFT JOIN turmas t ON t.id = p.turma_id
       LEFT JOIN eventos e ON e.pessoa_id = p.id AND e.resultado IN ('passou','manual')
                          AND e.ocorrido_em BETWEEN ? AND ?
      WHERE p.tipo = 'aluno' AND p.ativo = 1 AND (? IS NULL OR p.turma_id = ?)
      GROUP BY p.id ORDER BY t.nome, p.nome`,
  ).all(`${inicio} 00:00:00`, `${fim} 23:59:59`, turmaId ?? null, turmaId ?? null) as Array<{
    pessoa_id: number; nome: string; matricula: string | null; turma_id: number | null; turma: string | null; dias_presente: number;
  }>;

  return alunos.map(({ turma_id, ...a }) => {
    const dias_letivos = turma_id ? letivos.get(turma_id) ?? 0 : 0;
    const presentes = Math.min(a.dias_presente, dias_letivos || a.dias_presente);
    return {
      ...a, dias_presente: presentes, dias_letivos,
      percentual: dias_letivos ? Math.round((presentes / dias_letivos) * 1000) / 10 : 0,
    };
  });
}

export function paraCsv(linhas: object[]): string {
  if (linhas.length === 0) return '';
  const cols = Object.keys(linhas[0]);
  const esc = (v: unknown) => {
    const s = v == null ? '' : typeof v === 'boolean' ? (v ? 'sim' : 'nao') : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(';'), ...linhas.map((l) => cols.map((c) => esc((l as Record<string, unknown>)[c])).join(';'))].join('\n') + '\n';
}
