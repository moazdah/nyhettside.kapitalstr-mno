// Additive, repeatable migration. This does not enable automation or publish.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
import { applyMigration } from '../lib/editorial/migrate.mjs';
const migration='001_editorial_cases.sql';
const direct=value=>{ const u=new URL(value); assert.ok(u.hostname.endsWith('.neon.tech')); u.hostname=u.hostname.replace('-pooler.','.'); return u; };
let stage='configuration';
try {
  assert.ok(process.env.DEEPSEEK_API_KEY && process.env.VERCEL_TOKEN,'PROVIDER_SECRETS_MISSING');
  const test=direct(process.env.EDITORIAL_TEST_DATABASE_URL_UNPOOLED);
  const production=direct(process.env.EDITORIAL_PRODUCTION_DATABASE_URL_UNPOOLED);
  assert.notEqual(test.hostname,production.hostname);
  assert.equal(createHash('sha256').update(test.hostname).digest('hex').slice(0,16),'1c0147c77e07b78e');
  const sql=neon(production.toString()), testSql=neon(test.toString());
  const contents=await readFile(new URL(`../migrations/${migration}`,import.meta.url),'utf8');
  const checksum=createHash('sha256').update(contents).digest('hex');
  const [verified]=await testSql`SELECT checksum FROM kapitalstrom_migrations WHERE name=${migration}`;
  assert.equal(verified?.checksum,checksum,'TEST_MIGRATION_MISMATCH');
  stage='production_settings';
  const [settings]=await sql`SELECT automation_enabled,auto_publish_enabled FROM editorial_settings WHERE id=1`;
  assert.equal(settings?.automation_enabled,false,'AUTOMATION_MUST_BE_PAUSED');
  assert.equal(settings?.auto_publish_enabled,false,'AUTOPUBLISH_MUST_BE_PAUSED');
  const [before]=await sql`SELECT count(*)::int AS articles FROM articles`;
  stage='production_migration';
  await applyMigration(sql,migration,contents);
  await applyMigration(sql,migration,contents);
  const [after]=await sql`SELECT count(*)::int AS articles FROM articles`;
  assert.equal(after.articles,before.articles);
  stage='review_environment';
  const response=await fetch('https://api.vercel.com/v10/projects/prj_dt9X67WnEvEROT1WntALIWd5I68T/env?teamId=team_RbPY2JdK0IeLUf78YlfJUaxg&upsert=true',{
    method:'POST',headers:{Authorization:`Bearer ${process.env.VERCEL_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify([
      {key:'EDITORIAL_AUTOPUBLISH_V1',value:'false',type:'plain',target:['production']},
      {key:'DEEPSEEK_API_KEY',value:process.env.DEEPSEEK_API_KEY,type:'sensitive',target:['production']},
    ]),signal:AbortSignal.timeout(15000)});
  const result=await response.json();
  assert.ok(response.ok&&!result.failed?.length,'REVIEW_ENVIRONMENT_FAILED');
  console.log(JSON.stringify({ok:true,migration,checksum,articlesBefore:before.articles,articlesAfter:after.articles,automation:false,autopublish:false}));
} catch(error) {
  console.error(JSON.stringify({ok:false,stage,code:/^[A-Z0-9_]+$/.test(String(error.code))?error.code:'PREPARE_FAILED'}));
  process.exitCode=1;
}
