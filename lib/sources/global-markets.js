import { db } from '../db';

const QUOTES = [
  { symbol: 'OSEBX', name: 'Oslo Børs', remote: 'OSEBX.OL' },
  { symbol: 'EQNR', name: 'Equinor', remote: 'EQNR.OL' },
  { symbol: 'DNB', name: 'DNB', remote: 'DNB.OL' },
  { symbol: 'KOG', name: 'Kongsberg', remote: 'KOG.OL' },
  { symbol: 'SP500', name: 'S&P 500', remote: '^GSPC' },
  { symbol: 'NASDAQ', name: 'Nasdaq', remote: '^IXIC' },
  { symbol: 'NIKKEI', name: 'Nikkei 225', remote: '^N225' },
  { symbol: 'BRENT', name: 'Brent', remote: 'BZ=F' },
  { symbol: 'GOLD', name: 'Gull', remote: 'GC=F' },
  { symbol: 'BTCUSD', name: 'Bitcoin', remote: 'BTC-USD' },
  { symbol: 'ETHUSD', name: 'Ethereum', remote: 'ETH-USD' },
];

async function fetchChart(remote) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(remote)}?range=2d&interval=5m&includePrePost=false`;
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 Kapitalstrom/1.0',
    },
  });
  if (!response.ok) throw new Error(`${remote}: HTTP ${response.status}`);

  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) throw new Error(`${remote}: mangler markedsdata`);

  const current = Number(meta.regularMarketPrice);
  const previous = Number(meta.chartPreviousClose ?? meta.previousClose);
  if (!Number.isFinite(current)) throw new Error(`${remote}: mangler gyldig kurs`);

  const changePct = Number.isFinite(previous) && previous !== 0
    ? ((current / previous) - 1) * 100
    : 0;

  return {
    value: current,
    changePct,
    marketTime: Number(meta.regularMarketTime) || null,
  };
}

export async function syncGlobalMarkets() {
  const sql = db();
  const settled = await Promise.allSettled(
    QUOTES.map(async (quote) => ({
      ...quote,
      ...(await fetchChart(quote.remote)),
    }))
  );

  let updated = 0;
  const errors = [];

  for (let i = 0; i < settled.length; i += 1) {
    const result = settled[i];
    const quote = QUOTES[i];
    if (result.status === 'rejected') {
      errors.push(String(result.reason?.message || `${quote.remote}: ukjent feil`).slice(0, 300));
      continue;
    }

    const row = result.value;
    await sql`
      INSERT INTO markets (symbol, navn, verdi, endring_pct, historikk, oppdatert)
      VALUES (
        ${row.symbol},
        ${row.name},
        ${row.value},
        ${row.changePct},
        '[]'::jsonb,
        ${row.marketTime ? new Date(row.marketTime * 1000).toISOString() : new Date().toISOString()}
      )
      ON CONFLICT (symbol) DO UPDATE SET
        navn = EXCLUDED.navn,
        verdi = EXCLUDED.verdi,
        endring_pct = EXCLUDED.endring_pct,
        oppdatert = EXCLUDED.oppdatert
    `;
    updated += 1;
  }

  return { requested: QUOTES.length, updated, errors };
}
