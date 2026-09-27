import { db } from '../../lib/db';
import { fullDate } from '../../lib/format';
export default async function BreakingDeskHealth() {
 const sql=db();
 const [[watch],[event],[settings]]=await Promise.all([
  sql`SELECT * FROM breaking_watch WHERE source='norges-bank'`,
  sql`SELECT headline,source_published_at,discovered_at,first_published_at,enriched_at,last_error,
   EXTRACT(EPOCH FROM (first_published_at-source_published_at))::int AS total_seconds,
   EXTRACT(EPOCH FROM (first_published_at-discovered_at))::int AS processing_seconds
   FROM breaking_events ORDER BY discovered_at DESC LIMIT 1`,
  sql`SELECT automation_enabled,auto_publish_enabled,breaking_publish_enabled FROM editorial_settings WHERE id=1`,
 ]);
 const enabled=settings?.automation_enabled&&settings.auto_publish_enabled&&settings.breaking_publish_enabled;
 const now=new Date(),withinWatchHours=now.getUTCDay()>=1&&now.getUTCDay()<=5&&now.getUTCHours()>=6&&now.getUTCHours()<=16;
 const delayed=enabled&&withinWatchHours&&(!watch?.last_success_at||Date.now()-new Date(watch.last_success_at)>10*60000);
 return <section className="adminNote"><h2>Hurtigdesk · Norges Bank</h2>
  <p>{enabled?'Automatisk publisering er på.':'Hurtigpublisering er pauset.'} Kort melding publiseres før AI-utdypingen.</p>
  <p>{!withinWatchHours&&'Utenfor rentevaktens åpningstid. '}Siste vellykkede kildesjekk: {watch?.last_success_at?fullDate(watch.last_success_at):'Ikke registrert'}.</p>
  {delayed&&<p role="alert" style={{color:'#b32125'}}>Kildesjekken er mer enn 10 minutter forsinket eller har ikke startet.</p>}
  {watch?.last_error&&<p role="alert">Kildefeil: {watch.last_error}</p>}
  {event?<><b>{event.headline}</b><p>Kilden publiserte: {fullDate(event.source_published_at)}<br/>
   Oppdaget: {fullDate(event.discovered_at)}<br/>Synlig: {event.first_published_at?fullDate(event.first_published_at):'Venter'}<br/>
   Fra kilde til publisering: {event.total_seconds??'–'} sekunder. Behandling etter oppdagelse: {event.processing_seconds??'–'} sekunder.<br/>
   Utdypet: {event.enriched_at?fullDate(event.enriched_at):'Venter på verifisert utdyping'}</p>
   {event.last_error&&<p role="alert">Utdypingen forsøkes på nytt innenfor jobbens forsøksgrense: {event.last_error}</p>}</>:<p>Ingen fersk rentebeslutning behandlet ennå.</p>}
 </section>;
}
