import { createHash } from 'node:crypto';

export const DOSSIER_VERSION = 'editorial-case-v1';
export const FACT_PACK_VERSION = 'fact-pack-v10';
export const MAX_ARTICLE_AGE_HOURS = 36;

export function fingerprint(value) {
  const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function canonicalSourceUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch { return null; }
}

const NORWEGIAN = /\b(norge|norsk\w*|norway|norwegian|oslo børs|osebx|norges bank|kronekurs\w*|nok|equinor|dnb|kongsberg|aker|yara|mowi|salmar|telenor|orkla|norsk hydro|vår energi|var energi|frontline|hafnia|subsea 7|ssb)\b/i;
const GLOBAL = /\b(fed|fomc|federal reserve|ecb|esb|brent|opec|oil|olje|gas|gass|nvidia|apple|microsoft|alphabet|amazon|meta|tesla|novo nordisk|s&p\s*500|nasdaq|bitcoin|btc|ethereum|inflasjon|inflation|us payrolls|tariffs|tollsatser)\b/i;
const EVENT = /\b(resultat\w*|earnings|guid\w*|revenue|rate\w*|rent\w*|cut\w*|hik\w*|hever|senker|oppkjøp|acqui\w*|merger|kontrakt\w*|contract\w*|inflasjon|inflation|stiger|faller|surge\w*|plunge\w*|sanction\w*|tariff\w*|toll\w*|billion|milliard\w*|konkurs|bankrupt\w*|payroll\w*)\b/i;
const NOISE = /\b(sponsored|advertorial|horoscope|horoskop|giveaway|coupon|kupong|best stocks to buy|stocks to buy now)\b/i;

export function assessAudience(item) {
  const text = `${item.title || ''} ${item.summary || ''}`;
  const norwegian = NORWEGIAN.test(text);
  const global = GLOBAL.test(text);
  const concrete = EVENT.test(text) || ['resultat','oppkjøp','kontrakt','makro','renter','markedsbevegelse','regulatorisk'].includes(item.candidate_type);
  const eligible = !NOISE.test(text) && concrete && (norwegian || global);
  return {
    eligible, norwegian, global, concrete,
    score: eligible ? (norwegian ? 90 : 70) : 0,
    reason: NOISE.test(text) ? 'Reklame eller generisk kjøpsliste.' : !concrete ? 'Ingen konkret ny økonomisk hendelse.'
      : norwegian ? 'Direkte norsk økonomi- eller selskapsrelevans.'
        : global ? 'Global hendelse innen markeder norske finanslesere følger.'
          : 'Norsk eller vesentlig global publikumsrelevans er ikke dokumentert.',
  };
}

export function newDossier(item) {
  return {
    version: DOSSIER_VERSION,
    identity: { radarId: Number(item.id), eventKey: item.event_key || item.local_event_key || fingerprint(canonicalSourceUrl(item.url) || `radar:${item.id}`) },
    discovery: { title: item.title, url: item.url, source: item.source_name, publishedAt: item.published_at || null, discoveredAt: item.discovered_at || null },
    selection: assessAudience(item),
    sources: [], factPack: null, research: null, draft: null, verification: null,
  };
}

const normalized = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();

// Only explicit publication metadata is evidence. Generic <time>, dateModified,
// discovery timestamps and URL date guesses are deliberately excluded.
export function publicationEvidence(html) {
  const found = [];
  const add = (value, kind) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(value)) return;
    const time = new Date(value);
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    const validDay = month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (validDay && Number.isFinite(time.getTime())) found.push({ at: time.toISOString(), kind, raw: value });
  };
  for (const match of String(html).matchAll(/<meta\b([^>]+)>/gi)) {
    const attributes = Object.fromEntries([...match[1].matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(m => [m[1].toLowerCase(), m[2]]));
    if (/^(article:published_time|datePublished)$/i.test(attributes.property || attributes.itemprop || attributes.name || '')) add(attributes.content, 'publication_meta');
  }
  const visit = object => {
    if (Array.isArray(object)) { object.forEach(visit); return; }
    if (!object || typeof object !== 'object') return;
    const types = Array.isArray(object['@type']) ? object['@type'] : [object['@type']];
    if (types.some(type => /^(NewsArticle|Article|ReportageNewsArticle|BlogPosting)$/.test(type))) add(object.datePublished, 'article_jsonld');
    if (object['@graph']) visit(object['@graph']);
  };
  for (const match of String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1])); } catch { /* malformed metadata is not proof */ }
  }
  const dates = [...new Set(found.map(e => e.at))];
  if (dates.length !== 1) return null; // ambiguous dates fail closed
  return found[0] || null;
}

