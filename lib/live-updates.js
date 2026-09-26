import { publicationEvidence } from './editorial/contract.mjs';
import { guard } from './engine/jobs.mjs';
import { db } from './db';
import { deepSeekJsonRequest } from './ai/deepseek-client';
import { ensureLiveUpdateSchema } from './live-update-schema';

const MODEL = 'deepseek-v4-pro';
const MAX_ACTIVE_UPDATES = 12;
const MAX_NEW_PER_RUN = 4;
const LIVE_MAX_AGE_HOURS = 2;
const AGGREGATED_SOURCE_KINDS = new Set(['fast-news-aggregator', 'news-index']);

function parseSourcePublishedAt(html = '') {
  const evidence = publicationEvidence(String(html).slice(0,1_800_000));
  return evidence ? new Date(evidence.at) : null;
}

function sourceDateIsFresh(value, maxHours = LIVE_MAX_AGE_HOURS) {
  if (!value) return false;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const ageMs = Date.now() - date.getTime();
  return ageMs >= -15 * 60 * 1000 && ageMs <= maxHours * 60 * 60 * 1000;
}

async function ensureLiveFreshnessSchema(sql) {
  await sql`ALTER TABLE radar_items ADD COLUMN IF NOT EXISTS live_source_published_at TIMESTAMPTZ`;
  await sql`ALTER TABLE radar_items ADD COLUMN IF NOT EXISTS live_source_checked_at TIMESTAMPTZ`;
  await sql`ALTER TABLE radar_items ADD COLUMN IF NOT EXISTS live_source_fresh BOOLEAN`;
}

async function fetchOriginalPublishedAt(url) {
  if (!url) return null;
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(7000),
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; KapitalstromLiveDesk/1.0)',
      },
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!/html/i.test(contentType)) return null;
    return parseSourcePublishedAt(await response.text(), response.url || url);
  } catch {
    return null;
  }
}

async function verifyLiveSourceFreshness(sql, row) {
  if (!row?.published_at || !sourceDateIsFresh(row.published_at)) return false;

  if (!AGGREGATED_SOURCE_KINDS.has(String(row.source_kind || ''))) {
    return true;
  }

  if (row.live_source_checked_at) {
    return row.live_source_fresh === true && sourceDateIsFresh(row.live_source_published_at);
  }

  const originalPublishedAt = await fetchOriginalPublishedAt(row.url);
  const fresh = sourceDateIsFresh(originalPublishedAt);

  await sql`
    UPDATE radar_items
    SET live_source_published_at = ${originalPublishedAt ? originalPublishedAt.toISOString() : null},
        live_source_checked_at = NOW(),
        live_source_fresh = ${fresh}
    WHERE id = ${Number(row.id)}
  `;

  row.live_source_published_at = originalPublishedAt?.toISOString() || null;
  return fresh;
}

async function purgeStaleAggregatedLiveItems(sql) {
  const rows = await sql`
    SELECT r.id, r.url, r.source_kind, r.published_at,
           r.live_source_published_at, r.live_source_checked_at, r.live_source_fresh
    FROM feed f
    JOIN radar_items r ON r.id = f.radar_item_id
    WHERE f.status = 'live'
      AND r.source_kind IN ('fast-news-aggregator', 'news-index')
      AND (
        r.live_source_checked_at IS NULL
        OR r.live_source_fresh IS NOT TRUE
      )
    ORDER BY f.tidspunkt DESC
    LIMIT ${MAX_ACTIVE_UPDATES}
  `;

  for (const row of rows) {
    const fresh = await verifyLiveSourceFreshness(sql, row);
    if (fresh) continue;
    await sql`
      UPDATE feed
      SET status = 'expired',
          expired_at = COALESCE(expired_at, NOW())
      WHERE status = 'live'
        AND radar_item_id = ${Number(row.id)}
    `;
  }
}

