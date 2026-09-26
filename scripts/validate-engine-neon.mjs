import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
import { applyMigration } from '../lib/editorial/migrate.mjs';
import { engineChecks } from '../tests/engine-checks.mjs';
function endpoint(value) {
  assert.ok(value,'DATABASE_SECRET_MISSING');
  const url=new URL(value); url.hostname=url.hostname.replace('-pooler.','.');
  assert.ok(url.hostname.endsWith('.neon.tech'),'EXPECTED_NEON');
  return url;
}
try {
  const test=endpoint(process.env.EDITORIAL_TEST_DATABASE_URL_UNPOOLED);
  const prod=endpoint(process.env.EDITORIAL_PRODUCTION_DATABASE_URL_UNPOOLED);
  assert.notEqual(test.hostname,prod.hostname,'TEST_IS_PRODUCTION');
  assert.equal(createHash('sha256').update(test.hostname).digest('hex').slice(0,16),'1c0147c77e07b78e','UNEXPECTED_TEST_ENDPOINT');
  const sql=neon(test.toString()),other=neon(test.toString());
  const migration=await readFile(new URL('../migrations/002_news_engine.sql',import.meta.url),'utf8');
  await Promise.all([applyMigration(sql,'002_news_engine.sql',migration),applyMigration(other,'002_news_engine.sql',migration)]);
  await engineChecks(sql,other);
  console.log(JSON.stringify({ok:true,isolatedNeon:true,concurrentMigration:true,concurrentWorkers:true,resume:true,fencing:true,retries:true}));
} catch(error) {
  // Provider errors can contain credentials. Emit only an assertion label or error class.
  console.error(JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(error.message)?error.message:error.name}));
  process.exitCode=1;
}