export function ageReasons(evidence, now = Date.now(), maxHours = MAX_ARTICLE_AGE_HOURS) {
  if (!evidence?.at || !evidence.kind) return ['original_date_unverified'];
  const time = new Date(evidence.at).getTime();
  if (!Number.isFinite(time)) return ['original_date_unverified'];
  if (time > now + 15 * 60_000) return ['original_date_in_future'];
  if (now - time > maxHours * 3_600_000) return ['event_expired'];
  return [];
}

export function assessResearch(dossier, pack, documents, now = Date.now()) {
  const reasons = [];
  const main = documents[0];
  if (!dossier.selection?.eligible) reasons.push('audience_relevance_missing');
  if (!main?.fetched || !['primary','trusted_secondary'].includes(main?.role)) reasons.push('source_not_verified');
  if (main?.documentType === 'index') reasons.push('source_is_index');
  reasons.push(...ageReasons(main?.publication, now));
  if (pack.canWrite !== true) reasons.push('research_declined');
  if (pack.matchesEvent !== true) reasons.push('event_mismatch');
  if (!pack.headlineFact || !pack.facts?.length || Number(pack.confidence) < 70) reasons.push('insufficient_facts');
  const sources = new Map(documents.filter(d => d.fetched).map(d => [d.url, d]));
  for (const [index, fact] of [...(pack.facts || []), ...(pack.numbers || [])].entries()) {
    const source = sources.get(fact.source_url);
    const quote = normalized(fact.evidence_quote);
    if (!source || quote.length < 12 || !normalized(source.text).includes(quote)) reasons.push(`evidence_missing:${index + 1}`);
    if (!['primary','trusted_secondary'].includes(source?.role)) reasons.push(`source_untrusted:${index + 1}`);
  }
  const headlineIds = pack.headlineFactIds || [];
  if (!headlineIds.length || headlineIds.some(id => !pack.facts.some(f => f.id === id))) reasons.push('headline_evidence_missing');
  return { passed: reasons.length === 0, reasons: [...new Set(reasons)], checkedAt: new Date(now).toISOString() };
}

export function articleSnapshot(article) {
  return { title: article.tittel ?? article.title ?? '', dek: article.undertittel ?? article.dek ?? '', body: article.brodtekst ?? article.body ?? '', section: article.seksjon ?? article.section ?? '' };
}

export function factSnapshot(pack) {
  const fields = ['version','primary_source_name','primary_source_url','source_role','source_quality','source_hash',
    'headline_fact','event_type','facts','numbers','entities','unknowns','market_relevance','analysis_signals','can_write','confidence'];
  return Object.fromEntries(fields.map(key => [key, pack[key] ?? null]));
}

export function verificationBlocks(draft) {
  return [{ id: 'title', text: draft.title }, { id: 'dek', text: draft.dek },
    ...draft.paragraphs.map((text, i) => ({ id: `p${i + 1}`, text })),
    ...(draft.aiAnalysis ? [{ id: 'analysis', text: draft.aiAnalysis, analysis: true }] : [])];
}

export function assessVerification(draft, pack, response) {
  const blocks = verificationBlocks(draft);
  const checks = Array.isArray(response?.checks) ? response.checks : [];
  const allowed = new Set([...pack.facts, ...pack.numbers].map(f => f.id));
  const reasons = [];
  if (response?.passed !== true) reasons.push('reviewer_rejected');
  if (checks.length !== blocks.length || new Set(checks.map(c => c.id)).size !== blocks.length) reasons.push('incomplete_review');
  for (const block of blocks) {
    const check = checks.find(c => c.id === block.id);
    if (!block.text || check?.supported !== true || !check.fact_ids?.length || check.fact_ids.some(id => !allowed.has(id))) reasons.push(`unsupported:${block.id}`);
    if (check?.entity_numbers_units_dates_match !== true) reasons.push(`facts_mismatch:${block.id}`);
  }
  if (response?.personal_advice !== false) reasons.push('investment_advice_check_failed');
  return { passed: reasons.length === 0, reasons: [...new Set(reasons)], checks, reviewer: 'deepseek-v4-pro', checkedAt: new Date().toISOString() };
}

export function publicationGate(dossier, article, currentPack, { now = Date.now() } = {}) {
  const reasons = [];
  if (dossier?.version !== DOSSIER_VERSION) reasons.push('case_version_missing');
  if (!dossier?.research?.passed) reasons.push('research_not_approved');
  if (!dossier?.selection?.eligible) reasons.push('audience_relevance_missing');
  reasons.push(...ageReasons(dossier?.sources?.[0]?.publication, now));
  if (!dossier?.verification?.passed) reasons.push('verification_required');
  if (article?.tall_validert !== true) reasons.push('article_not_verified');
  if (!dossier?.draft || fingerprint(articleSnapshot(article)) !== dossier.draft.hash) reasons.push('draft_changed');
  if (!currentPack || fingerprint(currentPack) !== dossier?.factPackHash) reasons.push('fact_pack_changed');
  return { passed: reasons.length === 0, reasons: [...new Set(reasons)] };
}
