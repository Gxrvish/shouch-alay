import { db } from '@/lib/db';

// The office's four toilets. Placeholder names: admins can rename them under "Manage toilets".
const TOILETS = ['Floor 1 / Toilet A', 'Floor 1 / Toilet B', 'Floor 1 / Toilet C', 'Floor 1 / Toilet D'];

try {
  process.loadEnvFile('.env.local');
} catch {
  // No .env.local: use the real environment.
}
const { rowCount } = await db().query('INSERT INTO toilets (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING', [TOILETS]);
console.log(`Added ${rowCount ?? 0} toilet(s)`);
await db().end();
