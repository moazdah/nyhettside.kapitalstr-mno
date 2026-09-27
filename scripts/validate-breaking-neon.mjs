import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {neon} from '@neondatabase/serverless';
import {applyMigration} from '../lib/editorial/migrate.mjs';
import {NB_FEED,decisionLinks,parseDecision,fetchOfficial} from '../lib/breaking/norges-bank.mjs';
import {publishFlash} from '../lib/breaking/store.mjs';
import {application} from './editorial-runtime.mjs';
export function isolatedDatabase() {
 const test=new URL(process.env.EDITORIAL_TEST_DATABASE_URL_UNPOOLED),prod=new URL(process.env.EDITORIAL_PRODUCTION_DATABASE_URL_UNPOOLED);
 const host=u=>u.hostname.replace('-pooler.','.');
 assert.notEqual(host(test),host(prod));
 assert.equal(createHash('sha256').update(host(test)).digest('hex').slice(0,16),'1c0147c77e07b78e');
 return neon(test.toString());
}
export async function cleanup(sql,url) {
 const [event]=await sql`SELECT id,article_id FROM breaking_events WHERE source_url=${url}`;
 if(!event) return;
 await sql.transaction([
  sql`DELETE FROM feed WHERE event_key=${'breaking:'+event.id}`,
  sql`DELETE FROM engine_jobs WHERE kind='breaking-enrichment' AND slot=${'event:'+event.id}`,
  sql`DELETE FROM breaking_revisions WHERE event_id=${Number(event.id)}`,
  sql`UPDATE breaking_events SET article_id=NULL WHERE id=${Number(event.id)}`,
  sql`DELETE FROM articles WHERE breaking_event_id=${Number(event.id)}`,
  sql`DELETE FROM breaking_events WHERE id=${Number(event.id)}`,
 ]);
}
// Historical official publication is replayed only in this isolated validation.
// Production has no request parameter or environment switch to bypass freshness.
if(process.argv[1]?.endsWith('validate-breaking-neon.mjs')) {
 try {
  const sql=isolatedDatabase();
  await applyMigration(sql,'003_breaking_desk.sql',await readFile(new URL('../migrations/003_breaking_desk.sql',import.meta.url),'utf8'));
  await sql`UPDATE editorial_settings SET automation_enabled=true,auto_publish_enabled=true,breaking_publish_enabled=true WHERE id=1`;
  const xml=await fetchOfficial(NB_FEED,'application/rss+xml');
  const publishedAt=xml.match(/<pubDate>([^<]+)<\/pubDate>/i)?.[1];
  assert.ok(publishedAt,'OFFICIAL_FEED_DATE_MISSING');
  const clock=Date.parse(publishedAt)+1000;
  const [link]=decisionLinks(xml,clock);assert.ok(link,'OFFICIAL_DECISION_MISSING');
  const evidence=parseDecision(await fetchOfficial(link.url),{...link,now:clock});
  await writeFile('breaking-source.json',JSON.stringify(evidence));
  await cleanup(sql,evidence.url);
  const begin=Date.now();
  const [a,b]=await Promise.all([publishFlash(sql,evidence),publishFlash(neon(process.env.EDITORIAL_TEST_DATABASE_URL_UNPOOLED),evidence)]);
  assert.equal(a.article_id,b.article_id);assert.equal(String(a.first_published_at),String(b.first_published_at));
  const flashMs=Date.now()-begin;assert.ok(flashMs<60000);
  const app=application(sql),worker=await app.load('lib/breaking/enrich.js');
  const start=Date.now();
  const result=await worker.enrichNext(sql);assert.equal(result.enriched,true);
  const [article]=await sql`SELECT * FROM articles WHERE id=${Number(a.article_id)}`;
  assert.equal(article.status,'live');assert.equal(article.summary_points.length,3);
  assert.equal(String(article.publisert_at),String(a.first_published_at));
  const revisions=await sql`SELECT * FROM breaking_revisions WHERE event_id=${Number(a.id)}`;assert.equal(revisions.length,2);
  console.log(JSON.stringify({ok:true,historicalReplay:true,officialHeadline:evidence.headline,flashMs,enrichmentMs:Date.now()-start,articleId:a.article_id,sameArticle:true,verified:true}));
  // Browser validation creates its own flash from the same official evidence.
  await cleanup(sql,evidence.url);
 } catch(error) {console.error(JSON.stringify({ok:false,message:String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g,'[REDACTED]').slice(0,500)}));process.exitCode=1;}
}
