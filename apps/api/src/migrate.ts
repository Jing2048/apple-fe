import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export async function migrate(sql: postgres.Sql): Promise<void> {
  const migrations = await Promise.all(
    ['001_initial', '002_event_ownership', '003_campaign_catalog'].map(async (name) => {
      const source = await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8');
      return { name, source, checksum: createHash('sha256').update(source).digest('hex') };
    }),
  );
  await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(714830210)`;
    await transaction`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    for (const migration of migrations) {
      const previous = await transaction<{ checksum: string }[]>`
        SELECT checksum FROM schema_migrations WHERE name = ${migration.name}
      `;
      if (previous[0]) {
        if (previous[0].checksum !== migration.checksum)
          throw new Error(`Applied migration checksum mismatch: ${migration.name}`);
        continue;
      }
      await transaction.unsafe(migration.source);
      await transaction`INSERT INTO schema_migrations (name, checksum) VALUES (${migration.name}, ${migration.checksum})`;
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for migrations');
  const sql = postgres(url, { max: 1 });
  try {
    await migrate(sql);
    console.info('Database migrations are current.');
  } finally {
    await sql.end();
  }
}
