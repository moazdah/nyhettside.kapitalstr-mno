// One desk assessment for both the fast track and the regular article engine.
// Four explicit dimensions (0–100) are combined into one score which decides
// front-page placement, the breaking banner and whether a live message is sent.
// Deterministic by design: the same input always gives the same placement.

const NORWEGIAN = /\b(norge|norsk\w*|norway|norwegian|oslo børs|osebx|obx|norges bank|ssb|statistisk sentralbyrå|kron(?:e|en|a)\w*|nok|equinor|dnb|kongsberg|aker\w*|yara|mowi|salmar|telenor|orkla|norsk hydro|hydro|vår energi|var energi|frontline|hafnia|subsea 7|storebrand|gjensidige|tomra|nordic semiconductor|schibsted|autostore|lerøy|nel|scatec|oljefondet|statens pensjonsfond|finanstilsynet|nav)\b/i;
const GLOBAL = /\b(fed|fomc|federal reserve|ecb|esb|brent|opec|oil|olje|gas|gass|nvidia|apple|microsoft|alphabet|amazon|meta|tesla|novo nordisk|s&p\s*500|nasdaq|bitcoin|inflasjon|inflation|payrolls|tariffs?|toll\w*)\b/i;
const HOUSEHOLD = /\b(rente|renter|styringsrente\w*|boliglån|bolig\w*|strøm\w*|kpi|prisvekst|inflasjon|lønn\w*|arbeidsledig\w*|ledighet|skatt\w*|krone\w*|matpris\w*|drivstoff|bensin)\b/i;

// Base news value per event kind. Fast-track kinds come from official sources.
export const KIND_NEWS_VALUE = {
  'rate-decision': 100,
  'ssb-release': 88,
  'exchange-results': 78,
  'exchange-notice': 70,
  oppkjøp: 80, resultat: 72, renter: 80, makro: 72, breaking: 78, kontrakt: 60,
  markedsbevegelse: 62, regulatorisk: 60,
};

const OFFICIAL_NORWEGIAN_SOURCES = new Set(['norges-bank', 'ssb', 'oslo-bors']);
const clamp = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

export function timeliness(publishedAt, now = Date.now()) {
  const time = new Date(publishedAt || 0).getTime();
  if (!Number.isFinite(time) || time <= 0) return 20;
  const ageMinutes = Math.max(0, (now - time) / 60000);
  if (ageMinutes <= 15) return 100;
  if (ageMinutes <= 60) return clamp(100 - (ageMinutes - 15) * 0.4);
  if (ageMinutes <= 6 * 60) return clamp(82 - (ageMinutes - 60) / 60 * 8);
  return clamp(42 - (ageMinutes - 360) / 60 * 1.4);
}

export const PLACEMENT = { lead: 82, top: 66 };

export function assessStory(story, { now = Date.now() } = {}) {
  const text = `${story.title || ''} ${story.summary || ''} ${(story.entities || []).join(' ')}`;
  const official = OFFICIAL_NORWEGIAN_SOURCES.has(story.sourceKey);
  const norwegian = official || NORWEGIAN.test(text);
  const global = GLOBAL.test(text);
  const reasons = [];

  const norwegianRelevance = official ? 100 : norwegian ? 88 : global ? 58 : 25;
  reasons.push(official ? 'Offisiell norsk kilde.' : norwegian ? 'Direkte norsk relevans.' : global ? 'Global hendelse med betydning for norske lesere.' : 'Svak norsk relevans.');

  const kindValue = KIND_NEWS_VALUE[story.kind] ?? KIND_NEWS_VALUE[story.candidateType] ?? null;
  const model = story.aiScore == null ? null : clamp(story.aiScore);
  const sourceBonus = Math.min(15, Math.max(0, (Number(story.sourceCount) || 1) - 1) * 5);
  const newsValue = clamp((kindValue != null && model != null ? Math.max(kindValue, model) * 0.6 + Math.min(kindValue, model) * 0.4
    : kindValue ?? model ?? 50) + sourceBonus);
  if (sourceBonus) reasons.push(`${story.sourceCount} kilder omtaler samme hendelse.`);

  const timely = timeliness(story.publishedAt, now);
  const household = HOUSEHOLD.test(text);
  const readerInterest = clamp(Math.max(Number(story.attentionScore) || 0, household ? 85 : 0,
    story.largeCap ? 75 : 0, norwegian ? 60 : global ? 50 : 30));
  if (household) reasons.push('Påvirker husholdningenes økonomi.');

  const score = Math.round((norwegianRelevance * 0.3 + newsValue * 0.3 + timely * 0.2 + readerInterest * 0.2) * 10) / 10;
  const placement = score >= PLACEMENT.lead ? 'lead' : score >= PLACEMENT.top ? 'top' : 'standard';
  // A banner interrupts every reader. Only official fast-track events of lead rank qualify.
  const banner = Boolean(story.fastTrack) && placement === 'lead' && timely >= 80;
  const live = score >= 60 && timely >= 50 && (norwegianRelevance >= 58 || (newsValue >= 80 && timely >= 80));
  return { score, placement, banner, live, norwegianRelevance, newsValue, timeliness: timely, readerInterest,
    reasons, model: 'desk-priority-v1' };
}

// Front-page rank at read time: stored desk score minus age decay.
// Kept in SQL (lib/db.js) and here for tests; both must stay identical.
export function currentRank({ priority, publishedAt, breakingActive = false }, now = Date.now()) {
  const hours = Math.max(0, (now - new Date(publishedAt).getTime()) / 3600000);
  return Number(priority) - Math.min(100, hours * 2) + (breakingActive ? 15 : 0);
}
