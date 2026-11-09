import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/db.js';
import { config } from '../config.js';
import type { CentralCatracas } from '../acesso/central.js';
import { normalizarCredencial } from '../acesso/regras.js';
import { frequenciaDoDia, frequenciaDoPeriodo, paraCsv } from '../relatorios/frequencia.js';
import { acertarRelogio, enviarListaOffline, listaAutorizada, listaCsv, ProtocoloCadastroAusente } from '../henry/offline.js';
import { agoraNaEscola } from '../tempo.js';

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM');
const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD');
const id = z.coerce.number().int().positive();
const sentido = z.enum(['entrada', 'saida']);

const turmaSchema = z.object({ nome: z.string().min(1), turno: z.string().nullish(), ativa: z.boolean().default(true) });
const horarioSchema = z.object({
  dia_semana: z.number().int().min(0).max(6),
  entrada_inicio: hora, entrada_fim: hora, saida_inicio: hora, saida_fim: hora,
});
const pessoaSchema = z.object({
  nome: z.string().min(1),
  tipo: z.enum(['aluno', 'funcionario', 'visitante']),
  matricula: z.string().nullish(),
  turma_id: z.number().int().nullish(),
  ativo: z.boolean().default(true),
  acesso_livre: z.boolean().default(false),
  valido_ate: data.nullish(),
  foto_url: z.string().nullish(),
});
const credencialSchema = z.object({ tipo: z.enum(['cartao', 'biometria', 'qrcode', 'facial']), valor: z.string().min(1) });
const responsavelSchema = z.object({
  nome: z.string().min(1),
  telefone: z.string().regex(/^\+?\d{10,15}$/, 'telefone com DDD, ex: +5592999998888').nullish(),
  email: z.string().email().nullish(),
  notificar: z.boolean().default(true),
});
const catracaSchema = z.object({
  nome: z.string().min(1),
  ip: z.string().min(7),
  porta: z.number().int().min(1).max(65535).default(3000),
  modo: z.enum(['online', 'offline']).default('online'),
  sentido_invertido: z.boolean().default(false),
  ativa: z.boolean().default(true),
});

const b = (v: boolean | undefined | null) => (v ? 1 : 0);

