import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
import { applyMigration } from '../lib/editorial/migrate.mjs';
import { publishFlash } from '../lib/breaking/store.mjs';

// Same isolation rules as earlier rollouts: known test endpoint, never production.
const test = new URL(process.env.EDITORIAL_TEST_DATABASE_URL_UNPOOLED), production = new URL(process.env.EDITORIAL_PRODUCTION_DATABASE_URL_UNPOOLED);
const host = u => u.hostname.replace('-pooler.', '.');
const name = '004_newsroom_desk.sql', contents = await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8');
const checksum = createHash('sha256').update(contents).digest('hex');
const state = sql => sql`SELECT (SELECT row_to_json(s) FROM (SELECT automation_enabled,auto_publish_enabled,live_publish_enabled,breaking_publish_enabled FROM editorial_settings WHERE id=1) s) AS settings,
  (SELECT count(*)::int FROM articles) AS articles, (SELECT count(*)::int FROM articles WHERE status='live') AS live`;
try {
  assert.notEqual(host(test), host(production), 'SAME_DATABASE');
  assert.equal(createHash('sha256').update(host(test)).digest('hex').slice(0, 16), '1c0147c77e07b78e', 'UNEXPECTED_TEST_ENDPOINT');
  const testSql = neon(test.toString()), sql = neon(production.toString());

  // 1. Isolated test branch: migrate twice (idempotent) and run a synthetic SSB flash.
  for (const file of ['002_news_engine.sql', '003_breaking_desk.sql']) await applyMigration(testSql, file, await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  await applyMigration(testSql, name, contents); await applyMigration(testSql, name, contents);
  const before = (await state(testSql))[0];
  await testSql`UPDATE editorial_settings SET automation_enabled=true,auto_publish_enabled=true,breaking_publish_enabled=true,live_publish_enabled=false WHERE id=1`;
  const url = `https://www.ssb.no/validation/${Date.now()}`, now = new Date().toISOString();
  const flash = { url, source: 'SSB', sourceKey: 'ssb', kind: 'ssb-release', headline: 'Valideringsmelding', fact: 'Syntetisk valideringsmelding.',
    summary: ['Syntetisk valideringsmelding.'], body: 'Syntetisk valideringsmelding.', section: 'Norsk økonomi', slug: `validering-${Date.now()}`,
    storyKey: `validation:${Date.now()}`, enrich: false, publishedAt: now, checkedAt: now, text: 'x', hash: 'validation' };
  const row = await publishFlash(testSql, flash), again = await publishFlash(testSql, flash);
  assert.equal(row.article_id, again.article_id, 'FLASH_NOT_IDEMPOTENT');
  const [article] = await testSql`SELECT priority_score, placement, story_key FROM articles WHERE id=${Number(row.article_id)}`;
  assert.ok(article.priority_score != null && article.placement && article.story_key, 'DESK_FIELDS_MISSING');
  await testSql.transaction([
    testSql`DELETE FROM article_sources WHERE article_id=${Number(row.article_id)}`,
    testSql`DELETE FROM breaking_revisions WHERE event_id=${Number(row.id)}`,
    testSql`UPDATE breaking_events SET article_id=NULL WHERE id=${Number(row.id)}`,
    testSql`DELETE FROM articles WHERE id=${Number(row.article_id)}`,
    testSql`DELETE FROM breaking_events WHERE id=${Number(row.id)}`,
    testSql`UPDATE editorial_settings SET automation_enabled=${before.settings.automation_enabled},auto_publish_enabled=${before.settings.auto_publish_enabled},
      breaking_publish_enabled=${before.settings.breaking_publish_enabled},live_publish_enabled=${before.settings.live_publish_enabled} WHERE id=1`,
  ]);
  const [tested] = await testSql`SELECT checksum FROM kapitalstrom_migrations WHERE name=${name}`;
  assert.equal(tested?.checksum, checksum, 'TEST_MIGRATION_MISMATCH');

  // 2. Production: additive migration, switches and articles unchanged.
  const [prodBefore] = await state(sql);
  await applyMigration(sql, name, contents);
  const [prodAfter] = await state(sql);
  assert.deepEqual(prodAfter.settings, prodBefore.settings, 'SETTINGS_CHANGED');
  assert.equal(prodAfter.articles, prodBefore.articles, 'ARTICLE_COUNT_CHANGED');
  assert.equal(prodAfter.live, prodBefore.live, 'LIVE_COUNT_CHANGED');
  const [summaries] = await sql`SELECT count(*) FILTER (WHERE summary_points <> '[]'::jsonb)::int AS with_summary, count(*)::int AS live FROM articles WHERE status='live'`;
  console.log(JSON.stringify({ ok: true, migration: name, checksum, testSmoke: true, settingsPreserved: true, articles: prodAfter.articles, liveWithSummary: summaries }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, reason: /^[A-Z_]+$/.test(error.message) ? error.message : String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[REDACTED]').slice(0, 300) }));
  process.exitCode = 1;
}
