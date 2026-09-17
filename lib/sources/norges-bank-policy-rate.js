import { db } from '../db';

const API_SOURCE_NAME = 'Norges Bank – styringsrente';
const API_URL = 'https://data.norges-bank.no/api/data/IR/B.KPRA.RR.R';
const POLICY_PAGE_URL = 'https://www.norges-bank.no/tema/pengepolitikk/Styringsrenten/';
const MARKET_SYMBOL = 'NOKPOLICY';

function observationValues(payload) {
  const series = payload?.data?.dataSets?.[0]?.series;
  if (!series || typeof series !== 'object') throw new Error('Norges Bank svarte uten rentedata.');
  const firstSeries = Object.values(series)[0];
  const observations = firstSeries?.observations;
  if (!observations || typeof observations !== 'object') throw new Error('Norges Bank svarte uten renteobservasjoner.');
  return Object.entries(observations)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, obs]) => Number(Array.isArray(obs) ? obs[0] : NaN))
    .filter(Number.isFinite);
}

async function fetchPolicyRateFromApi() {
  const response = await fetch(`${API_URL}?format=sdmx-json&lastNObservations=1&locale=no`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Norges Bank styringsrente-API: HTTP ${response.status}`);
  const payload = await response.json();
  const values = observationValues(payload);
  if (!values.length) throw new Error('Norges Bank styringsrente-API: ingen observasjoner.');
  return values.at(-1);
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchPolicyRateFromOfficialPage() {
  const response = await fetch(POLICY_PAGE_URL, {
    cache: 'no-store',
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  if (!response.ok) throw new Error(`Norges Bank styringsrenteside: HTTP ${response.status}`);
  const text = htmlToText(await response.text());
  const start = text.toLowerCase().indexOf('styringsrenten');
  const sample = start >= 0 ? text.slice(start, start + 800) : text.slice(0, 1600);
  const match = sample.match(/([0-9]{1,2}(?:[,.][0-9]{1,2})?)\s*%/);
  if (!match) throw new Error('Fant ikke styringsrenten på Norges Banks offisielle side.');
  const value = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(value)) throw new Error('Ugyldig styringsrente fra Norges Bank.');
  return value;
}

async function currentPolicyRate() {
  // Den offentlige rentebeslutnings-/styringsrentesiden kan oppdateres ved kunngjøring.
  // API-serien brukes som offisiell reservekilde og bekreftelse.
  try {
    const pageRate = await fetchPolicyRateFromOfficialPage();
    let apiRate = null;
    try { apiRate = await fetchPolicyRateFromApi(); } catch {}
    return { rate: pageRate, apiRate, source: 'official-page' };
  } catch (pageError) {
    const apiRate = await fetchPolicyRateFromApi();
    return { rate: apiRate, apiRate, source: 'api', warning: pageError?.message || null };
  }
}

async function ensureSource(sql) {
  await sql`
    INSERT INTO sources (navn, type, url, aktiv, intervall_min)
    SELECT ${API_SOURCE_NAME}, 'api', ${API_URL}, true, 5
    WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = ${API_URL})
  `;
  await sql`
    UPDATE sources
    SET navn = ${API_SOURCE_NAME}, type = 'api', aktiv = true, intervall_min = 5
    WHERE url = ${API_URL}
  `;
  const [source] = await sql`SELECT id FROM sources WHERE url = ${API_URL} LIMIT 1`;
  return source;
}

function rateTitle(previous, current) {
  const fmt = (n) => Number(n).toFixed(2).replace('.', ',');
  if (current > previous) return `Norges Bank hever styringsrenten til ${fmt(current)} prosent`;
  if (current < previous) return `Norges Bank senker styringsrenten til ${fmt(current)} prosent`;
  return `Norges Bank holder styringsrenten uendret på ${fmt(current)} prosent`;
}

function osloDateSlugPart() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

async function createEditorialAlert(sql, sourceId, previous, current) {
  const title = rateTitle(previous, current);
  const datePart = osloDateSlugPart();
  const direction = current > previous ? 'heving' : 'senking';
  const slug = `norges-bank-rente-${direction}-${datePart}`;
  const externalId = `policy-rate-${datePart}-${current}`;
  const fmt = (n) => Number(n).toFixed(2).replace('.', ',');
  const body = `Norges Banks offisielle styringsrente er registrert endret fra ${fmt(previous)} til ${fmt(current)} prosent. Dette utkastet er laget regelbasert fra den offisielle kilden og ligger til redaksjonell kontroll før publisering.`;

  await sql`
    INSERT INTO raw_items (kilde_id, ekstern_id, tittel, innhold, publisert, url, behandlet)
    VALUES (${sourceId}, ${externalId}, ${title}, ${body}, now(), ${POLICY_PAGE_URL}, true)
    ON CONFLICT (kilde_id, ekstern_id) DO NOTHING
  `;

  await sql`
    INSERT INTO articles (
      slug, status, tittel, undertittel, brodtekst, seksjon, forfatter,
      ai_score, ai_begrunnelse, ai_modell, tall_validert,
      kilde_id, kilde_url, kilde_hentet, created_at
    )
    VALUES (
      ${slug}, 'draft', ${title},
      ${`Styringsrenten er registrert endret fra ${fmt(previous)} til ${fmt(current)} prosent i Norges Banks offisielle publisering.`},
      ${body}, 'Renter', 'Kapitalstrøm',
      100, 'Offisiell styringsrenteendring fra Norges Bank.', 'regelbasert', true,
      ${sourceId}, ${POLICY_PAGE_URL}, now(), now()
    )
    ON CONFLICT (slug) DO NOTHING
  `;

  await sql`
    INSERT INTO feed (tekst, seksjon, tidspunkt, status)
    SELECT ${title}, 'Renter', now(), 'draft'
    WHERE NOT EXISTS (
      SELECT 1 FROM feed WHERE tekst = ${title} AND tidspunkt >= now() - interval '2 days'
    )
  `;

  return { title, slug };
}

export async function syncNorgesBankPolicyRate() {
  const sql = db();
  const source = await ensureSource(sql);
  const [existing] = await sql`
    SELECT verdi, historikk
    FROM markets
    WHERE symbol = ${MARKET_SYMBOL}
    LIMIT 1
  `;

  const previous = existing?.verdi == null ? null : Number(existing.verdi);
  const fetched = await currentPolicyRate();
  const current = Number(fetched.rate);
  const changePoints = previous == null ? 0 : current - previous;

  let history = Array.isArray(existing?.historikk) ? existing.historikk : [];
  if (!history.length || Number(history.at(-1)?.v) !== current) {
    history = [...history, { t: new Date().toISOString(), v: current }].slice(-120);
  }

  await sql`
    INSERT INTO markets (symbol, navn, verdi, endring_pct, historikk, oppdatert)
    VALUES (${MARKET_SYMBOL}, 'Styringsrente', ${current}, ${changePoints}, ${JSON.stringify(history)}::jsonb, now())
    ON CONFLICT (symbol) DO UPDATE SET
      navn = EXCLUDED.navn,
      verdi = EXCLUDED.verdi,
      endring_pct = EXCLUDED.endring_pct,
      historikk = EXCLUDED.historikk,
      oppdatert = now()
  `;

  let alert = null;
  if (previous != null && Math.abs(current - previous) >= 0.0001) {
    alert = await createEditorialAlert(sql, source.id, previous, current);
  }

  await sql`UPDATE sources SET sist_hentet = now() WHERE id = ${source.id}`;
  return { previous, current, changePoints, alert, source: fetched.source, apiRate: fetched.apiRate, warning: fetched.warning || null };
}
