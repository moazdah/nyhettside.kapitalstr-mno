import { createHash } from 'crypto';
import { db } from '../db';
import { ensureRadarSchema } from './news-radar';

export const RADAR_MODEL_TAG = 'deepseek-flash/radar-v4';
export const MAX_AI_EVENT_CANDIDATES = 45;
const WINDOW_HOURS = 36;

const TRUSTED_DOMAINS = new Set([
  'reuters.com','ft.com','cnbc.com','wsj.com','bloomberg.com','bbc.com','apnews.com',
  'finance.yahoo.com','yahoo.com','dn.no','e24.no','finansavisen.no','economist.com',
  'federalreserve.gov','ecb.europa.eu','boj.or.jp','norges-bank.no','ssb.no',
  'sec.gov','live.euronext.com','newsweb.no',
]);

const MAJOR_COMPANY = [
  /\b(nvidia|apple|microsoft|alphabet|google|amazon|meta|tesla|broadcom|amd|oracle|netflix|salesforce)\b/i,
  /\b(tsmc|taiwan semiconductor|asml|samsung electronics|softbank|toyota)\b/i,
  /\b(novo nordisk|eli lilly|roche|novartis|astrazeneca|pfizer|merck)\b/i,
  /\b(jpmorgan|goldman sachs|morgan stanley|bank of america|citigroup|ubs|hsbc|deutsche bank)\b/i,
  /\b(berkshire hathaway|exxon|chevron|shell|bp|totalenergies|aramco|boeing|airbus|lvmh|sap)\b/i,
  /\b(equinor|dnb|telenor|yara|kongsberg gruppen|aker bp|mowi|salmar|norsk hydro|orkla|gjensidige)\b/i,
];

const CORPORATE_FINANCE = [
  /\b(quarterly results|quarterly earnings|earnings report|earnings call|annual results|årsresultat|kvartalstall|resultatrapport)\b/i,
  /\b(revenue|sales growth|net income|operating profit|ebitda|ebit|eps|free cash flow|margin|omsetning|driftsresultat|resultat per aksje)\b/i,
  /\b(profit warning|cuts? guidance|raises? guidance|guidance cut|guidance raise|outlook cut|outlook raised|resultatvarsel)\b/i,
  /\b(acquisition|takeover|merger|buyout|oppkjøp|fusjon|bud på|overtakelse)\b/i,
  /\b(ipo|capital raise|rights issue|share issue|emission|emisjon|buyback|share repurchase|tilbakekjøp|dividend|utbytte)\b/i,
  /\b(bankruptcy|chapter 11|default|restructuring|insolvency|konkurs|rekonstruksjon|betalingsstans)\b/i,
  /\b(contract worth|order worth|order backlog|major contract|kontrakt verdt|milliardkontrakt|ordrebok)\b/i,
];

const MARKET_MACRO = [
  /\b(federal reserve|\bfed\b|fomc|ecb|european central bank|bank of japan|\bboj\b|bank of england|norges bank)\b/i,
  /\b(rate cut|rate hike|interest rate decision|policy rate|rentekutt|renteheving|styringsrente|rentebeslutning)\b/i,
  /\b(inflation|\bcpi\b|\bpce\b|nonfarm|payrolls|jobs report|unemployment|\bgdp\b|\bpmi\b|inflasjon|kpi|jobbtall|arbeidsledighet|bnp)\b/i,
  /\b(brent|crude oil|opec|oil price|natural gas|gold price|copper price|oljepris|gasspris)\b/i,
  /\b(s&p 500|nasdaq|dow jones|stoxx 600|oslo børs|euronext|wall street)\b/i,
  /\b(bitcoin|ethereum|crypto market|kryptomarked)\b/i,
  /\b(yield|bond market|treasury yield|statsrente|obligasjonsmarked|credit spread)\b/i,
  /\b(tariffs?|sanctions?|trade war|tollsatser|sanksjoner)\b/i,
];

const BASIC_FINANCE = [
  /\b(aksje|aksjen|aksjer|børs|analytiker|kursmål|meglerhus|investor|utbytte|obligasjon|valuta|krone|dollar|euro)\b/i,
  /\b(stock|shares?|analyst|price target|investor|dividend|bond|currency|dollar|euro|market cap)\b/i,
];

const MARKET_MOVE = [
  /\b(shares?|stock)\s+(?:surge|jump|soar|rally|plunge|slump|tumble|drop|fall|rise)s?\b/i,
  /\b(record high|record low|all-time high|selloff|market rally|stuper|skyter fart|rekordhøy)\b/i,
  /\b(up|down)\s+\d+(?:[.,]\d+)?\s*%\b/i,
];

const ATTENTION = [
  /\b(billion|trillion|milliard|billion-dollar|largest|biggest|record|historic|rekord|største|historisk)\b/i,
  /\b(ceo|cfo|chairman|founder|grunnlegger)\b.*\b(resigns?|steps down|fired|sparket|går av)\b/i,
  /\b(unexpected|surprise|uventet|overrasker)\b/i,
];

