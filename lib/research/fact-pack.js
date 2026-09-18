import { createHash } from 'crypto';
import { db } from '../db';
import { ensureRadarSchema } from '../radar/news-radar';
import { deepSeekJsonRequest } from '../ai/deepseek-client';

const MODEL = 'deepseek-flash';
const FACT_PACK_VERSION = 'fact-pack-v7';

const TRUSTED_PRIMARY_DOMAINS = new Set([
  'live.euronext.com',
  'euronext.com',
  'www.euronext.com',
  'newsweb.no',
  'www.newsweb.no',
  'norges-bank.no',
  'www.norges-bank.no',
  'data.norges-bank.no',
  'ssb.no',
  'www.ssb.no',
  'finanstilsynet.no',
  'www.finanstilsynet.no',
  'regjeringen.no',
  'www.regjeringen.no',
  'federalreserve.gov',
  'www.federalreserve.gov',
  'ecb.europa.eu',
  'www.ecb.europa.eu',
  'boj.or.jp',
  'www.boj.or.jp',
  'opec.org',
  'www.opec.org',
  'sec.gov',
  'www.sec.gov',
]);

const TRUSTED_SECONDARY_DOMAINS = new Map([
  ['dn.no', 'Dagens Næringsliv'],
  ['www.dn.no', 'Dagens Næringsliv'],
  ['e24.no', 'E24'],
  ['www.e24.no', 'E24'],
  ['finansavisen.no', 'Finansavisen'],
  ['www.finansavisen.no', 'Finansavisen'],
  ['reuters.com', 'Reuters'],
  ['www.reuters.com', 'Reuters'],
  ['bloomberg.com', 'Bloomberg'],
  ['www.bloomberg.com', 'Bloomberg'],
  ['ft.com', 'Financial Times'],
  ['www.ft.com', 'Financial Times'],
  ['cnbc.com', 'CNBC'],
  ['www.cnbc.com', 'CNBC'],
  ['wsj.com', 'The Wall Street Journal'],
  ['www.wsj.com', 'The Wall Street Journal'],
  ['apnews.com', 'AP'],
  ['www.apnews.com', 'AP'],
  ['nrk.no', 'NRK'],
  ['www.nrk.no', 'NRK'],
]);


const GENERIC_OFFICIAL_HOST_PATTERNS = [
  /(^|\.)gov\./i,
  /(^|\.)gov$/i,
  /(^|\.)europa\.eu$/i,
  /(^|\.)ecb\.europa\.eu$/i,
  /(^|\.)sec\.gov$/i,
  /(^|\.)ssb\.no$/i,
  /(^|\.)norges-bank\.no$/i,
  /(^|\.)finanstilsynet\.no$/i,
];

const CORPORATE_PRIMARY_PATH_PATTERNS = [
  /\/investor/i,
  /\/investors/i,
  /\/investor-relations/i,
  /\/ir\//i,
  /\/news/i,
  /\/newsroom/i,
  /\/press/i,
  /\/media/i,
  /\/releases?/i,
  /\/announcements?/i,
  /\/reports?/i,
  /\/results?/i,
];

function isGenericOfficialHost(hostname) {
  return GENERIC_OFFICIAL_HOST_PATTERNS.some((re) => re.test(String(hostname || '')));
}

function hasCorporatePrimaryPath(url) {
  try {
    const parsed = new URL(url);
    return CORPORATE_PRIMARY_PATH_PATTERNS.some((re) => re.test(parsed.pathname));
  } catch {
    return false;
  }
}

function sourceRoleFromUrl(url, item) {
  try {
    const parsed = new URL(url);
    if (isTrustedPrimaryUrl(url) || isGenericOfficialHost(parsed.hostname)) {
      return { role: 'primary', quality: 'official' };
    }
    if (isLikelyCorporatePrimaryUrl(url, item) || hasCorporatePrimaryPath(url)) {
      return { role: 'primary', quality: 'corporate_official' };
    }
    const secondary = trustedSecondaryName(url);
    if (secondary) return { role: 'trusted_secondary', quality: 'high' };
    return { role: 'unknown', quality: 'unknown' };
  } catch {
    return { role: 'unknown', quality: 'unknown' };
  }
}

const NORGES_BANK_POLICY_URL = 'https://www.norges-bank.no/tema/pengepolitikk/Styringsrenten/';
const BOJ_POLICY_RELEASES_URL = 'https://www.boj.or.jp/en/mopo/mpmdeci/mpr_2026/';
const FED_POLICY_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const ECB_POLICY_URL = 'https://www.ecb.europa.eu/press/govcdec/mopo/html/index.en.html';

