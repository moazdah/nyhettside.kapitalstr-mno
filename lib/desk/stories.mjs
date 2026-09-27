// Several sources about the same event belong to one story. A later discovery
// is attached as a source to the published article instead of producing a
// competing article or a second live message.

const STOP = new Set(['the','and','for','with','from','after','into','over','about','says','new','of','to','in','on','at',
  'as','is','are','was','by','og','med','fra','etter','om','til','av','på','er','som','en','et','den','det','har','kan',
  'vil','seg','sin','sine','ikke','nå','mer','enn','i','a','an']);
const word = source => new RegExp(`(?<!\\p{L})(?:${source})(?!\\p{L})`, 'gu');
const SYNONYMS = [
  [word('styringsrenten|styringsrente|policy rate|key rate|interest rate|renten|rente'), ' rente '],
  [word('hever|hevet|øker|raises?|raised|hikes?|hiked|opp'), ' opp '],
  [word('senker|senket|kutter|kuttet|cuts?|lowers?|ned'), ' ned '],
  [word('holder|holdes|uendret|unchanged|holds?'), ' uendret '],
  [word('konsumprisindeksen|konsumpriser|kpi|cpi|prisveksten|prisvekst|inflasjonen|inflasjon|inflation'), ' kpi '],
  [word('kvartalstall|kvartalsresultat|kvartalsresultatet|resultatet|resultat|results?|earnings'), ' resultat '],
  [word('oppkjøp|kjøper|acquisition|acquires?|takeover|bud|offer'), ' oppkjop '],
];

export function storyTokens(value = '') {
  let text = String(value).toLowerCase().normalize('NFKC');
  for (const [pattern, replacement] of SYNONYMS) text = text.replace(pattern, replacement);
  return new Set(text.replace(/[^a-z0-9æøå%,.]+/gi, ' ').split(/\s+/)
    .map(t => t.replace(/[,.]+$/, '')).filter(t => t.length >= 2 && !STOP.has(t)));
}

export function storySimilarity(a, b) {
  const x = storyTokens(a), y = storyTokens(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const token of x) if (y.has(token)) common++;
  return Math.max(common / Math.min(x.size, y.size) * 0.85, common / new Set([...x, ...y]).size * 1.35);
}

// Numbers in both titles must not contradict each other (4,25 vs 4,50 is not the same decision).
function numbersAgree(a, b) {
  const nums = v => new Set([...String(v).matchAll(/\d+(?:[,.]\d+)?/g)].map(m => m[0].replace(',', '.')));
  const x = nums(a), y = nums(b);
  if (!x.size || !y.size) return true;
  for (const n of x) if (y.has(n)) return true;
  return false;
}

export function sameStory(a, b, { hours = 24 } = {}) {
  const ta = new Date(a.publishedAt || 0).getTime(), tb = new Date(b.publishedAt || 0).getTime();
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta > 0 && tb > 0 && Math.abs(ta - tb) > hours * 3600000) return false;
  if (a.storyKey && b.storyKey) return a.storyKey === b.storyKey;
  const similarity = storySimilarity(a.title, b.title);
  return similarity >= 0.6 && numbersAgree(a.title, b.title);
}

// Open stories: live articles from the last day, newest first.
export async function openStories(sql, { hours = 24 } = {}) {
  return sql`SELECT id, slug, tittel AS title, story_key, publisert_at AS published_at, breaking_event_id
    FROM articles WHERE status = 'live' AND publisert_at >= now() - ${hours} * interval '1 hour'
    ORDER BY publisert_at DESC LIMIT 80`;
}

export function matchStory(item, stories) {
  return stories.find(story => sameStory(
    { title: item.title, publishedAt: item.published_at || item.publishedAt, storyKey: item.story_key || null },
    { title: story.title, publishedAt: story.published_at, storyKey: item.story_key ? story.story_key : null })) || null;
}

export function attachSource(sql, articleId, source, role = 'supporting') {
  return sql`INSERT INTO article_sources (article_id, url, source_name, title, role, published_at)
    VALUES (${Number(articleId)}, ${source.url}, ${source.source_name || source.name || null}, ${source.title || null},
      ${role}, ${source.published_at || source.publishedAt || null})
    ON CONFLICT (article_id, url) DO NOTHING`;
}