const NOISE = [
  /\b(teacher|teachers|student|students|school|museum|museums|medical students?|specialty choice|education guidance|career guidance)\b/i,
  /\b(reise|ferie|restaurant|recipe|oppskrift|football|soccer|premier league|sport|celebrity|kjendis|movie|film|music|musikk)\b/i,
  /\b(human remains guidance|certification investigations|research integrity|practice guidance)\b/i,
];

const STOP = new Set([
  'the','and','for','with','from','after','before','into','over','under','about','says','say','new','amid',
  'of','to','in','on','at','as','a','an','is','are','was','were','be','by','its','it','this','that',
  'og','for','med','fra','etter','før','over','under','om','til','av','i','på','er','som','en','et','den','det',
  'shares','share','stock','stocks','market','markets','company','companies','selskaper','selskap','aksjen','aksjer',
]);

function count(text, patterns) {
  return patterns.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
}

function domainBase(value = '') {
  return String(value).toLowerCase().replace(/^www\./, '');
}

function sourceRank(item) {
  const kind = String(item.source_kind || '').toLowerCase();
  const domain = domainBase(item.source_domain);
  if (kind.includes('official')) return 22;
  if (TRUSTED_DOMAINS.has(domain)) return 18;
  if (kind === 'global-rss') return 14;
  if (kind === 'rss') return 11;
  if (kind === 'news-index') return 8;
  if (kind === 'news-aggregator') return 4;
  return 6;
}

function normalize(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/bank of japan|\bboj\b/g, 'bankjapan')
    .replace(/federal reserve|\bfed\b|\bfomc\b/g, 'federalreserve')
    .replace(/european central bank|\becb\b/g, 'ecb')
    .replace(/bank of england|\bboe\b/g, 'bankengland')
    .replace(/raises?|raised|hikes?|hiked|hever|hevet|oker|øker/g, ' raise ')
    .replace(/cuts?|cutting|senker|senket|kutter|kuttet/g, ' cut ')
    .replace(/earnings|quarterly results|annual results|resultater|kvartalstall/g, ' earnings ')
    .replace(/acquisition|takeover|merger|oppkjop|oppkjøp|fusjon/g, ' deal ')
    .replace(/guidance|outlook|forecast|prognose/g, ' guidance ')
    .replace(/resigns?|steps down|gar av|går av/g, ' resign ')
    .replace(/[^a-z0-9æøå]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return new Set(normalize(value).split(' ').filter((token) => token.length >= 3 && !STOP.has(token)));
}

function similarity(a, b) {
  const aa = tokens(a);
  const bb = tokens(b);
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const token of aa) if (bb.has(token)) common += 1;
  const containment = common / Math.min(aa.size, bb.size);
  const jaccard = common / new Set([...aa, ...bb]).size;
  return Math.max(containment, jaccard * 1.35);
}

function localPriority(item) {
  const text = `${item.title || ''} ${item.summary || ''}`;
  const corporate = count(text, CORPORATE_FINANCE);
  const macro = count(text, MARKET_MACRO);
  const company = count(text, MAJOR_COMPANY);
  const basic = count(text, BASIC_FINANCE);
  const move = count(text, MARKET_MOVE);
  const attention = count(text, ATTENTION);
  const noise = count(text, NOISE);
  const source = sourceRank(item);

  let score = source;
  score += Math.min(42, corporate * 24);
  score += Math.min(36, macro * 22);
  score += company ? 24 : 0;
  score += Math.min(16, basic * 8);
  score += move ? 18 : 0;
  score += Math.min(14, attention * 8);
  score -= Math.min(70, noise * 45);

  const financeDeskSource = /Aksjetips|Børs og finans|Yahoo Finance|CNBC|WSJ|Financial Times|Reuters|Bloomberg/i.test(String(item.source_name || ''));
  const explicitFinance = corporate > 0
    || macro > 0
    || move > 0
    || (basic > 0 && (financeDeskSource || source >= 14))
    || (company > 0 && /\b(revenue|profit|eps|margin|guidance|shares?|stock|deal|acquisition|earnings|results?)\b/i.test(text));
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    explicitFinance,
    noise,
  };
}

function representativeValue(item) {
  return Number(item.local_priority || 0) + sourceRank(item) * 1.4;
}

function clusterKey(cluster) {
  const title = normalize(cluster.representative.title)
    .split(' ')
    .filter((token) => token.length >= 3 && !STOP.has(token))
    .slice(0, 10)
    .join('-');
  const date = new Date(cluster.representative.published_at || cluster.representative.discovered_at || Date.now());
  const day = Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString().slice(0, 10);
  return createHash('sha1').update(`${day}|${title}`).digest('hex').slice(0, 20);
}