function estimateCostUsd(usage = {}) {
  const hit = Number(usage.prompt_cache_hit_tokens || 0);
  const miss = Number(usage.prompt_cache_miss_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.completion_tokens || 0);
  const now = new Date();
  const weekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;
  const hour = now.getUTCHours();
  const peak = weekday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  const hitRate = peak ? 0.044 : 0.022;
  const missRate = peak ? 1.32 : 0.66;
  const outputRate = peak ? 3.96 : 1.98;
  return ((hit * hitRate) + (miss * missRate) + (output * outputRate)) / 1_000_000;
}

async function trimActiveFeed(sql) {
  await ensureLiveFreshnessSchema(sql);
  await purgeStaleAggregatedLiveItems(sql);

  await sql`
    UPDATE feed f
    SET status = 'expired',
        expired_at = COALESCE(f.expired_at, NOW())
    FROM radar_items r
    WHERE f.status = 'live'
      AND f.radar_item_id = r.id
      AND (
        r.published_at IS NULL
        OR r.published_at < NOW() - interval '2 hours'
      )
  `;

  await sql`
    UPDATE feed
    SET status = 'expired',
        expired_at = COALESCE(expired_at, NOW())
    WHERE status = 'live'
      AND tidspunkt < NOW() - interval '2 hours'
  `;

  await sql`
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               ORDER BY tidspunkt DESC,
                        priority DESC NULLS LAST,
                        id DESC
             ) AS rn
      FROM feed
      WHERE status = 'live'
    )
    UPDATE feed f
    SET status = 'expired',
        expired_at = COALESCE(expired_at, NOW())
    FROM ranked r
    WHERE f.id = r.id
      AND r.rn > ${MAX_ACTIVE_UPDATES}
  `;
}

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function generateUpdates(sql, candidates, {
  autoPublish = true,
  generatedBy = 'autopilot-live-v2',
  job = null,
} = {}) {
  if (!candidates.length) {
    await trimActiveFeed(sql);
    return { requested: 0, created: 0, status: autoPublish ? 'live' : 'draft', errors: [] };
  }

  const system = `Du er deskjournalist i Kapitalstrøm, en norsk finans- og økonominyhetsside.
Du lager KORTE live-oppdateringer fra ferdig filtrerte nyhetstreff.

Regler:
- Skriv på naturlig norsk bokmål.
- Bruk KUN fakta som finnes i input. Ikke legg til tall, kursreaksjoner, sitater eller årsaker som ikke står der.
- Vær nøytral, konkret og journalistisk.
- headline: kort og informativ, normalt 40–100 tegn.
- summary: 1–2 korte setninger, normalt 80–240 tegn. Den skal tilføre forklaring, ikke gjenta overskriften.
- En score på 60–69 er bare inngangsbillett. Publiser KUN dersom saken er fersk, konkret og interessant akkurat nå.
- Prioriter nye hendelser, breaking-markedsnytt, resultater/guiding, oppkjøp, rente-/makrotall, store kursbevegelser og kjente selskaper/personer med tydelig økonomisk betydning.
- Avvis bakgrunnssaker, meningsstoff, generelle analyser, gamle oppsummeringer og saker som bare er 'greie å vite'.
- Saken skal føles som noe en rask finansdesk ville løftet nå, ikke som et miniarkiv.
- Ingen clickbait, ingen investeringsråd, ingen "AI"-språk.
- Hvis grunnlaget er for tynt til en presis oppdatering, sett publish=false.
- Returner bare gyldig JSON:
{"items":[{"id":123,"publish":true,"headline":"...","summary":"..."}]}`;

  const payload = candidates.map((row) => ({
    id: Number(row.id),
    title: row.title,
    summary: row.summary,
    section: row.ai_section,
    score: Number(row.ai_score),
    reason: row.ai_reason,
    source: row.source_name || row.source_domain,
    publishedAt: row.published_at || null,
    ageMinutes: Number(row.age_minutes || 0),
    attentionScore: Number(row.attention_score || 0),
    type: row.candidate_type || null,
  }));

  let result;
  try {
    result = await deepSeekJsonRequest({
      system,
      user: JSON.stringify(payload),
      model: MODEL,
      maxTokens: 1500,
      thinking: false,
      temperature: 0.12,
      timeoutMs: 35000,
      retries: 1,
      label: 'DeepSeek kort nyhetsstrøm',
    });
  } catch (error) {
    return {
      failed: true,
      requested: candidates.length,
      created: 0,
      status: autoPublish ? 'live' : 'draft',
      errors: [String(error?.message || 'Kunne ikke lage korte oppdateringer.').slice(0, 500)],
    };
  }

  const returned = Array.isArray(result?.json?.items) ? result.json.items : [];
  const byId = new Map(candidates.map((row) => [Number(row.id), row]));
  let created = 0;
  const errors = [];

  for (const item of returned) {
    const id = Number(item?.id);
    const source = byId.get(id);
    if (!source || item?.publish !== true) continue;

    const sourceIsFresh = await verifyLiveSourceFreshness(sql, source);
    if (!sourceIsFresh) {
      errors.push(`Radar ${id}: avvist fra live-strømmen fordi original publiseringstid er gammel eller ikke kunne bekreftes.`);
      continue;
    }

    const headline = clean(item.headline, 140);
    const summary = clean(item.summary, 420);
    if (!headline || !summary) {
      errors.push(`Radar ${id}: manglet overskrift eller forklaring.`);
      continue;
    }

    const insertion = sql`
      INSERT INTO feed (
        tekst, headline, summary, seksjon, tidspunkt, status,
        source_url, source_name, radar_item_id, priority,
        event_key, generated_by, source_published_at
      )
      SELECT
        ${headline}, ${headline}, ${summary}, ${source.ai_section || 'Markeder'}, NOW(),
        ${autoPublish ? 'live' : 'draft'},
        ${source.url || null}, ${source.source_name || source.source_domain || null},
        ${id}, ${Number(source.selection_score || source.ai_score || 0)},
        ${source.event_key || null}, ${generatedBy}, ${source.live_source_published_at || source.published_at}
      WHERE NOT EXISTS (
        SELECT 1 FROM feed WHERE radar_item_id = ${id}
          OR (${source.event_key || null}::text IS NOT NULL AND event_key=${source.event_key || null}
              AND tidspunkt>=now()-interval '8 hours')
      )
      ON CONFLICT (radar_item_id) WHERE radar_item_id IS NOT NULL DO NOTHING
      RETURNING id
    `;
    // Serialize feed insert + trim and fence old workers in the same transaction.
    const results = await sql.transaction([
      ...(job ? [guard(sql,job)] : []),
      sql`SELECT pg_advisory_xact_lock(7419220)`,
      insertion,
      sql`WITH ranked AS (SELECT id,row_number() OVER(ORDER BY tidspunkt DESC,priority DESC NULLS LAST,id DESC) AS n FROM feed WHERE status='live')
        UPDATE feed SET status='expired',expired_at=now() WHERE id IN (SELECT id FROM ranked WHERE n>12)`,
    ]);
    created += results[results.length-2].length;
  }

  await trimActiveFeed(sql);

  const usage = result?.usage || {};
  const tokensIn = Number(usage.prompt_tokens || 0);
  const tokensOut = Number(usage.completion_tokens || 0);
  if (tokensIn || tokensOut) {
    await sql`
      INSERT INTO ai_usage (steg, modell, tokens_inn, tokens_ut, kostnad_usd)
      VALUES ('live-updates', ${MODEL}, ${tokensIn}, ${tokensOut}, ${estimateCostUsd(usage)})
    `;
  }

  return {
    requested: candidates.length,
    created,
    status: autoPublish ? 'live' : 'draft',
    estimatedCostUsd: estimateCostUsd(usage),
    errors,
  };
}

