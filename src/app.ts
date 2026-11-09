import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { abrirBanco, type DB } from './db/db.js';
import { CentralCatracas } from './acesso/central.js';
import { canalConfigurado, Notificador, type CanalAviso } from './notificacao/notificador.js';
import { registrarRotas } from './api/rotas.js';
import { acertarRelogio } from './henry/offline.js';
import { config } from './config.js';
import type { Agora } from './tempo.js';

export interface Opcoes {
  arquivoBanco?: string;
  canal?: CanalAviso;
  relogio?: () => Agora;
  log?: boolean;
}

export async function criarApp(op: Opcoes = {}) {
  const db: DB = abrirBanco(op.arquivoBanco ?? config.bancoArquivo);
  const notificador = new Notificador(db, op.canal ?? canalConfigurado());
  const central = new CentralCatracas(db, notificador, op.relogio);

  const app = Fastify({ logger: op.log ?? true });
  const publico = resolve(process.cwd(), 'public');
  if (existsSync(join(publico, 'index.html'))) {
    await app.register(fastifyStatic, { root: publico });
  }
  registrarRotas(app, db, central);

  let timerRelogio: NodeJS.Timeout | null = null;
  app.addHook('onReady', async () => {
    central.iniciar();
    notificador.iniciar();
    // Acerta o relógio das catracas ao conectar e periodicamente (importante para o modo offline)
    central.on('status', (s: { catracaId: number; conectada: boolean }) => {
      if (s.conectada) { const c = central.conexao(s.catracaId); if (c) acertarRelogio(c); }
    });
    timerRelogio = setInterval(() => {
      for (const c of central.statusTodas()) {
        const con = central.conexao(c.id);
        if (con?.status.conectada) acertarRelogio(con);
      }
    }, config.henry.sincronizacaoMin * 60_000);
  });
  app.addHook('onClose', async () => {
    if (timerRelogio) clearInterval(timerRelogio);
    central.parar();
    notificador.parar();
    db.close();
  });

  return { app, db, central, notificador };
}
