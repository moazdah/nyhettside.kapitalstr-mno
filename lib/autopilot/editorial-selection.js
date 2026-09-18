import { createHash } from 'crypto';
import { db } from '../db';
import { ensureRadarSchema } from '../radar/news-radar';

export const RADAR_MODEL_TAG = 'deepseek-flash/radar-v3';
export const AUTO_SELECTION_MIN_SCORE = 70;
export const AUTO_SELECTION_LIMIT = 3;

const TRUSTED_NEWS_DOMAINS = new Set([
  'reuters.com','www.reuters.com','ft.com','www.ft.com','cnbc.com','www.cnbc.com',
  'wsj.com','www.wsj.com','bloomberg.com','www.bloomberg.com','bbc.com','www.bbc.com',
  'apnews.com','www.apnews.com','dn.no','www.dn.no','e24.no','www.e24.no',
]);

const STOP = new Set([
  'the','and','for','with','from','after','into','over','under','about','says','say','new',
  'of','to','in','on','at','as','a','an','is','are','was','were','be','by',
  'og','for','med','fra','etter','over','under','om','til','av','i','på','er','som','en','et','den','det',
  'shares','stock','stocks','market','markets','company','selskaper','aksjen','aksjer',
]);

export async function ensureEditorialSelectionSchema(sql = db()) {
  await ensureRadarSchema(sql);

  await sql`
    CREATE TABLE IF NOT EXISTS editorial_runs (
      id BIGSERIAL PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'running',
      selection_limit INT NOT NULL DEFAULT 3,
      selected_count INT NOT NULL DEFAULT 0,
      discovery_done BOOLEAN NOT NULL DEFAULT FALSE,
      selection_done BOOLEAN NOT NULL DEFAULT FALSE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      notes JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `;

  await sql`ALTER TABLE radar_items ADD COLUMN IF NOT EXISTS event_key TEXT`;
  await sql`ALTER TABLE radar_items ADD COLUMN IF NOT EXISTS event_group_title TEXT`;
  await sql`ALTER TABLE radar_items ADD COLUMN IF NOT EXISTS event_cluster_size INT`;
  await sql`ALTER TABLE radar_items ADD COLUMN IF NOT EXISTS autopilot_run_id BIGINT`;
  await sql`ALTER TABLE radar_items ADD COLUMN IF NOT EXISTS autopilot_selected_at TIMESTAMPTZ`;
  await sql`ALTER TABLE radar_items ADD COLUMN IF NOT EXISTS selection_rank INT`;
  await sql`ALTER TABLE radar_items ADD COLUMN IF NOT EXISTS selection_score NUMERIC`;

  await sql`CREATE INDEX IF NOT EXISTS idx_radar_event_key ON radar_items (event_key)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_radar_autopilot_run ON radar_items (autopilot_run_id, selection_rank)`;
}

export async function createEditorialRun(sql = db(), mode = 'manual') {
  await ensureEditorialSelectionSchema(sql);
  const [run] = await sql`
    INSERT INTO editorial_runs (mode, selection_limit)
    VALUES (${mode}, ${AUTO_SELECTION_LIMIT})
    RETURNING id, selection_limit
  `;
  return run;
}

export async function getEditorialRun(sql, runId) {
  if (!runId) return null;
  const [run] = await sql`
    SELECT id, mode, status, selection_limit, selected_count,
           discovery_done, selection_done, started_at, finished_at
    FROM editorial_runs
    WHERE id = ${Number(runId)}
    LIMIT 1
  `;
  return run || null;
}

export async function markDiscoveryDone(sql, runId) {
  if (!runId) return;
  await sql`
    UPDATE editorial_runs
    SET discovery_done = true
    WHERE id = ${Number(runId)}
  `;
}

export async function finishEditorialRun(sql, runId) {
  if (!runId) return;
  await sql`
    UPDATE editorial_runs
    SET status = 'done', finished_at = COALESCE(finished_at, now())
    WHERE id = ${Number(runId)}
  `;
}