function clusterItems(items) {
  const clusters = [];
  for (const item of items) {
    let best = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      const score = Math.max(...cluster.items.map((member) => similarity(item.title, member.title)));
      if (score > bestScore) {
        best = cluster;
        bestScore = score;
      }
    }

    const itemDate = new Date(item.published_at || item.discovered_at || 0).getTime();
    const repDate = best ? new Date(best.representative.published_at || best.representative.discovered_at || 0).getTime() : 0;
    const close = best && Math.abs(itemDate - repDate) <= 24 * 3600 * 1000;

    if (best && ((bestScore >= 0.70) || (bestScore >= 0.52 && close))) {
      best.items.push(item);
      if (representativeValue(item) > representativeValue(best.representative)) best.representative = item;
      best.priority = Math.max(best.priority, Number(item.local_priority || 0));
    } else {
      clusters.push({ items: [item], representative: item, priority: Number(item.local_priority || 0) });
    }
  }

  for (const cluster of clusters) {
    const domains = new Set(cluster.items.map((x) => domainBase(x.source_domain)).filter(Boolean));
    cluster.size = cluster.items.length;
    cluster.priority = Math.min(100, cluster.priority + Math.min(16, Math.max(0, cluster.size - 1) * 3) + Math.min(10, Math.max(0, domains.size - 1) * 2));
    cluster.key = clusterKey(cluster);
  }
  return clusters;
}

export async function ensureLocalTriageSchema(sql = db()) {
  await ensureRadarSchema(sql);
  await sql`ALTER TABLE radar_items ADD COLUMN IF NOT EXISTS local_triage_status TEXT`;
  await sql`ALTER TABLE radar_items ADD COLUMN IF NOT EXISTS local_priority INT`;
  await sql`ALTER TABLE radar_items ADD COLUMN IF NOT EXISTS local_event_key TEXT`;
  await sql`ALTER TABLE radar_items ADD COLUMN IF NOT EXISTS local_cluster_size INT`;
  await sql`ALTER TABLE radar_items ADD COLUMN IF NOT EXISTS local_representative_id BIGINT`;
  await sql`ALTER TABLE radar_items ADD COLUMN IF NOT EXISTS local_triaged_at TIMESTAMPTZ`;
  await sql`CREATE INDEX IF NOT EXISTS idx_radar_local_triage ON radar_items (local_triage_status, local_priority DESC, discovered_at DESC)`;
}

export async function prepareRadarCandidates(sql = db(), options = {}) {
  await ensureLocalTriageSchema(sql);
  const maxCandidates = Math.max(10, Math.min(80, Number(options.maxCandidates || MAX_AI_EVENT_CANDIDATES)));

  const rows = await sql`
    SELECT id, source_name, source_domain, source_kind, title, summary,
           published_at, discovered_at, ai_model, ai_score
    FROM radar_items
    WHERE COALESCE(published_at, discovered_at) >= now() - (${WINDOW_HOURS} * interval '1 hour')
      AND (ai_score IS NULL OR ai_model IS DISTINCT FROM ${RADAR_MODEL_TAG})
    ORDER BY published_at DESC NULLS LAST, discovered_at DESC
    LIMIT 500
  `;

  const relevant = [];
  const noiseIds = [];

  for (const row of rows) {
    const local = localPriority(row);
    row.local_priority = local.score;
    if (!local.explicitFinance || local.noise > 0 && local.score < 45 || local.score < 22) {
      noiseIds.push(Number(row.id));
    } else {
      relevant.push(row);
    }
  }

  const clusters = clusterItems(relevant)
    .sort((a, b) => b.priority - a.priority);

  const selectedClusters = clusters.slice(0, maxCandidates);
  const selectedIds = new Set(selectedClusters.map((cluster) => Number(cluster.representative.id)));
  const updates = [];
  let duplicateCount = 0;
  let overflowCount = 0;

  for (const cluster of clusters) {
    const isSelected = selectedIds.has(Number(cluster.representative.id));
    const representativeId = Number(cluster.representative.id);

    for (const item of cluster.items) {
      const id = Number(item.id);
      let status;
      if (id === representativeId) status = isSelected ? 'candidate' : 'overflow';
      else {
        status = 'duplicate';
        duplicateCount += 1;
      }
      if (status === 'overflow') overflowCount += 1;

      updates.push({
        id,
        status,
        priority: Number(item.local_priority || 0),
        event_key: cluster.key,
        cluster_size: cluster.size,
        representative_id: representativeId,
      });
    }
  }

  for (const id of noiseIds) {
    updates.push({
      id,
      status: 'noise',
      priority: 0,
      event_key: null,
      cluster_size: 1,
      representative_id: id,
    });
  }

  if (updates.length) {
    await sql`
      UPDATE radar_items AS r
      SET local_triage_status = x.status,
          local_priority = x.priority,
          local_event_key = x.event_key,
          local_cluster_size = x.cluster_size,
          local_representative_id = x.representative_id,
          local_triaged_at = now()
      FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb)
        AS x(
          id BIGINT,
          status TEXT,
          priority INT,
          event_key TEXT,
          cluster_size INT,
          representative_id BIGINT
        )
      WHERE r.id = x.id
    `;
  }

  return {
    scanned: rows.length,
    relevant: relevant.length,
    clusters: clusters.length,
    candidates: selectedClusters.length,
    duplicates: duplicateCount,
    noise: noiseIds.length,
    overflow: overflowCount,
  };
}
