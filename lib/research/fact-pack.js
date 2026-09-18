import { createHash } from 'crypto';
import { db } from '../db';
import { ensureRadarSchema } from '../radar/news-radar';

const MODEL = 'deepseek-flash';
const FACT_PACK_VERSION = 'fact-pack-v3';

const TRUSTED_PRIMARY_DOMAINS = new Set([
  'live.euronext.com',
  'norges-bank.no',
  'www.norges-bank.no',
  'data.norges-bank.no',
  'ssb.no',
  'www.ssb.no',
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
      source_fetched_at TIMESTAMPTZ,
      source_hash TEXT,
      headline_fact TEXT,
      event_type TEXT,
      facts JSONB NOT NULL DEFAULT '[]'::jsonb,
      numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
      entities JSONB NOT NULL DEFAULT '[]'::jsonb,
      unknowns JSONB NOT NULL DEFAULT '[]'::jsonb,
      market_relevance TEXT,
      can_write BOOLEAN NOT NULL DEFAULT FALSE,
      confidence INT,
      ai_model TEXT,
      ai_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
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

const STOP = new Set(['og','i','på','til','for','med','av','er','en','et','den','det','de','som','fra','om','etter','mot','skal','har','the','a','an','of','to','in','for','and','on','from','with']);

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
  const month = String(map.month || '').toLowerCase() === 'sep' ? 'sept' : String(map.month || '').toLowerCase();
  return { year: String(map.year || ''), month, day: String(Number(map.day || 0)) };
}

async function resolveOfficialDocument(primary, item) {
  if (primary.method !== 'bank-of-japan-policy') return primary;

  try {
    const response = await fetch(primary.url, {
      cache: 'no-store',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Kapitalstrom/1.0 (+editorial primary-document resolver)',
      },
    });
    if (!response.ok) return primary;
    const html = await response.text();
    const target = dateTokens(item.published_at, 'Asia/Tokyo');
    if (!target) return primary;

    const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
    const candidates = [];

    for (const row of rows) {
      const rowText = normalizeText(htmlToText(row));
      const hasDate = rowText.includes(target.year)
        && rowText.includes(target.month)
        && new RegExp(`(^| )${target.day}( |$)`).test(rowText);
      if (!hasDate) continue;

      for (const a of row.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        const href = absoluteUrl(primary.url, a[1]);
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
    if (!best) return primary;

    return {
      ...primary,
      url: best.href,
      method: 'bank-of-japan-decision-document',
      documentLabel: best.label || null,
    };
  } catch {
    return primary;
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

async function fetchPrimarySourceText(url, fallback = '') {
  if (!url || !isTrustedPrimaryUrl(url)) return String(fallback || '').slice(0, 18000);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.2',
        'User-Agent': 'Kapitalstrom/1.0 (+editorial fact verification)',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/pdf') || /\.pdf(?:$|\?)/i.test(url)) {
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength && contentLength > 8_000_000) throw new Error('PDF er for stor for automatisk faktapakke.');
      const text = await pdfToText(await response.arrayBuffer());
      return text || String(fallback || '').slice(0, 18000);
    }
    const text = htmlToText(await response.text());
    return text || String(fallback || '').slice(0, 18000);
  } catch {
    return String(fallback || '').slice(0, 18000);
  }
}

async function resolvePrimarySource(sql, item) {
  if (isSpecificPrimaryUrl(item.url)) {
    return {
      name: item.source_domain || 'Offisiell kilde',
      url: item.url,
      fallbackText: item.summary || '',
      method: 'trusted-discovery-url',
    };
  }

  const title = `${item.title || ''} ${item.summary || ''}`;

  if (/norges\s+bank/i.test(title) && /(styringsrente|rentevedtak|rentebeslutning|rentemøte|rente)/i.test(title)) {
    return {
      name: 'Norges Bank',
      url: NORGES_BANK_POLICY_URL,
      fallbackText: '',
      method: 'norges-bank-policy',
    };
  }

  if (/(bank of japan|boj|japan|japansk|yen)/i.test(title) && /(rente|rate|monetary|pengepolitikk|sentralbank)/i.test(title)) {
    return {
      name: 'Bank of Japan',
      url: BOJ_POLICY_RELEASES_URL,
      fallbackText: '',
      method: 'bank-of-japan-policy',
    };
  }

  if (/(federal reserve|\bfed\b|fomc)/i.test(title) && /(rente|rate|monetary|pengepolitikk)/i.test(title)) {
    return {
      name: 'Federal Reserve',
      url: FED_POLICY_URL,
      fallbackText: '',
      method: 'federal-reserve-policy',
    };
  }

  if (/(european central bank|\becb\b|den europeiske sentralbanken)/i.test(title) && /(rente|rate|monetary|pengepolitikk)/i.test(title)) {
    return {
      name: 'ECB',
      url: ECB_POLICY_URL,
      fallbackText: '',
      method: 'ecb-policy',
    };
  }

  if (['renter', 'makro', 'analyse', 'markedsbevegelse'].includes(String(item.candidate_type || ''))) {
    return null;
  }

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
      matchScore: best.score,
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

async function extractFactPack(item, primary, sourceText) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY mangler i Vercel.');

  const system = `Du bygger en INTERN, strukturert faktapakke for Kapitalstrøms redaksjon. Du skriver IKKE en artikkel.

KRITISKE REGLER:
- Bruk kun fakta som eksplisitt finnes i PRIMÆRKILDETEKSTEN.
- Ikke bruk egen kunnskap til å fylle hull.
- Ikke gjør en påstand sann bare fordi den står i radaroverskriften.
- Radaroverskrift/sammendrag er kun kontekst for hva vi leter etter, ikke dokumentasjon.
- Hvis primærkilden ikke støtter en opplysning, legg den i unknowns eller utelat den.
- Tall skal gjengis nøyaktig med enhet og kontekst. Ikke konverter eller beregn med mindre kilden eksplisitt gjør det.
- Ikke finn opp sitater, markedsreaksjoner, kursbevegelser, analytikersyn eller årsakssammenhenger.
- market_relevance skal være en kort REDAKSJONELL forklaring på hvorfor de dokumenterte faktaene kan være relevante for finanslesere. Ikke kall en mulig effekt for et observert faktum.
- can_write=true bare når primærkilden gir nok konkrete, kontrollerbare fakta til et selvstendig nyhetsutkast. Ellers false.
- confidence er 0–100 og gjelder kvaliteten på selve faktagrunnlaget, ikke hvor spennende saken er.

Returner kun gyldig JSON:
{
  "headline_fact":"viktigste dokumenterte faktum",
  "event_type":"kort type",
  "facts":[{"fact":"konkret faktum","source":"primærkilden"}],
  "numbers":[{"label":"hva tallet gjelder","value":"nøyaktig verdi","unit":"enhet eller tom streng","context":"kort kontekst"}],
  "entities":["navn"],
  "unknowns":["hva som fortsatt må bekreftes"],
  "market_relevance":"kort redaksjonell relevansforklaring",
  "can_write":false,
  "confidence":0,
  "reason":"kort vurdering av faktagrunnlaget"
}`;

  const user = {
    radar: {
      title: item.title,
      summary: item.summary || null,
      score: item.ai_score,
      type: item.candidate_type,
    },
    primary_source: {
      name: primary.name,
      url: primary.url,
      text: compactSourceText(sourceText, item.title),
    },
  };

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.05,
      max_tokens: 2200,
      stream: false,
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`DeepSeek faktapakke feilet: ${body?.error?.message || `HTTP ${response.status}`}`);
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek svarte uten faktapakke.');
  const parsed = JSON.parse(content);

  return {
    pack: {
      headlineFact: String(parsed?.headline_fact || '').trim().slice(0, 500),
      eventType: String(parsed?.event_type || '').trim().slice(0, 100),
      facts: cleanArray(parsed?.facts, 24),
      numbers: cleanArray(parsed?.numbers, 24),
      entities: cleanArray(parsed?.entities, 30).map((x) => String(x).slice(0, 160)),
      unknowns: cleanArray(parsed?.unknowns, 20).map((x) => String(x).slice(0, 500)),
      marketRelevance: String(parsed?.market_relevance || '').trim().slice(0, 800),
      canWrite: parsed?.can_write === true,
      confidence: clampScore(parsed?.confidence),
      reason: String(parsed?.reason || '').trim().slice(0, 600),
    },
    usage: body.usage || {},
  };
}