function normalizeEventText(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/bank of japan|\bboj\b/g, 'bankjapan')
    .replace(/federal reserve|\bfed\b|\bfomc\b/g, 'federalreserve')
    .replace(/bank of england|\bboe\b/g, 'bankengland')
    .replace(/european central bank|\becb\b/g, 'ecb')
    .replace(/raises?|raised|hikes?|hiked|lifts?|lifted|hever|hevet|oker|øker/g, ' raise ')
    .replace(/cuts?|cutting|senker|senket|kutter|kuttet/g, ' cut ')
    .replace(/steps? down|resigns?|resigned|gar av|går av/g, ' resign ')
    .replace(/takes? over|succeeds?|overtar|tar over/g, ' succeed ')
    .replace(/earnings|quarterly results|results|resultater|kvartalstall/g, ' earnings ')
    .replace(/acquisition|takeover|merger|oppkjop|oppkjøp/g, ' deal ')
    .replace(/guidance|outlook|forecast|prognose/g, ' guidance ')
    .replace(/[^a-z0-9æøå]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function eventTokens(value) {
  return new Set(
    normalizeEventText(value)
      .split(' ')
      .filter((token) => token.length >= 3 && !STOP.has(token))
  );
}

function eventSimilarity(a, b) {
  const aa = eventTokens(a);
  const bb = eventTokens(b);
  if (!aa.size || !bb.size) return 0;

  let common = 0;
  for (const token of aa) if (bb.has(token)) common += 1;

  const minSize = Math.min(aa.size, bb.size);
  const union = new Set([...aa, ...bb]).size;
  const containment = common / minSize;
  const jaccard = common / union;
  return Math.max(containment, jaccard * 1.35);
}

function sameEvent(a, b) {
  const similarity = eventSimilarity(a.title, b.title);
  const closeInTime = Math.abs(
    new Date(a.published_at || a.discovered_at).getTime()
    - new Date(b.published_at || b.discovered_at).getTime()
  ) <= 18 * 3600 * 1000;

  if (similarity >= 0.72) return true;
  if (closeInTime && similarity >= 0.52) return true;

  const aa = eventTokens(a.title);
  const bb = eventTokens(b.title);
  let common = 0;
  for (const token of aa) if (bb.has(token)) common += 1;

  const sameSection = a.ai_section && b.ai_section && a.ai_section === b.ai_section;
  return closeInTime && sameSection && common >= 3;
}

function sourceRank(item) {
  const domain = String(item.source_domain || '').toLowerCase();
  const kind = String(item.source_kind || '').toLowerCase();
  if (kind.includes('official')) return 6;
  if (TRUSTED_NEWS_DOMAINS.has(domain)) return 5;
  if (kind === 'global-rss') return 4;
  if (kind === 'rss') return 3;
  if (kind === 'news-aggregator') return 1;
  return 2;
}

function editorialPriority(item) {
  const score = Number(item.ai_score || 0);
  const attention = Number(item.attention_score || 0);
  const numbers = Number(item.numbers_score || 0);
  return (score * 0.58) + (attention * 0.27) + (numbers * 0.15);
}

function representativeScore(item) {
  return editorialPriority(item) + sourceRank(item) * 2.5;
}

function eventKey(cluster) {
  const representative = cluster.representative;
  const normalized = normalizeEventText(representative.title)
    .split(' ')
    .filter((x) => x.length >= 3 && !STOP.has(x))
    .slice(0, 8)
    .join('-');
  const sourceDate = new Date(representative.published_at || representative.discovered_at || Date.now());
  const day = Number.isNaN(sourceDate.getTime()) ? 'unknown-day' : sourceDate.toISOString().slice(0, 10);
  return createHash('sha1').update(`${day}|${normalized}`).digest('hex').slice(0, 18);
}

function buildClusters(items) {
  const clusters = [];

  for (const item of items) {
    let best = null;
    let bestSimilarity = 0;

    for (const cluster of clusters) {
      const similarity = Math.max(...cluster.items.map((member) => eventSimilarity(item.title, member.title)));
      if (similarity > bestSimilarity && sameEvent(item, cluster.representative)) {
        best = cluster;
        bestSimilarity = similarity;
      }
    }

    if (best) {
      best.items.push(item);
      if (representativeScore(item) > representativeScore(best.representative)) {
        best.representative = item;
      }
      best.priority = Math.max(best.priority, editorialPriority(item));
      best.maxScore = Math.max(best.maxScore, Number(item.ai_score || 0));
      best.covered = best.covered || Boolean(item.has_article);
    } else {
      clusters.push({
        items: [item],
        representative: item,
        priority: editorialPriority(item),
        maxScore: Number(item.ai_score || 0),
        covered: Boolean(item.has_article),
      });
    }
  }

  for (const cluster of clusters) {
    cluster.key = eventKey(cluster);
    cluster.title = cluster.representative.title;
    cluster.size = cluster.items.length;
  }
  return clusters;
}

export async function selectTopEventsForRun(sql, runId) {
  await ensureEditorialSelectionSchema(sql);
  const run = await getEditorialRun(sql, runId);
  if (!run) throw new Error('Fant ikke autopilot-kjøringen.');

  if (run.selection_done) {
    const selected = await sql`
      SELECT id, title, selection_rank, selection_score, event_key, event_group_title, event_cluster_size
      FROM radar_items
      WHERE autopilot_run_id = ${Number(runId)}
      ORDER BY selection_rank ASC
    `;
    return { selected, clusters: 0, alreadyDone: true };
  }

  const candidates = await sql`
    SELECT r.id, r.title, r.summary, r.source_name, r.source_domain, r.source_kind,
           r.published_at, r.discovered_at, r.ai_score, r.ai_section, r.candidate_type,
           r.attention_score, r.numbers_score,
           EXISTS (
             SELECT 1 FROM articles a
             WHERE a.radar_item_id = r.id
               AND a.status IN ('draft', 'live')
           ) AS has_article
    FROM radar_items r
    WHERE r.ai_model = ${RADAR_MODEL_TAG}
      AND r.ai_score >= 60
      AND COALESCE(r.published_at, r.discovered_at) >= now() - interval '36 hours'
    ORDER BY r.ai_score DESC, r.attention_score DESC NULLS LAST, r.published_at DESC NULLS LAST
    LIMIT 220
  `;

  const clusters = buildClusters(candidates);

  for (const cluster of clusters.filter((group) => group.size > 1)) {
    const ids = cluster.items.map((item) => Number(item.id));
    await sql`
      UPDATE radar_items
      SET event_key = ${cluster.key},
          event_group_title = ${cluster.title},
          event_cluster_size = ${cluster.size}
      WHERE id = ANY(${ids}::bigint[])
    `;
  }

  const eligible = clusters
    .filter((cluster) => !cluster.covered && cluster.maxScore >= AUTO_SELECTION_MIN_SCORE)
    .sort((a, b) => b.priority - a.priority);

  const selectedClusters = [];
  const sectionCount = new Map();

  for (const cluster of eligible) {
    if (selectedClusters.length >= Number(run.selection_limit || AUTO_SELECTION_LIMIT)) break;
    const section = cluster.representative.ai_section || 'Markeder';
    const count = sectionCount.get(section) || 0;
    const hasAlternativeSection = eligible.some(
      (other) => !selectedClusters.includes(other) && (other.representative.ai_section || 'Markeder') !== section
    );
    if (count >= 2 && hasAlternativeSection) continue;

    selectedClusters.push(cluster);
    sectionCount.set(section, count + 1);
  }

  for (let index = 0; index < selectedClusters.length; index += 1) {
    const cluster = selectedClusters[index];
    const item = cluster.representative;
    await sql`
      UPDATE radar_items
      SET autopilot_run_id = ${Number(runId)},
          autopilot_selected_at = now(),
          selection_rank = ${index + 1},
          selection_score = ${cluster.priority},
          event_key = ${cluster.key},
          event_group_title = ${cluster.title},
          event_cluster_size = ${cluster.size}
      WHERE id = ${Number(item.id)}
    `;
  }

  await sql`
    UPDATE editorial_runs
    SET selection_done = true,
        selected_count = ${selectedClusters.length}
    WHERE id = ${Number(runId)}
  `;

  return {
    selected: selectedClusters.map((cluster, index) => ({
      id: Number(cluster.representative.id),
      title: cluster.title,
      rank: index + 1,
      priority: Math.round(cluster.priority * 10) / 10,
      clusterSize: cluster.size,
      eventKey: cluster.key,
    })),
    clusters: clusters.length,
    alreadyDone: false,
  };
}
