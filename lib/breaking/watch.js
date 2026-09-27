import { db } from '../db';
import { NB_FEED, decisionLinks, parseDecision, fetchOfficial } from './norges-bank.mjs';
import { publishFlash } from './store.mjs';

export async function watchNorgesBank({sql=db(),now=Date.now()}={}) {
 const [settings]=await sql`SELECT automation_enabled,auto_publish_enabled,breaking_publish_enabled FROM editorial_settings WHERE id=1`;
 if(!settings?.automation_enabled||!settings.auto_publish_enabled||!settings.breaking_publish_enabled) return {skipped:true,reason:'disabled'};
 try {
  const links=decisionLinks(await fetchOfficial(NB_FEED,'application/rss+xml, application/xml, text/xml'),now);
  const published=[];
  for(const link of links.slice(0,2)) {
   const [existing]=await sql`SELECT id FROM breaking_events WHERE source_url=${link.url}`;
   if(existing) continue;
   const decision=parseDecision(await fetchOfficial(link.url),{...link,now});
   published.push(await publishFlash(sql,decision));
  }
  await sql`INSERT INTO breaking_watch(source,checked_at,last_success_at) VALUES('norges-bank',now(),now())
   ON CONFLICT(source) DO UPDATE SET checked_at=now(),last_success_at=now(),last_error=NULL`;
  return {checked:true,published};
 } catch(error) {
  await sql`INSERT INTO breaking_watch(source,checked_at,last_error) VALUES('norges-bank',now(),${String(error.message).slice(0,500)})
   ON CONFLICT(source) DO UPDATE SET checked_at=now(),last_error=EXCLUDED.last_error`;
  throw error;
 }
}
