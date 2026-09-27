// Automatic image selection with documented usage rights.
// 1) The editor-maintained library (rights cleared by the newsroom).
// 2) Wikimedia Commons, accepted only with a free licence read from the file's
//    own metadata, and never when trademark or other restrictions are flagged.
// No match means a designed fallback visual, never an unlicensed picture.

export const SUBJECTS = [
  { key: 'norges-bank', match: /\bnorges bank\b|styringsrent/i, query: 'Norges Bank building Bankplassen Oslo', alt: 'Norges Banks hovedkontor i Oslo' },
  { key: 'ssb', match: /\bssb\b|statistisk sentralbyrå|konsumprisindeks|\bkpi\b/i, query: 'Statistisk sentralbyrå Oslo building', alt: 'Statistisk sentralbyrås kontorbygg' },
  { key: 'equinor', match: /\bequinor\b/i, query: 'Equinor headquarters Fornebu', alt: 'Equinors hovedkontor' },
  { key: 'dnb', match: /\bdnb\b/i, query: 'DNB headquarters Bjørvika Oslo', alt: 'DNBs hovedkontor i Bjørvika' },
  { key: 'telenor', match: /\btelenor\b/i, query: 'Telenor headquarters Fornebu', alt: 'Telenors hovedkontor på Fornebu' },
  { key: 'norsk-hydro', match: /\b(norsk )?hydro\b/i, query: 'Norsk Hydro aluminium plant', alt: 'Anlegg tilhørende Norsk Hydro' },
  { key: 'kongsberg', match: /\bkongsberg\b/i, query: 'Kongsberg Gruppen Kongsberg Norway', alt: 'Kongsberg Gruppen' },
  { key: 'aker-bp', match: /\baker bp\b/i, query: 'Aker BP platform North Sea', alt: 'Plattform i Nordsjøen' },
  { key: 'mowi', match: /\b(mowi|salmar|lerøy|laks)\b/i, query: 'salmon farm Norway fjord', alt: 'Oppdrettsanlegg i en norsk fjord' },
  { key: 'oslo-bors', match: /\boslo børs\b|\bosebx\b|børsmelding/i, query: 'Oslo Børs building Tollbugata', alt: 'Oslo Børs-bygningen' },
  { key: 'oil', match: /\b(olje\w*|brent|opec|oil)\b/i, query: 'offshore oil platform North Sea', alt: 'Oljeplattform i Nordsjøen' },
  { key: 'federal-reserve', match: /\b(fed|federal reserve|fomc)\b/i, query: 'Marriner S. Eccles Federal Reserve Board Building', alt: 'Federal Reserves hovedkontor i Washington' },
  { key: 'ecb', match: /\b(ecb|esb|european central bank|den europeiske sentralbanken)\b/i, query: 'European Central Bank headquarters Frankfurt', alt: 'Den europeiske sentralbankens hovedkontor' },
  { key: 'krone', match: /\bkron(e|en|a)\w*\b|\bnok\b/i, query: 'Norwegian krone coins', alt: 'Norske kronemynter' },
];
const FREE_LICENSE = /^(cc0|public domain|pd(-\w+)?|cc by(-sa)? (2\.0|2\.5|3\.0|4\.0)( \w+)?)$/i;
const RESTRICTED = /trademark|personality|insignia|logo|nonfree|non-free/i;
const stripHtml = value => String(value || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();

export function subjectFor(text) {
  return SUBJECTS.find(subject => subject.match.test(String(text || ''))) || null;
}

// Pure check of one Commons API page; returns an image record or null.
export function commonsCandidate(page, subject) {
  const info = page?.imageinfo?.[0];
  const meta = info?.extmetadata || {};
  const license = stripHtml(meta.LicenseShortName?.value);
  if (!info?.thumburl || !/^image\/(jpeg|png|webp)$/.test(info.mime || '')) return null;
  if (Number(info.width) < 1200 || !FREE_LICENSE.test(license)) return null;
  if (RESTRICTED.test(`${meta.Restrictions?.value || ''} ${page.title || ''} ${meta.Categories?.value || ''}`)) return null;
  const artist = stripHtml(meta.Artist?.value) || stripHtml(meta.Credit?.value);
  const attributionRequired = !/^(cc0|public domain|pd)/i.test(license);
  if (attributionRequired && !artist) return null;
  const credit = `Foto: ${artist || 'Ukjent fotograf'} / Wikimedia Commons (${license})`;
  return { url: info.thumburl, credit: credit.slice(0, 300), license, license_url: stripHtml(meta.LicenseUrl?.value) || null,
    source_url: info.descriptionurl || null, alt: subject.alt, tags: [subject.key], origin: 'commons' };
}

export async function searchCommons(subject, fetcher = fetch) {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  for (const [key, value] of Object.entries({ action: 'query', format: 'json', generator: 'search', gsrnamespace: '6',
    gsrsearch: `${subject.query} filetype:bitmap`, gsrlimit: '10', prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: '1600', origin: '*' })) url.searchParams.set(key, value);
  const response = await fetcher(url.toString(), { cache: 'no-store', signal: AbortSignal.timeout(8000),
    headers: { 'User-Agent': 'KapitalstromNewsDesk/1.0 (image rights check)' } });
  if (!response.ok) throw new Error(`COMMONS_HTTP_${response.status}`);
  const pages = Object.values((await response.json())?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  for (const page of pages) {
    const candidate = commonsCandidate(page, subject);
    if (candidate) return candidate;
  }
  return null;
}

export async function findImage(sql, subject, { fetcher = fetch } = {}) {
  const [stored] = await sql`SELECT * FROM image_library WHERE active AND ${subject.key} = ANY(tags)
    ORDER BY (origin = 'editor') DESC, added_at DESC LIMIT 1`;
  if (stored) return stored;
  const found = await searchCommons(subject, fetcher);
  if (!found) return null;
  const [row] = await sql`INSERT INTO image_library (url, credit, license, license_url, source_url, alt, tags, origin)
    VALUES (${found.url}, ${found.credit}, ${found.license}, ${found.license_url}, ${found.source_url}, ${found.alt}, ${found.tags}, 'commons')
    ON CONFLICT (url) DO UPDATE SET tags = (SELECT array_agg(DISTINCT t) FROM unnest(image_library.tags || EXCLUDED.tags) t)
    RETURNING *`;
  return row;
}

// Never replaces an image chosen by an editor. Returns what the reader will see.
export async function selectImageForArticle(sql, articleId, { fetcher = fetch } = {}) {
  const [article] = await sql`SELECT id, tittel, undertittel, seksjon, bilde_url FROM articles WHERE id = ${Number(articleId)}`;
  if (!article) return { status: 'missing' };
  if (article.bilde_url) return { status: 'kept' };
  const subject = subjectFor(`${article.tittel} ${article.undertittel || ''}`);
  let image = null;
  if (subject) {
    try { image = await findImage(sql, subject, { fetcher }); } catch { image = null; }
  }
  if (!image) {
    await sql`UPDATE articles SET image_status = 'fallback' WHERE id = ${Number(article.id)} AND bilde_url IS NULL`;
    return { status: 'fallback', subject: subject?.key || null };
  }
  await sql`UPDATE articles SET bilde_url = ${image.url}, bilde_kreditt = ${image.credit}, image_license = ${image.license},
    image_source_url = ${image.source_url}, image_alt = ${image.alt}, image_status = 'selected'
    WHERE id = ${Number(article.id)} AND bilde_url IS NULL`;
  return { status: 'selected', subject: subject.key, url: image.url };
}
