import { readFile, readdir } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
import { applyMigration } from '../lib/editorial/migrate.mjs';

const connection = process.env.DATABASE_URL_UNPOOLED;
if (!connection) throw new Error('DATABASE_URL_UNPOOLED mangler. Bruk direkte forbindelse til valgt testdatabase først.');
if (new URL(connection).hostname.includes('-pooler')) throw new Error('Migrasjoner krever direkte databaseforbindelse.');
const sql = neon(connection);
const directory = new URL('../migrations/', import.meta.url);
for (const name of (await readdir(directory)).filter(x => x.endsWith('.sql')).sort()) {
  const contents = await readFile(new URL(name, directory), 'utf8');
  await applyMigration(sql, name, contents);
  console.log(`Verified migration ${name}`);
}
