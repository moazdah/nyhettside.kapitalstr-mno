import { createHash } from 'node:crypto';

// SSB publishes key figures at 08:00 through its open statistics bank API
// (PxWebApi v0, JSON-stat 2). Variable codes are discovered from the table's own
// metadata by label, so a renamed value code does not silently change the series.
export const SSB_API = 'https://data.ssb.no/api/v0/no/table/';
export const SSB_RELEASES = [{
  id: 'kpi',
  pageUrl: 'https://www.ssb.no/priser-og-prisindekser/konsumpriser/statistikk/konsumprisindeksen',
  series: [
    { id: 'kpi', table: '03013', name: 'Konsumprisindeksen (KPI)', short: 'KPI',
      group: /^(kpi\s+)?totalindeks|^i alt$|^totalt?$/i },
    { id: 'kpi-jae', table: '05327', name: 'KPI justert for avgiftsendringer og uten energivarer (KPI-JAE)', short: 'KPI-JAE',
      group: /kpi-jae|^totalindeks|^i alt$/i, optional: true },
  ],
}];
const TWELVE_MONTH = /12-m(å|a)neders|tolvm(å|a)neders|12 m(å|a)neders/i;
const MONTHS = ['januar','februar','mars','april','mai','juni','juli','august','september','oktober','november','desember'];
export const FRESH_MS = 3 * 3600000;

export function monthLabel(period) {
  const m = String(period).match(/^(\d{4})M(\d{2})$/);
  if (!m) throw new Error('SSB_PERIOD_UNSUPPORTED');
  return { month: MONTHS[Number(m[2]) - 1], year: Number(m[1]), text: `${MONTHS[Number(m[2]) - 1]} ${m[1]}` };
}
const pct = value => String(Math.abs(Math.round(Number(value) * 10) / 10)).replace('.', ',');
const signed = value => String(Math.round(Number(value) * 10) / 10).replace('.', ',').replace('-', '−');
const moved = value => Number(value) < 0 ? 'falt' : 'steg';

// Choose query values from table metadata by their visible labels.
export function buildQuery(metadata, spec) {
  const variables = Array.isArray(metadata?.variables) ? metadata.variables : [];
  const query = [];
  for (const variable of variables) {
    const texts = variable.valueTexts || [];
    if (variable.time || /^tid$/i.test(variable.code)) {
      query.push({ code: variable.code, selection: { filter: 'top', values: ['2'] } });
    } else if (variable.code === 'ContentsCode') {
      const index = texts.findIndex(t => TWELVE_MONTH.test(t));
      if (index < 0) throw new Error(`SSB_${spec.table}_TWELVE_MONTH_MISSING`);
      query.push({ code: variable.code, selection: { filter: 'item', values: [variable.values[index]] } });
    } else {
      const index = texts.findIndex(t => spec.group.test(String(t).trim()));
      const chosen = index >= 0 ? index : variable.elimination ? -1 : 0;
      if (chosen < 0) continue; // eliminated variables default to the total
      if (index < 0 && texts.length > 1) throw new Error(`SSB_${spec.table}_GROUP_AMBIGUOUS`);
      query.push({ code: variable.code, selection: { filter: 'item', values: [variable.values[chosen]] } });
    }
  }
  if (!query.some(q => q.selection.filter === 'top')) throw new Error(`SSB_${spec.table}_TIME_MISSING`);
  return { query, response: { format: 'json-stat2' } };
}

// JSON-stat 2: every non-time dimension has exactly one value in our query.
export function latestTwo(dataset, spec) {
  const time = dataset?.dimension?.Tid || Object.entries(dataset?.dimension || {}).find(([k]) => /^tid$/i.test(k))?.[1];
  if (!time?.category?.index) throw new Error(`SSB_${spec.table}_TIME_DIMENSION_MISSING`);
  const size = Array.isArray(dataset.size) ? dataset.size : [];
  if (size.reduce((a, b) => a * b, 1) !== dataset.value?.length) throw new Error(`SSB_${spec.table}_SHAPE`);
  if (size.filter(n => n > 1).length > 1) throw new Error(`SSB_${spec.table}_NOT_ONE_SERIES`);
  const periods = Object.entries(time.category.index).sort((a, b) => a[1] - b[1]).map(([period, i]) => ({ period, value: dataset.value[i] }));
  const [previous, latest] = periods.length >= 2 ? periods.slice(-2) : [null, periods.at(-1)];
  if (!latest || typeof latest.value !== 'number' || !Number.isFinite(latest.value)) throw new Error(`SSB_${spec.table}_VALUE_MISSING`);
  const updated = new Date(dataset.updated);
  if (!Number.isFinite(updated.getTime())) throw new Error(`SSB_${spec.table}_UPDATED_MISSING`);
  return { series: spec.id, table: spec.table, name: spec.name, short: spec.short, period: latest.period, value: latest.value,
    previousPeriod: previous?.period || null, previousValue: typeof previous?.value === 'number' ? previous.value : null,
    updated: updated.toISOString() };
}