export async function ensureFactPackSchema(sql = db()) {
  await ensureRadarSchema(sql);
  await sql`
    CREATE TABLE IF NOT EXISTS fact_packs (
      id BIGSERIAL PRIMARY KEY,
      radar_item_id BIGINT UNIQUE REFERENCES radar_items(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'needs_source',
      version TEXT NOT NULL DEFAULT 'fact-pack-v1',
      primary_source_name TEXT,
      primary_source_url TEXT,
      source_role TEXT,
      source_quality TEXT,
      source_fetched_at TIMESTAMPTZ,
      source_hash TEXT,
      headline_fact TEXT,
      event_type TEXT,
      facts JSONB NOT NULL DEFAULT '[]'::jsonb,
      numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
      entities JSONB NOT NULL DEFAULT '[]'::jsonb,
      unknowns JSONB NOT NULL DEFAULT '[]'::jsonb,
      market_relevance TEXT,
      analysis_signals JSONB NOT NULL DEFAULT '{}'::jsonb,
      can_write BOOLEAN NOT NULL DEFAULT FALSE,
      confidence INT,
      ai_model TEXT,
      ai_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE fact_packs ADD COLUMN IF NOT EXISTS source_role TEXT`;
  await sql`ALTER TABLE fact_packs ADD COLUMN IF NOT EXISTS source_quality TEXT`;
  await sql`ALTER TABLE fact_packs ADD COLUMN IF NOT EXISTS analysis_signals JSONB NOT NULL DEFAULT '{}'::jsonb`;
  await sql`CREATE INDEX IF NOT EXISTS idx_fact_packs_status ON fact_packs (status, updated_at DESC)`;
}

function normalizeText(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9æøå]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set([
  'og','i','på','til','for','med','av','er','en','et','den','det','de','som','fra','om','etter','mot','skal','har',
  'the','a','an','of','to','in','for','and','on','from','with'
]);

function tokens(value) {
  return new Set(normalizeText(value).split(' ').filter((x) => x.length > 2 && !STOP.has(x)));
}

function titleSimilarity(a, b) {
  const aa = tokens(a);
  const bb = tokens(b);
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const token of aa) if (bb.has(token)) common += 1;
  return common / Math.min(aa.size, bb.size);
}

function domainOf(raw) {
  try { return new URL(raw).hostname.toLowerCase(); } catch { return ''; }
}

function isTrustedPrimaryUrl(url) {
  return TRUSTED_PRIMARY_DOMAINS.has(domainOf(url));
}

function isSpecificPrimaryUrl(url) {
  if (!isTrustedPrimaryUrl(url)) return false;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'live.euronext.com') {
      return /\/company-news\//i.test(parsed.pathname);
    }
    return true;
  } catch {
    return false;
  }
}

function domainBrandToken(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const parts = host.split('.');
    const root = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return normalizeText(root).replace(/\s+/g, '');
  } catch {
    return '';
  }
}

function compactIdentityText(item) {
  return normalizeText([item.title, item.summary].filter(Boolean).join(' ')).replace(/\s+/g, '');
}

function isLikelyCorporatePrimaryUrl(url, item) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

    const brand = domainBrandToken(url);
    if (!brand || brand.length < 4) return false;

    const blocked = new Set([
      'reuters','bloomberg','finansavisen','e24','dn','cnbc','marketwatch',
      'yahoo','google','msn','headtopics','facebook','linkedin','youtube',
      'ft','wsj','apnews','nrk'
    ]);
    if (blocked.has(brand)) return false;

    const identity = compactIdentityText(item);
    const brandMatch = identity.includes(brand);
    const pathLooksOfficial = hasCorporatePrimaryPath(url);

    // Corporate/IR pages are strong candidates when the company/brand appears
    // in the story, or when the URL itself clearly looks like an IR/newsroom page.
    return brandMatch || pathLooksOfficial;
  } catch {
    return false;
  }
}

function isSafePublicHttpUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.local')) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

