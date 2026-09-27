import { db } from '../../lib/db';
import { fullDate } from '../../lib/format';
import { latencyReport } from '../../lib/ops/alerts.mjs';

const NAMES = { 'norges-bank': 'Norges Bank', ssb: 'SSB', 'oslo-bors': 'Oslo Børs' };
const seconds = value => value == null ? '–' : value < 120 ? `${value} s` : `${Math.round(value / 60)} min`;

export default async function BreakingDeskHealth() {
  const sql = db();
  const [[settings], sources, events] = await Promise.all([
    sql`SELECT automation_enabled,auto_publish_enabled,breaking_publish_enabled FROM editorial_settings WHERE id=1`,
    sql`SELECT * FROM breaking_watch ORDER BY source`,
    sql`SELECT kind,headline,source_name,source_published_at,discovered_at,first_published_at,enriched_at,last_error,status,
      EXTRACT(EPOCH FROM (first_published_at-source_published_at))::int AS total_seconds,
      EXTRACT(EPOCH FROM (first_published_at-discovered_at))::int AS processing_seconds
      FROM breaking_events ORDER BY discovered_at DESC LIMIT 6`,
  ]);
  let latency = null, alerts = [];
  try {
    latency = await latencyReport(sql);
    alerts = await sql`SELECT alert_key,severity,title,first_seen_at,occurrences FROM ops_alerts WHERE resolved_at IS NULL ORDER BY severity DESC,first_seen_at LIMIT 10`;
  } catch { /* shown after migration 004 */ }
  const enabled = settings?.automation_enabled && settings.auto_publish_enabled && settings.breaking_publish_enabled;
  return <section className="adminNote"><h2>Hurtigspor og drift</h2>
    <p>{enabled ? 'Automatisk hurtigpublisering er på.' : 'Hurtigpublisering er pauset.'} Offisielle kilder publiseres som kortmelding før eventuell AI-utdyping.</p>
    {alerts.length > 0 && <div role="alert">{alerts.map(a => <p key={a.alert_key} style={{ color: a.severity === 'critical' ? '#b32125' : '#8a5a00' }}>
      <b>{a.severity === 'critical' ? 'Kritisk' : 'Varsel'}:</b> {a.title} (siden {fullDate(a.first_seen_at)}{a.occurrences > 1 ? `, ${a.occurrences} kontroller` : ''})</p>)}</div>}
    {latency && <p>Kilde → synlig (30 dager, {latency.sourceToVisible.events} hendelser): median {seconds(latency.sourceToVisible.medianSeconds)},
      90-persentil {seconds(latency.sourceToVisible.p90Seconds)}, verst {seconds(latency.sourceToVisible.maxSeconds)}.<br/>
      Tidsstyring siste døgn: {latency.scheduler.ticks24h} kjøringer, typisk avstand {seconds(latency.scheduler.medianGapSeconds)},
      95-persentil {seconds(latency.scheduler.p95GapSeconds)}, lengste opphold {seconds(latency.scheduler.maxGapSeconds)}.</p>}
    {sources.map(s => <p key={s.source}><b>{NAMES[s.source] || s.source}</b>: siste vellykkede sjekk {s.last_success_at ? fullDate(s.last_success_at) : 'ikke registrert'}
      {Number(s.consecutive_failures) > 0 && <span role="alert" style={{ color: '#b32125' }}> · {s.consecutive_failures} feil på rad siden {fullDate(s.first_failure_at)}
        {s.next_attempt_at && `, nytt forsøk ${fullDate(s.next_attempt_at)}`}: {s.last_error}</span>}</p>)}
    {events.length ? events.map((event, i) => <p key={i}><b>{event.headline}</b><br/>
      {event.source_name} · kilde {fullDate(event.source_published_at)} · synlig {event.first_published_at ? fullDate(event.first_published_at) : 'venter'}
      {' '}({seconds(event.total_seconds)} fra kilde, {seconds(event.processing_seconds)} etter oppdagelse)
      {event.enriched_at ? ` · utdypet ${fullDate(event.enriched_at)}` : event.status === 'flash_only' ? ' · kortmelding uten utdyping' : ''}
      {event.last_error && <><br/><span role="alert">Utdyping prøves på nytt: {event.last_error}</span></>}</p>)
      : <p>Ingen hurtigsaker behandlet ennå.</p>}
  </section>;
}
