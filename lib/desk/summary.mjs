// «Saken oppsummert»: short points taken only from facts that already passed
// research with a verbatim source excerpt. No extra model call, no AI opinion.
// The article's separate AI assessment stays in its own labelled block.

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

export function factSummary(pack, { max = 4 } = {}) {
  const facts = Array.isArray(pack?.facts) ? pack.facts : [];
  const seen = new Set();
  const points = [];
  for (const fact of facts) {
    let text = clean(fact?.fact);
    if (text.length < 12 || !clean(fact?.evidence_quote) || !fact?.source_url) continue;
    const key = text.toLowerCase().replace(/[^a-z0-9æøå]+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    if (fact.attribution_needed === true && fact.source_name && !text.toLowerCase().includes(String(fact.source_name).toLowerCase())) {
      text = `${text.replace(/[.]$/, '')}, ifølge ${clean(fact.source_name)}.`;
    }
    points.push({ text: text.length > 300 ? `${text.slice(0, 297).replace(/\s+\S*$/, '')} …` : text,
      kind: 'fact', source_url: fact.source_url, fact_id: fact.id || null });
    if (points.length >= max) break;
  }
  return points;
}

// Old rows store plain strings (fast-track flashes); new rows store objects.
export function normalizeSummary(points) {
  return (Array.isArray(points) ? points : []).map(point => typeof point === 'string'
    ? { text: point, kind: 'fact' } : { ...point, text: clean(point?.text), kind: point?.kind === 'assessment' ? 'assessment' : 'fact' })
    .filter(point => point.text);
}
