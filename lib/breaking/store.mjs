import { assessStory } from '../desk/priority.mjs';

// Defaults reproduce the first fast-track type (Norges Bank rate decisions).
function flashShape(decision) {
  const desk = decision.desk || assessStory({ title: decision.headline, summary: decision.fact, kind: decision.kind,
    sourceKey: decision.sourceKey || 'norges-bank', publishedAt: decision.publishedAt, fastTrack: true, largeCap: decision.largeCap },
    { now: decision.checkedAt ? new Date(decision.checkedAt).getTime() : Date.now() });
  return {
    slug: decision.slug || `norges-bank-rente-${decision.publishedAt.slice(0, 10)}`,
    body: decision.body || `${decision.fact}\n\nDette opplyser Norges Bank i sin rentebeslutning.\n\nSaken oppdateres med bankens begrunnelse.\n\nKilde: [Norges Banks rentebeslutning](${decision.url})`,
    section: decision.section || 'Norsk økonomi',
    model: decision.model || (decision.kind === 'rate-decision' ? 'official-rate-flash/v1' : `official-flash/v1:${decision.kind}`),
    summary: decision.summary || [decision.fact],
    storyKey: decision.storyKey || null,
    enrich: decision.enrich !== false,
    desk,
  };
}

// A flash, its live message and its enrichment job commit together or not at all.
// Replaying the same official release never resets publication time.
export async function publishFlash(sql, decision) {
  const shape = flashShape(decision);
  const { slug, body, desk } = shape;
  const evidence = { ...decision, desk: undefined };
  const results = await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtext(${`breaking:${decision.url}`}))`,
    sql`SELECT breaking_assert_enabled()`,
    sql`INSERT INTO breaking_events(source_url,source_name,kind,headline,source_published_at,evidence,source_hash,story_key)
     VALUES(${decision.url},${decision.source},${decision.kind},${decision.headline},${decision.publishedAt},${JSON.stringify(evidence)}::jsonb,${decision.hash},${shape.storyKey})
     ON CONFLICT DO NOTHING`,
    sql`INSERT INTO articles(slug,tittel,undertittel,brodtekst,seksjon,forfatter,status,ai_score,ai_modell,tall_validert,kilde_url,
      publisert_at,updated_at,source_published_at,breaking_until,breaking_event_id,summary_points,story_key,priority_score,placement,desk_assessment)
     SELECT ${slug},headline,${decision.fact},${body},${shape.section},'Kapitalstrøm','live',100,${shape.model},true,source_url,
      now(),now(),source_published_at,CASE WHEN ${desk.banner} THEN now()+interval '2 hours' END,id,${JSON.stringify(shape.summary)}::jsonb,
      story_key,${desk.score},${desk.placement},${JSON.stringify(desk)}::jsonb
     FROM breaking_events WHERE source_url=${decision.url}
     ON CONFLICT(breaking_event_id) WHERE breaking_event_id IS NOT NULL DO NOTHING`,
    sql`UPDATE breaking_events e SET article_id=a.id,first_published_at=COALESCE(e.first_published_at,a.publisert_at),
     status=CASE WHEN e.status='detected' THEN 'published' ELSE e.status END
     FROM articles a WHERE a.breaking_event_id=e.id AND e.source_url=${decision.url}`,
    sql`INSERT INTO article_sources(article_id,url,source_name,title,role,published_at)
     SELECT article_id,source_url,source_name,headline,'primary',source_published_at FROM breaking_events
     WHERE source_url=${decision.url} AND article_id IS NOT NULL ON CONFLICT(article_id,url) DO NOTHING`,
    sql`INSERT INTO breaking_revisions(event_id,stage,body,source_hash)
     SELECT id,'flash',${body},source_hash FROM breaking_events WHERE source_url=${decision.url}
     ON CONFLICT(event_id,stage,source_hash) DO NOTHING`,
    sql`SELECT pg_advisory_xact_lock(7419220)`,
    sql`INSERT INTO feed(tekst,headline,summary,seksjon,status,tidspunkt,source_published_at,source_url,source_name,article_id,priority,event_key,generated_by)
     SELECT headline,headline,${decision.fact},${shape.section},'live',first_published_at,source_published_at,source_url,source_name,article_id,${desk.score},'breaking:'||id,'breaking-desk/v1'
     FROM breaking_events e WHERE source_url=${decision.url} AND ${desk.live}
      AND (SELECT live_publish_enabled FROM editorial_settings WHERE id=1)=true
      AND NOT EXISTS(SELECT 1 FROM feed WHERE event_key='breaking:'||e.id)`,
    sql`UPDATE feed SET status='expired',expired_at=now() WHERE status='live' AND (tidspunkt<now()-interval '2 hours' OR id NOT IN
      (SELECT id FROM feed WHERE status='live' ORDER BY tidspunkt DESC,priority DESC NULLS LAST,id DESC LIMIT 12))`,
    sql`INSERT INTO engine_jobs(kind,slot,payload)
     SELECT 'breaking-enrichment','event:'||id,jsonb_build_object('eventId',id) FROM breaking_events
     WHERE source_url=${decision.url} AND ${shape.enrich}
     ON CONFLICT(kind,slot) DO NOTHING`,
    sql`SELECT e.id,e.article_id,a.slug,e.first_published_at,e.source_published_at,e.discovered_at,e.status
     FROM breaking_events e JOIN articles a ON a.id=e.article_id WHERE e.source_url=${decision.url}`,
  ]);
  return results.at(-1)[0];
}
