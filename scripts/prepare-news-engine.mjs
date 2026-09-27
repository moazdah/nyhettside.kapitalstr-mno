// Only additive schema changes. Existing schedules and article review are preserved.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
import { applyMigration } from '../lib/editorial/migrate.mjs';
function endpoint(value) {
  const url=new URL(value); assert.ok(url.hostname.endsWith('.neon.tech'),'EXPECTED_NEON');
  url.hostname=url.hostname.replace('-pooler.','.'); return url;
}
try {
  const test=endpoint(process.env.EDITORIAL_TEST_DATABASE_URL_UNPOOLED);
  const production=endpoint(process.env.EDITORIAL_PRODUCTION_DATABASE_URL_UNPOOLED);
  assert.notEqual(test.hostname,production.hostname,'SAME_DATABASE');
  assert.equal(createHash('sha256').update(test.hostname).digest('hex').slice(0,16),'1c0147c77e07b78e','UNEXPECTED_TEST_ENDPOINT');
  const contents=await readFile(new URL('../migrations/002_news_engine.sql',import.meta.url),'utf8');
  const checksum=createHash('sha256').update(contents).digest('hex');
  const testSql=neon(test.toString()),sql=neon(production.toString());
  const [tested]=await testSql`SELECT checksum FROM kapitalstrom_migrations WHERE name='002_news_engine.sql'`;
  assert.equal(tested?.checksum,checksum,'TEST_MIGRATION_MISMATCH');
  const [settings]=await sql`SELECT automation_enabled,auto_publish_enabled FROM editorial_settings WHERE id=1`;
  assert.equal(settings.auto_publish_enabled,false,'ARTICLE_REVIEW_REQUIRED');
  await applyMigration(sql,'002_news_engine.sql',contents);
  const [after]=await sql`SELECT automation_enabled,auto_publish_enabled,live_publish_enabled FROM editorial_settings WHERE id=1`;
  assert.equal(after.automation_enabled,settings.automation_enabled,'AUTOMATION_CHANGED');
  assert.equal(after.auto_publish_enabled,false,'ARTICLE_REVIEW_CHANGED');
  const [ready]=await sql`SELECT to_regprocedure('public.engine_assert_lease(bigint,uuid)') IS NOT NULL AS ready`;
  assert.equal(ready.ready,true,'ENGINE_SCHEMA_MISSING');
  console.log(JSON.stringify({ok:true,migration:'002_news_engine.sql',checksum,automation:after.automation_enabled,articleAutopublish:false,livePublish:after.live_publish_enabled}));
} catch(error) {
  console.error(JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(error.message)?error.message:error.name}));
  process.exitCode=1;
}
