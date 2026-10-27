import postgres from 'postgres';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PostgresStore } from './store/postgres.js';

const config = loadConfig();
const sql = postgres(config.databaseUrl, {
  max: 10,
  connect_timeout: 5,
  idle_timeout: 20,
  connection: {
    application_name: 'apple-lab-api',
    statement_timeout: 5000,
    lock_timeout: 3000,
    idle_in_transaction_session_timeout: 5000,
  },
});
const app = await buildApp({ store: new PostgresStore(sql), config });

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
}
process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});
try {
  await app.listen({ host: config.host, port: config.port });
} catch {
  app.log.error('API failed to listen. Check host/port configuration.');
  await app.close();
  process.exitCode = 1;
}