// Deterministic flash wording: only the published figures, no interpretation.
export function releaseFlash(release, figures, { now = Date.now() } = {}) {
  const [main, ...others] = figures;
  if (!main) throw new Error('SSB_NO_FIGURES');
  if (figures.some(f => f.period !== main.period)) throw new Error('SSB_PERIOD_MISMATCH');
  const age = now - new Date(main.updated).getTime();
  if (age < -60000 || age > FRESH_MS) throw new Error('SSB_RELEASE_NOT_FRESH');
  const label = monthLabel(main.period);
  const direction = main.previousValue == null ? '' : main.value > main.previousValue ? `, opp fra ${signed(main.previousValue)} prosent måneden før`
    : main.value < main.previousValue ? `, ned fra ${signed(main.previousValue)} prosent måneden før` : ', det samme som måneden før';
  const headline = main.value < 0 ? `Prisene falt ${pct(main.value)} prosent siste tolv måneder til ${label.month}`
    : `Prisveksten var ${pct(main.value)} prosent i ${label.month}`;
  const fact = `${main.name} ${moved(main.value)} ${pct(main.value)} prosent de siste tolv månedene til ${label.text}${direction}, viser tall fra SSB.`;
  const extra = others.map(f => `${f.name} ${moved(f.value)} ${pct(f.value)} prosent siste tolv måneder.`);
  const url = `${release.pageUrl}?periode=${main.period}`;
  const summary = [fact, ...extra];
  const body = [...summary, `Tallene er hentet direkte fra SSBs statistikkbank (tabell ${figures.map(f => f.table).join(' og ')}).`,
    `Kilde: [SSB – ${main.short} ${label.text}](${release.pageUrl})`].join('\n\n');
  const text = figures.map(f => `${f.name} ${f.period}: ${f.value} (forrige ${f.previousPeriod}: ${f.previousValue}); oppdatert ${f.updated}`).join('\n');
  return { url, source: 'SSB', sourceKey: 'ssb', kind: 'ssb-release', headline, fact, summary, body, section: 'Norsk økonomi',
    slug: `ssb-${release.id}-${main.period.toLowerCase()}`, storyKey: `ssb:${release.id}:${main.period}`, enrich: false,
    publishedAt: main.updated, checkedAt: new Date(now).toISOString(), figures, text,
    hash: createHash('sha256').update(text).digest('hex') };
}

async function ssbFetch(fetcher, url, init = {}) {
  const response = await fetcher(url, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'KapitalstromNewsDesk/1.0' } });
  if (!response.ok) throw new Error(`SSB_HTTP_${response.status}`);
  return response.json();
}

// Returns fresh release flashes whose period is newer than the stored state.
export async function detectSsbReleases({ state = {}, now = Date.now(), fetcher = fetch } = {}) {
  const found = [], nextState = { ...state };
  for (const release of SSB_RELEASES) {
    const figures = [];
    for (const spec of release.series) {
      try {
        const metadata = await ssbFetch(fetcher, SSB_API + spec.table);
        figures.push(latestTwo(await ssbFetch(fetcher, SSB_API + spec.table, { method: 'POST', body: JSON.stringify(buildQuery(metadata, spec)) }), spec));
      } catch (error) { if (!spec.optional) throw error; }
    }
    const main = figures[0];
    const complete = figures.filter(f => f.period === main.period);
    if (state[release.id]?.period === main.period) continue;
    nextState[release.id] = { period: main.period, updated: main.updated };
    const age = now - new Date(main.updated).getTime();
    if (age >= -60000 && age <= FRESH_MS) found.push(releaseFlash(release, complete, { now }));
  }
  return { found, state: nextState };
}
