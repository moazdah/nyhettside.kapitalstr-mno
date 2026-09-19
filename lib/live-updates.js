import { db } from './db';
import { deepSeekJsonRequest } from './ai/deepseek-client';

const MODEL = 'deepseek-v4-pro';
const MAX_ACTIVE_UPDATES = 12;
const MAX_NEW_PER_RUN = 4;
let schemaReady = false;

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

export async function ensureLiveUpdateSchema(sql = db()) {
  if (schemaReady) return;

  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS headline TEXT`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS summary TEXT`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS source_url TEXT`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS source_name TEXT`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS radar_item_id BIGINT`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS article_id BIGINT`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS priority NUMERIC`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS event_key TEXT`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS generated_by TEXT`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ`;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_radar_item
    ON feed (radar_item_id)
    WHERE radar_item_id IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_feed_live_time
    ON feed (status, tidspunkt DESC)
  `;

  schemaReady = true;
}

async function trimActiveFeed(sql) {
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

export async function syncLiveUpdatesForRun(runId, {
  autoPublish = true,
  maxNew = MAX_NEW_PER_RUN,
} = {}) {
  const sql = db();
  await ensureLiveUpdateSchema(sql);

  const candidates = await sql`
    SELECT r.id, r.title, r.summary, r.ai_score, r.ai_section, r.ai_reason,
           r.source_name, r.source_domain, r.url, r.event_key,
           r.selection_rank, r.selection_score,
           COALESCE(r.published_at, r.discovered_at) AS source_time
    FROM radar_items r
    WHERE r.autopilot_run_id = ${Number(runId)}
      AND r.ai_score >= 70
      AND COALESCE(r.published_at, r.discovered_at) >= NOW() - interval '18 hours'
      AND NOT EXISTS (
        SELECT 1
        FROM feed f
        WHERE f.radar_item_id = r.id
           OR (
             r.event_key IS NOT NULL
             AND f.event_key = r.event_key
             AND f.tidspunkt >= NOW() - interval '12 hours'
           )
      )
    ORDER BY r.selection_rank ASC NULLS LAST,
             r.selection_score DESC NULLS LAST,
             r.ai_score DESC
    LIMIT ${Math.max(1, Math.min(MAX_NEW_PER_RUN, Number(maxNew) || MAX_NEW_PER_RUN))}
  `;

  if (!candidates.length) {
    await trimActiveFeed(sql);
    return { requested: 0, created: 0, status: autoPublish ? 'live' : 'draft', errors: [] };
  }

  const system = `Du er deskjournalist i Kapitalstrøm, en norsk finans- og økonominyhetsside.
Du skal lage KORTE live-oppdateringer fra ferdig filtrerte nyhetstreff.

Regler:
- Skriv på naturlig norsk bokmål.
- Bruk KUN fakta som finnes i input. Ikke legg til tall, kursreaksjoner, sitater eller årsaker som ikke står der.
- Vær nøytral, konkret og journalistisk.
- headline: kort og informativ, normalt 45–105 tegn.
- summary: 1–2 korte setninger, normalt 90–260 tegn. Den skal tilføre forklaring, ikke gjenta overskriften.
- Ingen clickbait, ingen råd om kjøp/salg, ingen "AI"-språk.
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
  }));

  let result;
  try {
    result = await deepSeekJsonRequest({
      system,
      user: JSON.stringify(payload),
      model: MODEL,
      maxTokens: 1600,
      thinking: false,
      temperature: 0.15,
      timeoutMs: 35000,
      retries: 1,
      label: 'DeepSeek kort nyhetsstrøm',
    });
  } catch (error) {
    return {
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

    const headline = clean(item.headline, 140);
    const summary = clean(item.summary, 420);
    if (!headline || !summary) {
      errors.push(`Radar ${id}: manglet overskrift eller forklaring.`);
      continue;
    }

    const inserted = await sql`
      INSERT INTO feed (
        tekst, headline, summary, seksjon, tidspunkt, status,
        source_url, source_name, radar_item_id, priority,
        event_key, generated_by
      )
      SELECT
        ${headline}, ${headline}, ${summary}, ${source.ai_section || 'Markeder'}, NOW(),
        ${autoPublish ? 'live' : 'draft'},
        ${source.url || null}, ${source.source_name || source.source_domain || null},
        ${id}, ${Number(source.selection_score || source.ai_score || 0)},
        ${source.event_key || null}, 'autopilot-live-v1'
      WHERE NOT EXISTS (
        SELECT 1 FROM feed WHERE radar_item_id = ${id}
      )
      RETURNING id
    `;
    created += inserted.length;
  }

  await trimActiveFeed(sql);

  const usage = result?.usage || {};
  const tokensIn = Number(usage.prompt_tokens || 0);
  const tokensOut = Number(usage.completion_tokens || 0);
  if (tokensIn || tokensOut) {
    await sql`
      INSERT INTO ai_usage (steg, modell, tokens_inn, tokens_ut, kostnad_usd)
      VALUES (
        'live-updates',
        ${MODEL},
        ${tokensIn},
        ${tokensOut},
        ${estimateCostUsd(usage)}
      )
    `;
  }

  return {
    requested: candidates.length,
    created,
    status: autoPublish ? 'live' : 'draft',
    errors,
  };
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
