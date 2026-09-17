import { db } from '../db';

const SOURCE_NAME = 'Norges Bank – valutakurser';
const SOURCE_URL = 'https://data.norges-bank.no/api/data/EXR';

const SERIES = [
  { symbol: 'USDNOK', name: 'USD/NOK', currency: 'USD' },
  { symbol: 'EURNOK', name: 'EUR/NOK', currency: 'EUR' },
  { symbol: 'GBPNOK', name: 'GBP/NOK', currency: 'GBP' },
  { symbol: 'SEKNOK', name: 'SEK/NOK', currency: 'SEK', unitScale: 100 },
  { symbol: 'DKKNOK', name: 'DKK/NOK', currency: 'DKK', unitScale: 100 },
  { symbol: 'CHFNOK', name: 'CHF/NOK', currency: 'CHF', unitScale: 100 },
];

function observationValues(payload) {
  const series = payload?.data?.dataSets?.[0]?.series;
  if (!series || typeof series !== 'object') throw new Error('Norges Bank svarte uten seriedata.');

  const firstSeries = Object.values(series)[0];
  const observations = firstSeries?.observations;
  if (!observations || typeof observations !== 'object') throw new Error('Norges Bank svarte uten observasjoner.');

  return Object.entries(observations)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, obs]) => Number(Array.isArray(obs) ? obs[0] : NaN))
    .filter(Number.isFinite);
}

async function fetchRate(currency, unitScale = 1) {
  const url = `https://data.norges-bank.no/api/data/EXR/B.${currency}.NOK.SP?format=sdmx-json&lastNObservations=2&locale=no`;
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Norges Bank ${currency}: HTTP ${response.status}`);

  const payload = await response.json();
  const values = observationValues(payload);
  if (!values.length) throw new Error(`Norges Bank ${currency}: ingen kursobservasjoner.`);

  const rawLatest = values.at(-1);
  const rawPrevious = values.length > 1 ? values.at(-2) : rawLatest;
  const latest = rawLatest / unitScale;
  const previous = rawPrevious / unitScale;
  const changePct = previous ? ((latest / previous) - 1) * 100 : 0;

  return { latest, changePct };
}

async function ensureSource(sql) {
  await sql`
    INSERT INTO sources (navn, type, url, aktiv, intervall_min)
    SELECT ${SOURCE_NAME}, 'api', ${SOURCE_URL}, true, 15
    WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = ${SOURCE_URL})
  `;
  await sql`
    UPDATE sources
    SET navn = ${SOURCE_NAME}, type = 'api', aktiv = true, intervall_min = 15
    WHERE url = ${SOURCE_URL}
  `;
}

export async function syncNorgesBankFx() {
  const sql = db();
  const rates = await Promise.all(SERIES.map(async (item) => ({
    ...item,
    ...(await fetchRate(item.currency, item.unitScale || 1)),
  })));

  await ensureSource(sql);

  for (const rate of rates) {
    await sql`
      INSERT INTO markets (symbol, navn, verdi, endring_pct, historikk, oppdatert)
      VALUES (${rate.symbol}, ${rate.name}, ${rate.latest}, ${rate.changePct}, '[]'::jsonb, now())
      ON CONFLICT (symbol) DO UPDATE SET
        navn = EXCLUDED.navn,
        verdi = EXCLUDED.verdi,
        endring_pct = EXCLUDED.endring_pct,
        oppdatert = now()
    `;
  }

  await sql`UPDATE sources SET sist_hentet = now() WHERE url = ${SOURCE_URL}`;
  return rates;
}