function extractQuotedPhrases(value) {
  const text = String(value || '');
  const phrases = [];
  for (const match of text.matchAll(/[«"“]([^»"”]{18,180})[»"”]/g)) {
    const phrase = String(match[1] || '').replace(/\s+/g, ' ').trim();
    if (phrase.split(' ').length >= 4) phrases.push(phrase);
  }
  return phrases.slice(0, 2);
}

function trustedSecondaryName(urlOrDomain) {
  const raw = String(urlOrDomain || '');
  const domain = raw.includes('://') ? domainOf(raw) : raw.toLowerCase();
  return TRUSTED_SECONDARY_DOMAINS.get(domain) || null;
}

function trustedSecondaryForItem(item) {
  const name = trustedSecondaryName(item.url) || trustedSecondaryName(item.source_domain);
  if (!name) return null;
  const text = [item.title, item.summary].filter(Boolean).join('. ').replace(/\s+/g, ' ').trim();
  if (text.length < 40) return null;
  return {
    name,
    url: item.url,
    role: 'trusted_secondary',
    quality: 'high',
    text,
  };
}

async function clusterSourceCandidates(sql, item) {
  const rows = item.local_event_key
    ? await sql`
        SELECT id, source_name, source_domain, source_kind, title, summary, url,
               published_at, ai_score, local_event_key
        FROM radar_items
        WHERE local_event_key = ${item.local_event_key}
        ORDER BY
          CASE
            WHEN source_domain IN (
              'reuters.com','www.reuters.com','ft.com','www.ft.com','cnbc.com','www.cnbc.com',
              'bloomberg.com','www.bloomberg.com','wsj.com','www.wsj.com','apnews.com','www.apnews.com',
              'dn.no','www.dn.no','e24.no','www.e24.no','finansavisen.no','www.finansavisen.no'
            ) THEN 0
            ELSE 1
          END,
          ai_score DESC NULLS LAST,
          published_at DESC NULLS LAST
        LIMIT 12
      `
    : [item];

  const candidates = [];
  const seen = new Set();

  for (const row of rows) {
    const exactUrl = String(row.url || '').trim();
    if (!exactUrl || seen.has(exactUrl)) continue;

    const classified = sourceRoleFromUrl(exactUrl, row);
    if (classified.role === 'primary') {
      seen.add(exactUrl);
      candidates.push({
        name: row.source_name || row.source_domain || 'Originalkilde',
        url: exactUrl,
        fallbackText: [row.title, row.summary].filter(Boolean).join('. '),
        method: 'event-cluster-primary',
        role: 'primary',
        quality: classified.quality,
        score: 100,
      });
      continue;
    }

    const secondary = trustedSecondaryForItem(row);
    if (secondary) {
      seen.add(exactUrl);
      candidates.push({
        ...secondary,
        fallbackText: secondary.text,
        method: 'event-cluster-trusted-secondary',
        score: 80,
      });
    }
  }

  return candidates;
}

async function supportingSourcesFromCluster(sql, item, mainSource) {
  const candidates = await clusterSourceCandidates(sql, item);
  const selected = [];

  for (const source of candidates) {
    if (!source?.url || source.url === mainSource?.url) continue;
    const text = await fetchSourceText(source);
    if (!text || text.trim().length < 40) continue;
    selected.push({
      name: source.name,
      url: source.url,
      role: source.role,
      quality: source.quality,
      text: compactSourceText(text, item.title),
    });
    if (selected.length >= 3) break;
  }

  return selected;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

function absoluteUrl(base, href) {
  try { return new URL(String(href || ''), base).toString(); } catch { return ''; }
}

function dateTokens(dateValue, timeZone = 'UTC') {
  const date = new Date(dateValue || Date.now());
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const month = String(map.month || '').toLowerCase() === 'sep'
    ? 'sept'
    : String(map.month || '').toLowerCase();
  return { year: String(map.year || ''), month, day: String(Number(map.day || 0)) };
}

async function resolveOfficialDocument(source, item) {
  if (source.method !== 'bank-of-japan-policy') return source;

  try {
    const response = await fetch(source.url, {
      cache: 'no-store',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Kapitalstrom/1.0 (+editorial primary-document resolver)',
      },
    });
    if (!response.ok) return source;

    const html = await response.text();
    const target = dateTokens(item.published_at, 'Asia/Tokyo');
    if (!target) return source;

    const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
    const candidates = [];

    for (const row of rows) {
      const rowText = normalizeText(htmlToText(row));
      const hasDate = rowText.includes(target.year)
        && rowText.includes(target.month)
        && new RegExp(`(^| )${target.day}( |$)`).test(rowText);
      if (!hasDate) continue;

      for (const a of row.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        const href = absoluteUrl(source.url, a[1]);
        if (!href || !isTrustedPrimaryUrl(href)) continue;
        const label = htmlToText(a[2]);
        const normalized = normalizeText(label);
        let score = 0;
        if (/\.pdf(?:$|\?)/i.test(href)) score += 4;
        if (normalized.includes('change in the guideline for money market operations')) score += 12;
        if (normalized.includes('statement on monetary policy')) score += 10;
        if (normalized.includes('reference')) score -= 5;
        if (normalized.includes('amendment')) score -= 2;
        candidates.push({ href, label, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) return source;

    return {
      ...source,
      url: best.href,
      method: 'bank-of-japan-decision-document',
      documentLabel: best.label || null,
    };
  } catch {
    return source;
  }
}

async function pdfToText(buffer) {
  const worker = await import('pdf-parse/worker');
  const { PDFParse } = await import('pdf-parse');

  if (typeof worker?.getPath === 'function') {
    PDFParse.setWorker(worker.getPath());
  }

  const parser = new PDFParse({
    data: new Uint8Array(buffer),
    ...(worker?.CanvasFactory ? { CanvasFactory: worker.CanvasFactory } : {}),
  });

  try {
    const result = await parser.getText();
    return String(result?.text || '').replace(/\s+/g, ' ').trim();
  } finally {
    await parser.destroy();
  }
}

function compactSourceText(text, title) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= 18000) return clean;
  const words = normalizeText(title).split(' ').filter((x) => x.length > 4).slice(0, 5);
  const lower = clean.toLowerCase();
  const hit = words.map((w) => lower.indexOf(w)).find((n) => n >= 0);
  if (hit == null || hit < 0) return clean.slice(0, 18000);
  const start = Math.max(0, hit - 3500);
  return clean.slice(start, start + 18000);
}

async function fetchSourceText(source) {
  const fallback = String(source.fallbackText || '').slice(0, 18000);
  if (source.role === 'trusted_secondary') return fallback;
  const allowedPrimaryFetch = isTrustedPrimaryUrl(source.url)
    || isGenericOfficialHost(domainOf(source.url))
    || source.quality === 'corporate_official';
  if (!source.url || !allowedPrimaryFetch || !isSafePublicHttpUrl(source.url)) return fallback;

  try {
    const response = await fetch(source.url, {
      cache: 'no-store',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.2',
        'User-Agent': 'Kapitalstrom/1.0 (+editorial fact verification)',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const type = response.headers.get('content-type') || '';
    if (type.includes('application/pdf') || /\.pdf(?:$|\?)/i.test(source.url)) {
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength && contentLength > 8_000_000) {
        throw new Error('PDF er for stor for automatisk faktapakke.');
      }
      const text = await pdfToText(await response.arrayBuffer());
      return text || fallback;
    }

    const text = htmlToText(await response.text());
    return text || fallback;
  } catch {
    return fallback;
  }
}

async function searchIndexedOfficialSource(item) {
  try {
    const baseTerms = [...tokens(`${item.title || ''} ${item.summary || ''}`)].slice(0, 8);
    if (baseTerms.length < 2) return null;

    const quotePhrases = extractQuotedPhrases(item.summary);
    const queries = [
      baseTerms.slice(0, 6).join(' '),
      ...quotePhrases.map((q) => `"${q.replace(/"/g, '')}"`),
    ].slice(0, 3);

    const seen = new Map();

    for (const query of queries) {
      const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
      url.searchParams.set('query', query);
      url.searchParams.set('mode', 'artlist');
      url.searchParams.set('maxrecords', '50');
      url.searchParams.set('timespan', '7d');
      url.searchParams.set('sort', 'datedesc');
      url.searchParams.set('format', 'json');

      const response = await fetch(url, {
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Kapitalstrom/1.0 (+original-source research)',
        },
      });
      if (!response.ok) continue;

      const payload = await response.json();
      const articles = Array.isArray(payload?.articles) ? payload.articles : [];

      for (const article of articles) {
        const articleUrl = article?.url || '';
        const classified = sourceRoleFromUrl(articleUrl, item);
        if (classified.role !== 'primary') continue;

        const similarity = titleSimilarity(
          `${item.title || ''} ${item.summary || ''}`,
          `${article?.title || ''} ${article?.seendate || ''}`
        );

        const brandRelevant = compactIdentityText(item).includes(domainBrandToken(articleUrl));
        if (!brandRelevant && similarity < 0.25) continue;

        const host = domainOf(articleUrl);
        let score = similarity;
        if (classified.quality === 'official') score += 1.2;
        if (classified.quality === 'corporate_official') score += 1.0;
        if (isGenericOfficialHost(host)) score += 0.4;
        if (hasCorporatePrimaryPath(articleUrl)) score += 0.35;
        if (quotePhrases.length) score += 0.25;

        const existing = seen.get(articleUrl);
        if (!existing || score > existing.score) {
          seen.set(articleUrl, {
            name: article?.domain || host || 'Originalkilde',
            url: articleUrl,
            fallbackText: '',
            method: quotePhrases.length ? 'gdelt-original-source-research' : 'gdelt-official-source',
            role: 'primary',
            quality: classified.quality,
            score,
          });
        }
      }
    }

    const candidates = [...seen.values()].sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  } catch {
    return null;
  }
}

async function resolveResearchSource(sql, item) {
  if (isSpecificPrimaryUrl(item.url)) {
    return {
      name: item.source_domain || 'Offisiell kilde',
      url: item.url,
      fallbackText: item.summary || '',
      method: 'trusted-discovery-url',
      role: 'primary',
      quality: 'official',
    };
  }

  const title = `${item.title || ''} ${item.summary || ''}`;

  if (/norges\s+bank/i.test(title) && /(styringsrente|rentevedtak|rentebeslutning|rentemøte|rente)/i.test(title)) {
    return {
      name: 'Norges Bank',
      url: NORGES_BANK_POLICY_URL,
      fallbackText: '',
      method: 'norges-bank-policy',
      role: 'primary',
      quality: 'official',
    };
  }

  if (/(bank of japan|boj|japan|japansk|yen)/i.test(title) && /(rente|rate|monetary|pengepolitikk|sentralbank)/i.test(title)) {
    return {
      name: 'Bank of Japan',
      url: BOJ_POLICY_RELEASES_URL,
      fallbackText: '',
      method: 'bank-of-japan-policy',
      role: 'primary',
      quality: 'official',
    };
  }

  if (/(federal reserve|\bfed\b|fomc)/i.test(title) && /(rente|rate|monetary|pengepolitikk)/i.test(title)) {
    return {
      name: 'Federal Reserve',
      url: FED_POLICY_URL,
      fallbackText: '',
      method: 'federal-reserve-policy',
      role: 'primary',
      quality: 'official',
    };
  }

  if (/(european central bank|\becb\b|den europeiske sentralbanken)/i.test(title) && /(rente|rate|monetary|pengepolitikk)/i.test(title)) {
    return {
      name: 'ECB',
      url: ECB_POLICY_URL,
      fallbackText: '',
      method: 'ecb-policy',
      role: 'primary',
      quality: 'official',
    };
  }

  const clusterSources = await clusterSourceCandidates(sql, item);
  const clusterPrimary = clusterSources.find((source) => source.role === 'primary');
  if (clusterPrimary) return clusterPrimary;

  const indexedOfficial = await searchIndexedOfficialSource(item);
  if (indexedOfficial) return indexedOfficial;

  const candidates = await sql`
    SELECT r.id, r.tittel, r.innhold, r.url, r.publisert, s.navn AS kilde_navn
    FROM raw_items r
    LEFT JOIN sources s ON s.id = r.kilde_id
    WHERE r.publisert >= COALESCE(${item.published_at}, now()) - interval '4 days'
      AND r.publisert <= COALESCE(${item.published_at}, now()) + interval '2 days'
    ORDER BY r.publisert DESC
    LIMIT 120
  `;

  let best = null;
  for (const candidate of candidates) {
    const score = titleSimilarity(item.title, candidate.tittel);
    if (!best || score > best.score) best = { ...candidate, score };
  }

  if (best && best.score >= 0.65 && best.url && isSpecificPrimaryUrl(best.url)) {
    return {
      name: best.kilde_navn || 'Primærkilde',
      url: best.url,
      fallbackText: best.innhold || '',
      method: 'raw-item-title-match',
      role: 'primary',
      quality: 'official',
      matchScore: best.score,
    };
  }

  const clusterSecondary = clusterSources.find((source) => source.role === 'trusted_secondary');
  if (clusterSecondary) return clusterSecondary;

  const secondary = trustedSecondaryForItem(item);
  if (secondary) {
    return {
      name: secondary.name,
      url: secondary.url,
      fallbackText: secondary.text,
      method: 'trusted-secondary-fallback',
      role: 'trusted_secondary',
      quality: 'high',
    };
  }

  return null;
}

function clampScore(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function cleanArray(value, max = 20) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function estimateCostUsd(usage = {}) {
  const hit = Number(usage.prompt_cache_hit_tokens || 0);
  const miss = Number(usage.prompt_cache_miss_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.completion_tokens || 0);
  return ((hit * 0.003) + (miss * 0.15) + (output * 0.6)) / 1_000_000;
}

async function extractFactPack(item, source, sourceText, supportingPayloads = []) {

  const system = `Du bygger en INTERN, strukturert faktapakke for Kapitalstrøms redaksjon. Du skriver IKKE en artikkel.

KILDEPRINSIPP:
- En offisiell primærkilde er sterkest, men én etablert og troverdig finans-/nyhetskilde kan alene være tilstrekkelig grunnlag for et redaksjonelt utkast.
- "trusted_secondary" er en etablert redaksjonell aktør som DN, E24, Finansavisen, Reuters, Bloomberg eller FT.
- Flere kilder er nyttig når de finnes, men er IKKE et krav for en vanlig nyhetssak.
- Unike råd, intervjuer, eksklusive opplysninger og vurderinger fra andre medier skal attribueres tydelig.
- DIREKTE SITATER skal spores til personen og den opprinnelige uttalelseskonteksten når den finnes: brev, pressemelding, tale, resultatpresentasjon, intervju eller offentlig dokument.
- Det samme gjelder ikke-siterte fakta: prøv å skille original_document/original_statement fra secondary_report.
- Når originalkilden finnes, skal discovery-mediet normalt ikke få attribution_needed=true for samme opplysning.
- Et medium som bare videreformidler et offentlig sitat er IKKE sitatets opphav. Ikke sett source_name=E24/DN/Reuters på et sitat hvis main_source viser at sitatet kommer fra et offentlig brev/dokument.
- Hvis et medium selv har gjennomført intervjuet eller sitter på den eksklusive uttalelsen, skal mediet derimot krediteres som opphav til opplysningen.
- Hvis main_source er offisiell og supporting_sources har relevante tilleggsopplysninger, kan de brukes sammen. Merk hvilken kilde som støtter hvert faktum.
- Flere discovery-lenker som beskriver samme hendelse er en kildepool, ikke separate saker. Bruk dem til å bygge én rikere faktapakke.

REGLER:
- Bruk kun opplysninger som eksplisitt finnes i main_source eller supporting_sources.
- Ikke bruk egen kunnskap til å fylle hull.
- Tall skal gjengis nøyaktig med enhet og kontekst.
- Ikke finn opp sitater, markedsreaksjoner, kursbevegelser, analytikersyn eller årsakssammenhenger.
- unknowns er KUN interne redaksjonsnotater. De skal aldri senere bli lesertekst som "kilden bekrefter ikke".
- En opplysning er brukbar når en sterk kilde faktisk støtter den, selv om en annen kilde ikke omtaler den.
- source_url skal alltid kopieres nøyaktig fra main_source.url eller en URL i supporting_sources. Ikke konstruer, gjett eller forkort URL-er.
- market_relevance skal være en kort redaksjonell forklaring, ikke et påstått observert markedsutfall.
- Ved resultater/kvartalstall skal du analysere tallene STRUKTURELT, men bare fra kildegrunnlaget: omsetning, EPS/resultat, vekst, marginer, guiding, segmenter, cash flow og eventuelle eksplisitte forventninger/estimater. Regn ikke ut nye tall med mindre beregningen er helt triviell og nødvendig; foretrekk tall kilden selv oppgir.
- Hvis en støttekilde oppgir konsensus/forventninger og originalkilden oppgir faktiske tall, kan du koble dem i beats_misses med tydelig kilde på begge sider.
- Ikke kall noe "beat" eller "miss" uten at forventningen faktisk finnes i kildegrunnlaget.
- can_write=true når kildegrunnlaget er godt nok til et sammenhengende, redigerbart nyhetsutkast. Én sterk kilde kan være nok.
- confidence gjelder kvaliteten på kildegrunnlaget. 60+ kan være godt nok til et menneskekontrollert utkast; 80+ er sterkt.

Returner kun gyldig JSON:
{
  "headline_fact":"viktigste dokumenterte faktum",
  "event_type":"kort type",
  "facts":[
    {
      "fact":"konkret faktum",
      "source_name":"kilden som støtter faktumet",
      "source_url":"EKSAKT URL fra main_source.url eller supporting_source.url; aldri finn opp en URL",
      "source_role":"primary eller trusted_secondary",
      "attribution_needed":false,
      "speaker":"",
      "origin_context":"for eksempel brev til aksjonærene, pressemelding eller intervju",
      "provenance":"original_statement, original_document, exclusive_media_report eller secondary_report"
    }
  ],
  "numbers":[
    {
      "label":"hva tallet gjelder",
      "value":"nøyaktig verdi",
      "unit":"enhet eller tom streng",
      "context":"kort kontekst",
      "source_name":"kilden som støtter tallet",
      "source_url":"EKSAKT URL fra main_source.url eller supporting_source.url"
    }
  ],
  "entities":["navn"],
  "unknowns":["internt punkt som eventuelt bør undersøkes videre"],
  "market_relevance":"kort redaksjonell relevansforklaring",
  "analysis_signals":{
    "is_earnings":false,
    "headline_metrics":[{"metric":"Revenue","actual":"verdi","comparison":"forrige periode/vekst hvis oppgitt","source_name":"kilde"}],
    "beats_misses":[{"metric":"Revenue","actual":"verdi","expectation":"verdi","direction":"beat/miss/in_line","source_name":"kilde"}],
    "guidance_changes":[{"metric":"Revenue guidance","new":"verdi","old":"verdi hvis oppgitt","direction":"raised/cut/unchanged"}],
    "margin_signals":["konkret dokumentert marginutvikling"],
    "segment_drivers":["konkret dokumentert segmentutvikling"],
    "cash_flow_signals":["konkret dokumentert cash-flow/capex-utvikling"],
    "risks":["konkret dokumentert risiko eller svakhet"]
  },
  "can_write":true,
  "confidence":75,
  "reason":"kort vurdering av kildegrunnlaget"
}`;

  const user = {
    radar_context: {
      title: item.title,
      score: item.ai_score,
      type: item.candidate_type,
    },
    main_source: {
      name: source.name,
      url: source.url,
      role: source.role,
      quality: source.quality,
      text: compactSourceText(sourceText, item.title),
    },
    supporting_sources: supportingPayloads,
  };

  const result = await deepSeekJsonRequest({
    system,
    user,
    model: MODEL,
    maxTokens: 2400,
    temperature: 0.05,
    timeoutMs: 50000,
    retries: 3,
    label: 'DeepSeek faktapakke',
  });
  const parsed = result.json;

  return {
    pack: {
      headlineFact: String(parsed?.headline_fact || '').trim().slice(0, 500),
      eventType: String(parsed?.event_type || '').trim().slice(0, 100),
      facts: cleanArray(parsed?.facts, 28),
      numbers: cleanArray(parsed?.numbers, 28),
      entities: cleanArray(parsed?.entities, 30).map((x) => String(x).slice(0, 160)),
      unknowns: cleanArray(parsed?.unknowns, 20).map((x) => String(x).slice(0, 500)),
      marketRelevance: String(parsed?.market_relevance || '').trim().slice(0, 800),
      analysisSignals: parsed?.analysis_signals && typeof parsed.analysis_signals === 'object' ? parsed.analysis_signals : {},
      canWrite: parsed?.can_write === true,
      confidence: clampScore(parsed?.confidence),
      reason: String(parsed?.reason || '').trim().slice(0, 600),
    },
    supporting: supportingPayloads,
    usage: result.usage || {},
  };
}

async function saveNeedsSource(sql, item) {
  await sql`
    INSERT INTO fact_packs (
      radar_item_id, status, version, unknowns, can_write, confidence, ai_reason, updated_at
    )
    VALUES (
      ${item.id}, 'needs_source', ${FACT_PACK_VERSION},
      ${JSON.stringify(['Ingen sterk nok kilde ble funnet automatisk ennå.'])}::jsonb,
      false, 0,
      'Radartreffet mangler foreløpig et tilstrekkelig kildegrunnlag. Det kan fortsatt behandles manuelt i redaksjonen.',
      now()
    )
    ON CONFLICT (radar_item_id) DO UPDATE SET
      status = EXCLUDED.status,
      version = EXCLUDED.version,
      unknowns = EXCLUDED.unknowns,
      can_write = false,
      confidence = 0,
      ai_reason = EXCLUDED.ai_reason,
      updated_at = now()
  `;

  await sql`
    UPDATE radar_items
    SET primary_source_status = 'needs_source'
    WHERE id = ${item.id}
  `;

  return { ok: true, status: 'needs_source', canWrite: false };
}

export async function buildFactPackForRadarItem(id, options = {}) {
  const sql = db();
  await ensureFactPackSchema(sql);

  const [item] = await sql`
    SELECT id, source_name, source_domain, source_kind, title, summary, url,
           published_at, ai_score, ai_model, ai_section, ai_reason, candidate_type,
           local_event_key, local_cluster_size,
           credit_required, next_step, primary_source_status, primary_source_name, primary_source_url
    FROM radar_items
    WHERE id = ${Number(id)}
    LIMIT 1
  `;

  if (!item) throw new Error('Fant ikke radartreffet.');
  if (Number(item.ai_score || 0) < 60 && options?.manualOverride !== true) {
    throw new Error('Faktapakke bygges automatisk bare for radartreff med score 60 eller høyere.');
  }

  const sourceBase = await resolveResearchSource(sql, item);
  if (!sourceBase) return saveNeedsSource(sql, item);

  const source = await resolveOfficialDocument(sourceBase, item);
  const sourceText = await fetchSourceText(source);
  const minimumLength = source.role === 'trusted_secondary' ? 50 : 100;

  if (!sourceText || sourceText.trim().length < minimumLength) {
    return saveNeedsSource(sql, item);
  }

  const supportingSources = await supportingSourcesFromCluster(sql, item, source);
  const extracted = await extractFactPack(item, source, sourceText, supportingSources);
  const pack = extracted.pack;
  const supportingText = (extracted.supporting || []).map((entry) => entry.text || '').join('\n---SUPPORT---\n');
  const sourceHash = createHash('sha256')
    .update(`${sourceText}\n---SUPPORT---\n${supportingText}`)
    .digest('hex');

  const strongSource = source.role === 'primary' || source.role === 'trusted_secondary';
  const hasUsableCore = Boolean(pack.headlineFact) && (pack.facts.length >= 2 || pack.numbers.length >= 2);
  const sourceFloor = source.role === 'primary'
    ? (hasUsableCore ? 70 : 55)
    : source.role === 'trusted_secondary'
      ? (hasUsableCore ? (supportingSources.length ? 65 : 55) : 45)
      : 0;
  const effectiveConfidence = Math.max(pack.confidence, sourceFloor);
  const effectiveCanWrite = pack.canWrite || (strongSource && hasUsableCore && effectiveConfidence >= 55);

  const status = effectiveCanWrite && effectiveConfidence >= 55
    ? 'ready'
    : (pack.facts.length || pack.numbers.length)
      ? 'needs_review'
      : 'insufficient_source';

  await sql`
    INSERT INTO fact_packs (
      radar_item_id, status, version, primary_source_name, primary_source_url,
      source_role, source_quality, source_fetched_at, source_hash,
      headline_fact, event_type, facts, numbers, entities, unknowns,
      market_relevance, analysis_signals, can_write, confidence, ai_model, ai_reason, updated_at
    )
    VALUES (
      ${item.id}, ${status}, ${FACT_PACK_VERSION}, ${source.name}, ${source.url},
      ${source.role}, ${source.quality}, now(), ${sourceHash},
      ${pack.headlineFact || null}, ${pack.eventType || null},
      ${JSON.stringify(pack.facts)}::jsonb, ${JSON.stringify(pack.numbers)}::jsonb,
      ${JSON.stringify(pack.entities)}::jsonb, ${JSON.stringify(pack.unknowns)}::jsonb,
      ${pack.marketRelevance || null}, ${JSON.stringify(pack.analysisSignals)}::jsonb, ${effectiveCanWrite}, ${effectiveConfidence}, ${MODEL},
      ${pack.reason || null}, now()
    )
    ON CONFLICT (radar_item_id) DO UPDATE SET
      status = EXCLUDED.status,
      version = EXCLUDED.version,
      primary_source_name = EXCLUDED.primary_source_name,
      primary_source_url = EXCLUDED.primary_source_url,
      source_role = EXCLUDED.source_role,
      source_quality = EXCLUDED.source_quality,
      source_fetched_at = EXCLUDED.source_fetched_at,
      source_hash = EXCLUDED.source_hash,
      headline_fact = EXCLUDED.headline_fact,
      event_type = EXCLUDED.event_type,
      facts = EXCLUDED.facts,
      numbers = EXCLUDED.numbers,
      entities = EXCLUDED.entities,
      unknowns = EXCLUDED.unknowns,
      market_relevance = EXCLUDED.market_relevance,
      analysis_signals = EXCLUDED.analysis_signals,
      can_write = EXCLUDED.can_write,
      confidence = EXCLUDED.confidence,
      ai_model = EXCLUDED.ai_model,
      ai_reason = EXCLUDED.ai_reason,
      updated_at = now()
  `;

  const radarSourceStatus = source.role === 'trusted_secondary' ? 'trusted_secondary' : 'verified';
  await sql`
    UPDATE radar_items
    SET primary_source_status = ${radarSourceStatus},
        primary_source_name = ${source.name},
        primary_source_url = ${source.url}
    WHERE id = ${item.id}
  `;

  const journalRole = source.role === 'trusted_secondary' ? 'trusted_secondary' : 'primary';
  await sql`
    INSERT INTO source_journal (radar_item_id, role, source_name, url, note)
    SELECT ${item.id}, ${journalRole}, ${source.name}, ${source.url},
           ${`Kildegrunnlag koblet automatisk via ${source.method}. Faktapakke ${status}.`}
    WHERE NOT EXISTS (
      SELECT 1 FROM source_journal
      WHERE radar_item_id = ${item.id}
        AND role = ${journalRole}
        AND url = ${source.url}
    )
  `;

  for (const supporting of extracted.supporting || []) {
    if (!supporting?.url || supporting.url === source.url) continue;
    await sql`
      INSERT INTO source_journal (radar_item_id, role, source_name, url, note)
      SELECT ${item.id}, 'supporting', ${supporting.name}, ${supporting.url},
             'Søsterkilde fra samme hendelsesklynge brukt til dokumenterte tilleggsopplysninger og eventuell attribusjon.'
      WHERE NOT EXISTS (
        SELECT 1 FROM source_journal
        WHERE radar_item_id = ${item.id}
          AND role = 'supporting'
          AND url = ${supporting.url}
      )
    `;
  }

  const tokensIn = Number(extracted.usage.prompt_tokens || 0);
  const tokensOut = Number(extracted.usage.completion_tokens || 0);
  const cost = estimateCostUsd(extracted.usage);
  await sql`
    INSERT INTO ai_usage (steg, modell, tokens_inn, tokens_ut, kostnad_usd)
    VALUES ('fact-pack', ${MODEL}, ${tokensIn}, ${tokensOut}, ${cost})
  `;

  return {
    ok: true,
    status,
    canWrite: effectiveCanWrite,
    confidence: effectiveConfidence,
    facts: pack.facts.length,
    numbers: pack.numbers.length,
    primarySource: source.name,
    sourceRole: source.role,
  };
}
