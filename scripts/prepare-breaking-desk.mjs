import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {neon} from '@neondatabase/serverless';
import {applyMigration} from '../lib/editorial/migrate.mjs';
try {
 const test=new URL(process.env.EDITORIAL_TEST_DATABASE_URL_UNPOOLED),production=new URL(process.env.EDITORIAL_PRODUCTION_DATABASE_URL_UNPOOLED);
 const host=u=>u.hostname.replace('-pooler.','.');
 assert.notEqual(host(test),host(production),'SAME_DATABASE');assert.ok(host(production).endsWith('.neon.tech'),'EXPECTED_NEON');
 assert.equal(createHash('sha256').update(host(test)).digest('hex').slice(0,16),'1c0147c77e07b78e','UNEXPECTED_TEST_ENDPOINT');
 const name='003_breaking_desk.sql',contents=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
 const checksum=createHash('sha256').update(contents).digest('hex');
 const testedSql=neon(test.toString()),sql=neon(production.toString());
 const [tested]=await testedSql`SELECT checksum FROM kapitalstrom_migrations WHERE name=${name}`;
 assert.equal(tested?.checksum,checksum,'TEST_MIGRATION_MISMATCH');
 const [before]=await sql`SELECT automation_enabled,auto_publish_enabled FROM editorial_settings WHERE id=1`;
 await applyMigration(sql,name,contents);
 const [after]=await sql`SELECT automation_enabled,auto_publish_enabled FROM editorial_settings WHERE id=1`;
 assert.deepEqual(after,before,'SETTINGS_CHANGED_BEFORE_DEPLOYMENT');
 console.log(JSON.stringify({ok:true,migration:name,checksum,settingsPreserved:true}));
} catch(error) {console.error(JSON.stringify({ok:false,reason:/^[A-Z_]+$/.test(error.message)?error.message:error.name}));process.exitCode=1;}
