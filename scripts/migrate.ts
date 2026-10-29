import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { db, inTransaction } from '@/lib/db';

const DIR = new URL('../migrations/', import.meta.url);

/** Applies migrations/*.sql in name order, each exactly once and in its own transaction. */
export async function migrate(): Promise<string[]> {
  await db().query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const { rows } = await db().query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const pending = (await readdir(DIR)).filter((f) => f.endsWith('.sql') && !applied.has(f)).sort();
  for (const file of pending) {
    const sql = await readFile(new URL(file, DIR), 'utf8');
    await inTransaction(async (tx) => {
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
  }
  return pending;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // No .env.local: use the real environment.
  }
  const applied = await migrate();
  console.log(applied.length ? `Applied ${applied.join(', ')}` : 'Database is up to date');
  await db().end();
}