export async function syncLiveUpdatesForRun(runId, {
  autoPublish = true,
  maxNew = MAX_NEW_PER_RUN,
} = {}) {
  const sql = db();
  await ensureLiveUpdateSchema(sql);
  await ensureLiveFreshnessSchema(sql);

  const candidates = await sql`
    SELECT r.id, r.title, r.summary, r.ai_score, r.ai_section, r.ai_reason,
           r.source_name, r.source_domain, r.source_kind, r.url, r.published_at,
           r.live_source_published_at, r.live_source_checked_at, r.live_source_fresh,
           COALESCE(r.event_key, r.local_event_key) AS event_key,
           r.selection_rank, r.selection_score,
           r.attention_score, r.candidate_type,
           EXTRACT(EPOCH FROM (NOW() - r.published_at)) / 60.0 AS age_minutes
    FROM radar_items r
    WHERE r.autopilot_run_id = ${Number(runId)}
      AND r.ai_score >= 70
      AND r.published_at IS NOT NULL
      AND r.published_at >= NOW() - interval '2 hours'
      AND NOT EXISTS (
        SELECT 1
        FROM feed f
        WHERE f.radar_item_id = r.id
           OR (
             COALESCE(r.event_key, r.local_event_key) IS NOT NULL
             AND f.event_key = COALESCE(r.event_key, r.local_event_key)
             AND f.tidspunkt >= NOW() - interval '12 hours'
           )
      )
    ORDER BY r.selection_rank ASC NULLS LAST,
             r.selection_score DESC NULLS LAST,
             r.ai_score DESC
    LIMIT ${Math.max(1, Math.min(MAX_NEW_PER_RUN, Number(maxNew) || MAX_NEW_PER_RUN))}
  `;

  return generateUpdates(sql, candidates, { autoPublish, generatedBy: 'autopilot-live-v2' });
}

