-- SchoolPass: esquema do banco (SQLite)
PRAGMA foreign_keys = ON;

-- Turmas e seus horários de acesso
CREATE TABLE IF NOT EXISTS turmas (
  id        INTEGER PRIMARY KEY,
  nome      TEXT NOT NULL UNIQUE,
  turno     TEXT,                       -- manhã, tarde, integral...
  ativa     INTEGER NOT NULL DEFAULT 1
);

-- Janela de acesso por dia da semana (0 = domingo ... 6 = sábado)
CREATE TABLE IF NOT EXISTS horarios_turma (
  id             INTEGER PRIMARY KEY,
  turma_id       INTEGER NOT NULL REFERENCES turmas(id) ON DELETE CASCADE,
  dia_semana     INTEGER NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  entrada_inicio TEXT NOT NULL,         -- 'HH:MM' a partir de quando pode entrar
  entrada_fim    TEXT NOT NULL,         -- 'HH:MM' limite de entrada
  saida_inicio   TEXT NOT NULL,         -- 'HH:MM' a partir de quando pode sair sozinho
  saida_fim      TEXT NOT NULL          -- 'HH:MM' limite de saída
);
CREATE INDEX IF NOT EXISTS ix_horarios_turma ON horarios_turma(turma_id, dia_semana);

-- Pessoas: alunos, funcionários e visitantes
CREATE TABLE IF NOT EXISTS pessoas (
  id          INTEGER PRIMARY KEY,
  nome        TEXT NOT NULL,
  tipo        TEXT NOT NULL CHECK (tipo IN ('aluno','funcionario','visitante')),
  matricula   TEXT UNIQUE,
  turma_id    INTEGER REFERENCES turmas(id) ON DELETE SET NULL,
  ativo       INTEGER NOT NULL DEFAULT 1,
  -- Funcionários e visitantes podem ter acesso livre ou validade
  acesso_livre INTEGER NOT NULL DEFAULT 0,
  valido_ate  TEXT,                     -- ISO date; NULL = sem validade
  foto_url    TEXT,
  criado_em   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Responsáveis que recebem aviso de entrada/saída
CREATE TABLE IF NOT EXISTS responsaveis (
  id          INTEGER PRIMARY KEY,
  pessoa_id   INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  nome        TEXT NOT NULL,
  telefone    TEXT,                     -- formato E.164, ex: +5592999998888
  email       TEXT,
  notificar   INTEGER NOT NULL DEFAULT 1
);

-- Credenciais: uma pessoa pode ter cartão, digital, QR e facial ao mesmo tempo
CREATE TABLE IF NOT EXISTS credenciais (
  id        INTEGER PRIMARY KEY,
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  tipo      TEXT NOT NULL CHECK (tipo IN ('cartao','biometria','qrcode','facial')),
  valor     TEXT NOT NULL,              -- nº do cartão, id da digital na catraca, conteúdo do QR, id facial
  ativa     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tipo, valor)
);

-- Catracas cadastradas
CREATE TABLE IF NOT EXISTS catracas (
  id          INTEGER PRIMARY KEY,
  nome        TEXT NOT NULL,
  ip          TEXT NOT NULL,
  porta       INTEGER NOT NULL DEFAULT 3000,
  modo        TEXT NOT NULL DEFAULT 'online' CHECK (modo IN ('online','offline')),
  -- sentido físico: 'entrada' = giro horário é entrada (inverte se a catraca for montada ao contrário)
  sentido_invertido INTEGER NOT NULL DEFAULT 0,
  ativa       INTEGER NOT NULL DEFAULT 1,
  ultima_sincronizacao TEXT
);

-- Registro de cada tentativa e passagem
CREATE TABLE IF NOT EXISTS eventos (
  id          INTEGER PRIMARY KEY,
  catraca_id  INTEGER REFERENCES catracas(id) ON DELETE SET NULL,
  pessoa_id   INTEGER REFERENCES pessoas(id) ON DELETE SET NULL,
  credencial_tipo  TEXT,
  credencial_valor TEXT,
  sentido     TEXT CHECK (sentido IN ('entrada','saida')),
  resultado   TEXT NOT NULL CHECK (resultado IN ('liberado','negado','passou','desistiu','manual')),
  motivo      TEXT,
  origem      TEXT NOT NULL DEFAULT 'online' CHECK (origem IN ('online','offline','manual','facial')),
  ocorrido_em TEXT NOT NULL,            -- horário local 'YYYY-MM-DD HH:MM:SS'
  notificado  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_eventos_data ON eventos(ocorrido_em);
CREATE INDEX IF NOT EXISTS ix_eventos_pessoa ON eventos(pessoa_id, ocorrido_em);
-- evita duplicar registros coletados da memória da catraca (modo offline)
CREATE UNIQUE INDEX IF NOT EXISTS ux_eventos_offline
  ON eventos(catraca_id, credencial_valor, ocorrido_em, sentido) WHERE origem = 'offline';

-- Fila de notificações (envio com nova tentativa)
CREATE TABLE IF NOT EXISTS notificacoes (
  id           INTEGER PRIMARY KEY,
  evento_id    INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
  responsavel_id INTEGER NOT NULL REFERENCES responsaveis(id) ON DELETE CASCADE,
  canal        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviada','falhou')),
  tentativas   INTEGER NOT NULL DEFAULT 0,
  erro         TEXT,
  criado_em    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Feriados / dias sem aula (bloqueia alunos, mantém funcionários)
CREATE TABLE IF NOT EXISTS dias_sem_aula (
  data      TEXT PRIMARY KEY,           -- 'YYYY-MM-DD'
  descricao TEXT
);
