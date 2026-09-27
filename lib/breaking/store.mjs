// A flash, its live message and its enrichment job commit together or not at all.
// Replaying the same official release never resets publication time.
export async function publishFlash(sql, decision) {
 const slug=`norges-bank-rente-${decision.publishedAt.slice(0,10)}`;
 const body=`${decision.fact}\n\nDette opplyser Norges Bank i sin rentebeslutning.\n\nSaken oppdateres med bankens begrunnelse.\n\nKilde: [Norges Banks rentebeslutning](${decision.url})`;
 const results=await sql.transaction([
  sql`SELECT pg_advisory_xact_lock(hashtext(${`breaking:${decision.url}`}))`,
  sql`SELECT breaking_assert_enabled()`,
  sql`INSERT INTO breaking_events(source_url,source_name,kind,headline,source_published_at,evidence,source_hash)
   VALUES(${decision.url},${decision.source},${decision.kind},${decision.headline},${decision.publishedAt},${JSON.stringify(decision)}::jsonb,${decision.hash})
   ON CONFLICT(source_url) DO NOTHING`,
  sql`INSERT INTO articles(slug,tittel,undertittel,brodtekst,seksjon,forfatter,status,ai_score,ai_modell,tall_validert,kilde_url,
    publisert_at,updated_at,source_published_at,breaking_until,breaking_event_id,summary_points)
   SELECT ${slug},headline,${decision.fact},${body},'Norsk økonomi','Kapitalstrøm','live',100,'official-rate-flash/v1',true,source_url,
    now(),now(),source_published_at,now()+interval '2 hours',id,${JSON.stringify([decision.fact])}::jsonb
   FROM breaking_events WHERE source_url=${decision.url}
   ON CONFLICT(breaking_event_id) WHERE breaking_event_id IS NOT NULL DO NOTHING`,
  sql`UPDATE breaking_events e SET article_id=a.id,first_published_at=COALESCE(e.first_published_at,a.publisert_at),
   status=CASE WHEN e.status='detected' THEN 'published' ELSE e.status END
   FROM articles a WHERE a.breaking_event_id=e.id AND e.source_url=${decision.url}`,
  sql`INSERT INTO breaking_revisions(event_id,stage,body,source_hash)
   SELECT id,'flash',${body},source_hash FROM breaking_events WHERE source_url=${decision.url}
   ON CONFLICT(event_id,stage,source_hash) DO NOTHING`,
  sql`SELECT pg_advisory_xact_lock(7419220)`,
  sql`INSERT INTO feed(tekst,headline,summary,seksjon,status,tidspunkt,source_published_at,source_url,source_name,article_id,priority,event_key,generated_by)
   SELECT headline,headline,${decision.fact},'Norsk økonomi','live',first_published_at,source_published_at,source_url,source_name,article_id,100,'breaking:'||id,'breaking-desk/v1'
   FROM breaking_events e WHERE source_url=${decision.url}
    AND (SELECT live_publish_enabled FROM editorial_settings WHERE id=1)=true
    AND NOT EXISTS(SELECT 1 FROM feed WHERE event_key='breaking:'||e.id)`,
  sql`UPDATE feed SET status='expired',expired_at=now() WHERE status='live' AND (tidspunkt<now()-interval '2 hours' OR id NOT IN
    (SELECT id FROM feed WHERE status='live' ORDER BY tidspunkt DESC,priority DESC NULLS LAST,id DESC LIMIT 12))`,
  sql`INSERT INTO engine_jobs(kind,slot,payload)
   SELECT 'breaking-enrichment','event:'||id,jsonb_build_object('eventId',id) FROM breaking_events WHERE source_url=${decision.url}
   ON CONFLICT(kind,slot) DO NOTHING`,
  sql`SELECT e.id,e.article_id,a.slug,e.first_published_at,e.source_published_at,e.discovered_at,e.status
   FROM breaking_events e JOIN articles a ON a.id=e.article_id WHERE e.source_url=${decision.url}`,
 ]);
 return results.at(-1)[0];
}
