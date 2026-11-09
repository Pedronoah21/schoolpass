import { criarApp } from './app.js';
import { config } from './config.js';

if (config.tokenAdmin === 'troque-este-token') {
  console.warn('[schoolpass] ATENÇÃO: defina ADMIN_TOKEN no .env antes de usar na escola.');
}

const { app } = await criarApp();
await app.listen({ port: config.porta, host: config.host });

for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sinal, async () => {
    await app.close();
    process.exit(0);
  });
}
