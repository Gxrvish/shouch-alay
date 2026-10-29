import { attachDatabasePool } from '@vercel/functions';
import { Pool, type PoolClient } from 'pg';
import { required } from './config';

// One pool per server instance, kept on globalThis so dev hot reloads and route bundles share it.
const cache = globalThis as typeof globalThis & { looPool?: Pool };

export function db(): Pool {
  if (!cache.looPool) {
    // Neon URLs ask for channel_binding=require, which pg only honours through this flag. It uses
    // SCRAM-SHA-256-PLUS when the server offers it (Neon over TLS) and plain SCRAM otherwise.
    const pool = new Pool({ connectionString: required('DATABASE_URL'), enableChannelBinding: true });
    // Idle clients can be dropped by the server (Neon scales to zero); log instead of crashing.
    pool.on('error', (err) => console.error('Idle database client error:', err.message));
    // On Vercel Fluid compute, keeps the instance alive until idle connections close cleanly.
    attachDatabasePool(pool);
    cache.looPool = pool;
  }
  return cache.looPool;
}

export async function inTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await db().connect();
  let broken = false;
  try {
    await tx.query('BEGIN');
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    tx.release(broken); // a connection that cannot roll back is discarded, not reused
  }
}

/** The name of the unique constraint `err` violated, if it is a unique violation. */
export function uniqueViolation(err: unknown): string | undefined {
  const { code, constraint } = err as { code?: string; constraint?: string };
  return code === '23505' ? constraint : undefined;
}