export function registrarRotas(app: FastifyInstance, db: DB, central: CentralCatracas): void {
  // ---------------------------------------------------------------- autenticação
  app.addHook('onRequest', async (req, rep) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.url.startsWith('/api/facial/')) return; // usa chave própria
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? (req.query as Record<string, string>)?.token;
    if (token !== config.tokenAdmin) return rep.code(401).send({ erro: 'não autorizado' });
  });

  app.setErrorHandler((err, _req, rep) => {
    if (err instanceof z.ZodError) return rep.code(400).send({ erro: 'dados inválidos', detalhes: err.issues });
    const msg = (err as Error).message ?? String(err);
    if (/UNIQUE constraint/.test(msg)) return rep.code(409).send({ erro: 'registro duplicado', detalhes: msg });
    if (/FOREIGN KEY/.test(msg)) return rep.code(409).send({ erro: 'registro em uso ou referência inválida' });
    app.log.error(err);
    return rep.code(500).send({ erro: msg });
  });

  const naoAchou = (rep: FastifyReply) => rep.code(404).send({ erro: 'não encontrado' });
  const pid = (req: FastifyRequest) => id.parse((req.params as { id: string }).id);

  // ---------------------------------------------------------------- status
  app.get('/api/status', async () => ({
    agora: agoraNaEscola(),
    catracas: central.statusTodas(),
    pessoas: (db.prepare(`SELECT COUNT(*) n FROM pessoas WHERE ativo = 1`).get() as { n: number }).n,
    notificacoesPendentes: (db.prepare(`SELECT COUNT(*) n FROM notificacoes WHERE status = 'pendente'`).get() as { n: number }).n,
  }));

  // ---------------------------------------------------------------- turmas
  app.get('/api/turmas', async () =>
    db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM pessoas p WHERE p.turma_id = t.id AND p.ativo = 1) AS alunos
                  FROM turmas t ORDER BY t.nome`).all());

  app.post('/api/turmas', async (req, rep) => {
    const t = turmaSchema.parse(req.body);
    const r = db.prepare('INSERT INTO turmas (nome, turno, ativa) VALUES (?, ?, ?)').run(t.nome, t.turno ?? null, b(t.ativa));
    return rep.code(201).send({ id: Number(r.lastInsertRowid) });
  });

  app.put('/api/turmas/:id', async (req, rep) => {
    const t = turmaSchema.parse(req.body);
    const r = db.prepare('UPDATE turmas SET nome=?, turno=?, ativa=? WHERE id=?').run(t.nome, t.turno ?? null, b(t.ativa), pid(req));
    return r.changes ? { ok: true } : naoAchou(rep);
  });

  app.delete('/api/turmas/:id', async (req, rep) => {
    const r = db.prepare('DELETE FROM turmas WHERE id=?').run(pid(req));
    return r.changes ? { ok: true } : naoAchou(rep);
  });

  app.get('/api/turmas/:id/horarios', async (req) =>
    db.prepare('SELECT * FROM horarios_turma WHERE turma_id = ? ORDER BY dia_semana, entrada_inicio').all(pid(req)));

  /** Substitui todos os horários da turma. */
  app.put('/api/turmas/:id/horarios', async (req) => {
    const turmaId = pid(req);
    const lista = z.array(horarioSchema).parse(req.body);
    for (const h of lista) {
      if (h.entrada_inicio > h.entrada_fim || h.saida_inicio > h.saida_fim) {
        throw new z.ZodError([{ code: 'custom', path: ['horario'], message: 'início depois do fim', input: h }]);
      }
    }
    db.transaction(() => {
      db.prepare('DELETE FROM horarios_turma WHERE turma_id = ?').run(turmaId);
      const ins = db.prepare(`INSERT INTO horarios_turma (turma_id, dia_semana, entrada_inicio, entrada_fim, saida_inicio, saida_fim)
                              VALUES (?, ?, ?, ?, ?, ?)`);
      for (const h of lista) ins.run(turmaId, h.dia_semana, h.entrada_inicio, h.entrada_fim, h.saida_inicio, h.saida_fim);
    })();
    return { ok: true, total: lista.length };
  });

  // ---------------------------------------------------------------- pessoas
  app.get('/api/pessoas', async (req) => {
    const q = z.object({
      busca: z.string().optional(), tipo: z.string().optional(), turma: z.coerce.number().optional(),
      inativos: z.coerce.boolean().optional(),
    }).parse(req.query);
    return db.prepare(
      `SELECT p.*, t.nome AS turma_nome,
              (SELECT group_concat(c.tipo) FROM credenciais c WHERE c.pessoa_id = p.id AND c.ativa = 1) AS credenciais
         FROM pessoas p LEFT JOIN turmas t ON t.id = p.turma_id
        WHERE (? IS NULL OR p.nome LIKE ? OR p.matricula LIKE ?)
          AND (? IS NULL OR p.tipo = ?) AND (? IS NULL OR p.turma_id = ?)
          AND (? = 1 OR p.ativo = 1)
        ORDER BY p.nome LIMIT 500`,
    ).all(
      q.busca ?? null, `%${q.busca ?? ''}%`, `%${q.busca ?? ''}%`,
      q.tipo ?? null, q.tipo ?? null, q.turma ?? null, q.turma ?? null, q.inativos ? 1 : 0,
    );
  });

  app.get('/api/pessoas/:id', async (req, rep) => {
    const p = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(pid(req));
    if (!p) return naoAchou(rep);
    return {
      ...p,
      credenciais: db.prepare('SELECT * FROM credenciais WHERE pessoa_id = ? ORDER BY tipo').all(pid(req)),
      responsaveis: db.prepare('SELECT * FROM responsaveis WHERE pessoa_id = ? ORDER BY nome').all(pid(req)),
    };
  });

  app.post('/api/pessoas', async (req, rep) => {
    const p = pessoaSchema.parse(req.body);
    const r = db.prepare(
      `INSERT INTO pessoas (nome, tipo, matricula, turma_id, ativo, acesso_livre, valido_ate, foto_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.nome, p.tipo, p.matricula || null, p.turma_id ?? null, b(p.ativo), b(p.acesso_livre), p.valido_ate ?? null, p.foto_url ?? null);
    return rep.code(201).send({ id: Number(r.lastInsertRowid) });
  });

  app.put('/api/pessoas/:id', async (req, rep) => {
    const p = pessoaSchema.parse(req.body);
    const r = db.prepare(
      `UPDATE pessoas SET nome=?, tipo=?, matricula=?, turma_id=?, ativo=?, acesso_livre=?, valido_ate=?, foto_url=? WHERE id=?`,
    ).run(p.nome, p.tipo, p.matricula || null, p.turma_id ?? null, b(p.ativo), b(p.acesso_livre), p.valido_ate ?? null, p.foto_url ?? null, pid(req));
    return r.changes ? { ok: true } : naoAchou(rep);
  });

  /** Não apaga: desativa, para manter o histórico de passagens. */
  app.delete('/api/pessoas/:id', async (req, rep) => {
    const r = db.prepare('UPDATE pessoas SET ativo = 0 WHERE id = ?').run(pid(req));
    return r.changes ? { ok: true } : naoAchou(rep);
  });

  app.post('/api/pessoas/:id/credenciais', async (req, rep) => {
    const c = credencialSchema.parse(req.body);
    const r = db.prepare('INSERT INTO credenciais (pessoa_id, tipo, valor) VALUES (?, ?, ?)')
      .run(pid(req), c.tipo, normalizarCredencial(c.tipo, c.valor));
    return rep.code(201).send({ id: Number(r.lastInsertRowid) });
  });

  app.delete('/api/credenciais/:id', async (req, rep) => {
    const r = db.prepare('DELETE FROM credenciais WHERE id = ?').run(pid(req));
    return r.changes ? { ok: true } : naoAchou(rep);
  });

  app.post('/api/pessoas/:id/responsaveis', async (req, rep) => {
    const r0 = responsavelSchema.parse(req.body);
    const r = db.prepare('INSERT INTO responsaveis (pessoa_id, nome, telefone, email, notificar) VALUES (?, ?, ?, ?, ?)')
      .run(pid(req), r0.nome, r0.telefone ?? null, r0.email ?? null, b(r0.notificar));
    return rep.code(201).send({ id: Number(r.lastInsertRowid) });
  });

  app.delete('/api/responsaveis/:id', async (req, rep) => {
    const r = db.prepare('DELETE FROM responsaveis WHERE id = ?').run(pid(req));
    return r.changes ? { ok: true } : naoAchou(rep);
  });

  // ---------------------------------------------------------------- catracas
  app.get('/api/catracas', async () => central.statusTodas());

  app.post('/api/catracas', async (req, rep) => {
    const c = catracaSchema.parse(req.body);
    const r = db.prepare('INSERT INTO catracas (nome, ip, porta, modo, sentido_invertido, ativa) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.nome, c.ip, c.porta, c.modo, b(c.sentido_invertido), b(c.ativa));
    const novo = Number(r.lastInsertRowid);
    central.recarregar(novo);
    return rep.code(201).send({ id: novo });
  });

  app.put('/api/catracas/:id', async (req, rep) => {
    const c = catracaSchema.parse(req.body);
    const r = db.prepare('UPDATE catracas SET nome=?, ip=?, porta=?, modo=?, sentido_invertido=?, ativa=? WHERE id=?')
      .run(c.nome, c.ip, c.porta, c.modo, b(c.sentido_invertido), b(c.ativa), pid(req));
    if (!r.changes) return naoAchou(rep);
    central.recarregar(pid(req));
    return { ok: true };
  });

  app.delete('/api/catracas/:id', async (req, rep) => {
    const r = db.prepare('DELETE FROM catracas WHERE id = ?').run(pid(req));
    central.recarregar(pid(req));
    return r.changes ? { ok: true } : naoAchou(rep);
  });

  app.post('/api/catracas/:id/liberar', async (req, rep) => {
    const q = z.object({ sentido, pessoa_id: z.number().int().nullish(), motivo: z.string().min(1).default('liberação pelo painel') })
      .parse(req.body ?? {});
    const ok = central.liberarManual(pid(req), q.sentido, q.pessoa_id ?? null, q.motivo);
    return ok ? { ok: true } : rep.code(503).send({ erro: 'catraca desconectada' });
  });

  app.post('/api/catracas/:id/relogio', async (req, rep) => {
    const con = central.conexao(pid(req));
    return con && acertarRelogio(con) ? { ok: true } : rep.code(503).send({ erro: 'catraca desconectada' });
  });

  app.post('/api/catracas/:id/enviar-lista', async (req, rep) => {
    const con = central.conexao(pid(req));
    if (!con) return rep.code(503).send({ erro: 'catraca desconectada' });
    try {
      return { enviados: enviarListaOffline(con, listaAutorizada(db)) };
    } catch (e) {
      if (e instanceof ProtocoloCadastroAusente) return rep.code(501).send({ erro: e.message });
      throw e;
    }
  });

  // ---------------------------------------------------------------- lista offline
  app.get('/api/offline/lista.csv', async (_req, rep) =>
    rep.header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="lista-catraca.csv"')
      .send('﻿' + listaCsv(listaAutorizada(db))));

  // ---------------------------------------------------------------- eventos
  app.get('/api/eventos', async (req) => {
    const q = z.object({
      data: data.optional(), pessoa: z.coerce.number().optional(), catraca: z.coerce.number().optional(),
      resultado: z.string().optional(), limite: z.coerce.number().int().min(1).max(1000).default(200),
    }).parse(req.query);
    return db.prepare(
      `SELECT e.*, p.nome AS pessoa_nome, c.nome AS catraca_nome FROM eventos e
         LEFT JOIN pessoas p ON p.id = e.pessoa_id LEFT JOIN catracas c ON c.id = e.catraca_id
        WHERE (? IS NULL OR e.ocorrido_em BETWEEN ? AND ?)
          AND (? IS NULL OR e.pessoa_id = ?) AND (? IS NULL OR e.catraca_id = ?)
          AND (? IS NULL OR e.resultado = ?)
        ORDER BY e.ocorrido_em DESC, e.id DESC LIMIT ?`,
    ).all(
      q.data ?? null, `${q.data} 00:00:00`, `${q.data} 23:59:59`,
      q.pessoa ?? null, q.pessoa ?? null, q.catraca ?? null, q.catraca ?? null,
      q.resultado ?? null, q.resultado ?? null, q.limite,
    );
  });

  /** Eventos ao vivo para o painel (Server-Sent Events). */
  app.get('/api/eventos/ao-vivo', (req, rep) => {
    rep.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const enviar = (tipo: string) => (dados: unknown) => rep.raw.write(`event: ${tipo}\ndata: ${JSON.stringify(dados)}\n\n`);
    const ev = enviar('evento');
    const st = enviar('status');
    central.on('evento', ev);
    central.on('status', st);
    // ping visível ao navegador: o painel usa para mostrar se a conexão ao vivo está atualizada
    rep.raw.write(`event: ping\ndata: {}\n\n`);
    const ping = setInterval(() => rep.raw.write(`event: ping\ndata: {}\n\n`), 20_000);
    req.raw.on('close', () => { clearInterval(ping); central.off('evento', ev); central.off('status', st); });
  });

  // ---------------------------------------------------------------- dias sem aula
  app.get('/api/dias-sem-aula', async () => db.prepare('SELECT * FROM dias_sem_aula ORDER BY data').all());
  app.post('/api/dias-sem-aula', async (req, rep) => {
    const d = z.object({ data, descricao: z.string().nullish() }).parse(req.body);
    db.prepare('INSERT OR REPLACE INTO dias_sem_aula (data, descricao) VALUES (?, ?)').run(d.data, d.descricao ?? null);
    return rep.code(201).send({ ok: true });
  });
  app.delete('/api/dias-sem-aula/:data', async (req) => {
    db.prepare('DELETE FROM dias_sem_aula WHERE data = ?').run(data.parse((req.params as { data: string }).data));
    return { ok: true };
  });

  // ---------------------------------------------------------------- relatórios
  const enviarRelatorio = (rep: FastifyReply, linhas: object[], formato: string | undefined, nome: string) =>
    formato === 'csv'
      ? rep.header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="${nome}.csv"`).send('﻿' + paraCsv(linhas))
      : rep.send(linhas);

  app.get('/api/relatorios/dia', async (req, rep) => {
    const q = z.object({ data: data.optional(), turma: z.coerce.number().optional(), formato: z.string().optional() }).parse(req.query);
    const dia = q.data ?? agoraNaEscola().data;
    return enviarRelatorio(rep, frequenciaDoDia(db, dia, q.turma), q.formato, `frequencia-${dia}`);
  });

  app.get('/api/relatorios/periodo', async (req, rep) => {
    const q = z.object({ inicio: data, fim: data, turma: z.coerce.number().optional(), formato: z.string().optional() }).parse(req.query);
    return enviarRelatorio(rep, frequenciaDoPeriodo(db, q.inicio, q.fim, q.turma), q.formato, `frequencia-${q.inicio}-a-${q.fim}`);
  });

  app.get('/api/notificacoes', async () =>
    db.prepare(
      `SELECT n.*, r.nome AS responsavel, p.nome AS aluno, e.sentido, e.ocorrido_em FROM notificacoes n
         JOIN responsaveis r ON r.id = n.responsavel_id JOIN eventos e ON e.id = n.evento_id
         JOIN pessoas p ON p.id = e.pessoa_id ORDER BY n.id DESC LIMIT 100`,
    ).all());

  // ---------------------------------------------------------------- reconhecimento facial
  /**
   * Chamado pelo terminal facial (ou por um serviço que fale com ele) quando reconhece alguém.
   * Corpo: { catraca_id, id_facial, sentido? }   Cabeçalho: x-chave-facial: <FACIAL_CHAVE>
   */
  app.post('/api/facial/reconhecimento', async (req, rep) => {
    if (!config.facial.chave) return rep.code(503).send({ erro: 'reconhecimento facial não configurado (FACIAL_CHAVE)' });
    if (req.headers['x-chave-facial'] !== config.facial.chave) return rep.code(401).send({ erro: 'chave inválida' });
    const q = z.object({ catraca_id: z.number().int(), id_facial: z.string().min(1), sentido: sentido.nullish() }).parse(req.body);
    const d = central.reconhecimentoFacial(q.catraca_id, q.id_facial, q.sentido ?? null);
    return { liberado: d.liberado && d.enviado, motivo: d.motivo, nome: d.nome, catraca_conectada: d.enviado || !d.liberado };
  });
}