export async function syncLiveUpdatesFromRecentRadar({
  autoPublish = true,
  minScore = 60,
  maxNew = MAX_NEW_PER_RUN,
  job = null,
} = {}) {
  const sql = db();
  await ensureLiveUpdateSchema(sql);
  await ensureLiveFreshnessSchema(sql);
  const threshold = Math.max(55, Math.min(85, Number(minScore) || 60));
  const limit = Math.max(1, Math.min(6, Number(maxNew) || MAX_NEW_PER_RUN));

  const candidates = await sql`
    SELECT r.id, r.title, r.summary, r.ai_score, r.ai_section, r.ai_reason,
           r.source_name, r.source_domain, r.source_kind, r.url, r.published_at,
           r.live_source_published_at, r.live_source_checked_at, r.live_source_fresh,
           COALESCE(r.event_key, r.local_event_key) AS event_key,
           r.attention_score, r.local_priority, r.candidate_type,
           NULL::INT AS selection_rank, r.ai_score AS selection_score,
           EXTRACT(EPOCH FROM (NOW() - r.published_at)) / 60.0 AS age_minutes
    FROM radar_items r
    WHERE r.local_triage_status = 'candidate'
      AND r.ai_score >= ${threshold}
      AND COALESCE(r.next_step, 'overvak') <> 'ignorer'
      AND r.published_at IS NOT NULL
      AND r.published_at >= NOW() - interval '2 hours'
      AND r.ai_scored_at >= NOW() - interval '2 hours'
      AND (
        r.ai_score >= 70
        OR COALESCE(r.attention_score, 0) >= 45
        OR r.candidate_type IN ('breaking', 'resultat', 'oppkjøp', 'renter', 'makro', 'markedsbevegelse')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM feed f
        WHERE f.radar_item_id = r.id
           OR (
             COALESCE(r.event_key, r.local_event_key) IS NOT NULL
             AND f.event_key = COALESCE(r.event_key, r.local_event_key)
             AND f.tidspunkt >= NOW() - interval '8 hours'
           )
      )
    ORDER BY r.published_at DESC,
             r.attention_score DESC NULLS LAST,
             r.ai_score DESC,
             r.local_priority DESC NULLS LAST
    LIMIT ${limit}
  `;

  return generateUpdates(sql, candidates, { autoPublish, generatedBy: 'live-pulse-v1', job });
}

export async function linkLiveUpdateToArticle(sql, radarItemId, articleId) {
  if (!radarItemId || !articleId) return;
  await ensureLiveUpdateSchema(sql);
  await sql`
    UPDATE feed
    SET article_id = ${Number(articleId)}
    WHERE radar_item_id = ${Number(radarItemId)}
  `;
}