async function saveNeedsSource(sql, item) {
  await sql`
    INSERT INTO fact_packs (radar_item_id, status, version, unknowns, can_write, confidence, ai_reason, updated_at)
    VALUES (
      ${item.id}, 'needs_source', ${FACT_PACK_VERSION},
      ${JSON.stringify(['Primærkilde er ikke automatisk funnet ennå.'])}::jsonb,
      false, 0, 'Radartreffet er interessant, men faktapakken stoppet før AI-ekstraksjon fordi en primærkilde mangler.', now()
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

export async function buildFactPackForRadarItem(id) {
  const sql = db();
  await ensureFactPackSchema(sql);

  const [item] = await sql`
    SELECT id, source_name, source_domain, source_kind, title, summary, url,
           published_at, ai_score, ai_model, ai_section, ai_reason, candidate_type,
           credit_required, next_step, primary_source_status, primary_source_name, primary_source_url
    FROM radar_items
    WHERE id = ${Number(id)}
    LIMIT 1
  `;

  if (!item) throw new Error('Fant ikke radartreffet.');
  if (Number(item.ai_score || 0) < 60) throw new Error('Faktapakke bygges bare for radartreff med score 60 eller høyere.');

  const primaryBase = await resolvePrimarySource(sql, item);
  if (!primaryBase) return saveNeedsSource(sql, item);

  const primary = await resolveOfficialDocument(primaryBase, item);
  const sourceText = await fetchPrimarySourceText(primary.url, primary.fallbackText);
  if (!sourceText || sourceText.trim().length < 120) {
    return saveNeedsSource(sql, item);
  }

  const extracted = await extractFactPack(item, primary, sourceText);
  const pack = extracted.pack;
  const sourceHash = createHash('sha256').update(sourceText).digest('hex');
  const status = pack.canWrite && pack.confidence >= 70
    ? 'ready'
    : pack.facts.length || pack.numbers.length
      ? 'needs_review'
      : 'insufficient_source';

  await sql`
    INSERT INTO fact_packs (
      radar_item_id, status, version, primary_source_name, primary_source_url,
      source_fetched_at, source_hash, headline_fact, event_type, facts, numbers,
      entities, unknowns, market_relevance, can_write, confidence, ai_model,
      ai_reason, updated_at
    )
    VALUES (
      ${item.id}, ${status}, ${FACT_PACK_VERSION}, ${primary.name}, ${primary.url},
      now(), ${sourceHash}, ${pack.headlineFact || null}, ${pack.eventType || null},
      ${JSON.stringify(pack.facts)}::jsonb, ${JSON.stringify(pack.numbers)}::jsonb,
      ${JSON.stringify(pack.entities)}::jsonb, ${JSON.stringify(pack.unknowns)}::jsonb,
      ${pack.marketRelevance || null}, ${pack.canWrite}, ${pack.confidence}, ${MODEL},
      ${pack.reason || null}, now()
    )
    ON CONFLICT (radar_item_id) DO UPDATE SET
      status = EXCLUDED.status,
      version = EXCLUDED.version,
      primary_source_name = EXCLUDED.primary_source_name,
      primary_source_url = EXCLUDED.primary_source_url,
      source_fetched_at = EXCLUDED.source_fetched_at,
      source_hash = EXCLUDED.source_hash,
      headline_fact = EXCLUDED.headline_fact,
      event_type = EXCLUDED.event_type,
      facts = EXCLUDED.facts,
      numbers = EXCLUDED.numbers,
      entities = EXCLUDED.entities,
      unknowns = EXCLUDED.unknowns,
      market_relevance = EXCLUDED.market_relevance,
      can_write = EXCLUDED.can_write,
      confidence = EXCLUDED.confidence,
      ai_model = EXCLUDED.ai_model,
      ai_reason = EXCLUDED.ai_reason,
      updated_at = now()
  `;

  await sql`
    UPDATE radar_items
    SET primary_source_status = 'verified',
        primary_source_name = ${primary.name},
        primary_source_url = ${primary.url}
    WHERE id = ${item.id}
  `;

  await sql`
    INSERT INTO source_journal (radar_item_id, role, source_name, url, note)
    SELECT ${item.id}, 'primary', ${primary.name}, ${primary.url},
           ${`Primærkilde koblet automatisk via ${primary.method}. Faktapakke ${status}.`}
    WHERE NOT EXISTS (
      SELECT 1 FROM source_journal
      WHERE radar_item_id = ${item.id}
        AND role = 'primary'
        AND url = ${primary.url}
    )
  `;

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
    canWrite: pack.canWrite,
    confidence: pack.confidence,
    facts: pack.facts.length,
    numbers: pack.numbers.length,
    primarySource: primary.name,
  };
}
