import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyMigration } from '../lib/editorial/migrate.mjs';
import { database, application, root } from './helpers/runtime.mjs';

test('Explicit migration is atomic, repeatable, detects changed files and preserves articles', async () => {
  const db=await database();
  try {
    const app=application(db.sql);
    const writer=await app.load('lib/ai/write-article.js');
    const selection=await app.load('lib/autopilot/editorial-selection.js');
    await writer.ensureArticleWriterSchema(db.sql);await selection.ensureEditorialSelectionSchema(db.sql);
    await db.sql`INSERT INTO articles(slug,tittel,brodtekst,status) VALUES('permanent-url','Eksisterende artikkel','Beholdes','live')`;
    const contents=await readFile(`${root}/migrations/001_editorial_cases.sql`,'utf8');
    await Promise.all([applyMigration(db.sql,'001_editorial_cases.sql',contents),applyMigration(db.sql,'001_editorial_cases.sql',contents)]);
    assert.equal((await db.sql`SELECT count(*)::int AS n FROM kapitalstrom_migrations`)[0].n,1);
    assert.equal((await db.sql`SELECT slug FROM articles`)[0].slug,'permanent-url');
    await assert.rejects(applyMigration(db.sql,'001_editorial_cases.sql',`${contents}\n-- changed`),/MIGRATION_CHECKSUM_CHANGED/);
    await assert.rejects(applyMigration(db.sql,'002_failure.sql',"ALTER TABLE articles ADD COLUMN should_roll_back TEXT;\n-- statement-breakpoint\nSELECT 1/0;"),/division by zero/);
    assert.equal((await db.sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='articles' AND column_name='should_roll_back'`)[0].n,0);
    assert.equal((await db.sql`SELECT count(*)::int AS n FROM kapitalstrom_migrations`)[0].n,1);
  } finally { await db.pg.close(); }
});
