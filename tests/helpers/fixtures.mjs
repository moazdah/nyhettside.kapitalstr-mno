import { articleSnapshot, factSnapshot, fingerprint, newDossier, verificationBlocks } from '../../lib/editorial/contract.mjs';

export const sourceUrl = 'https://www.equinor.com/news/20260920-contract';
export const sourceText = 'Equinor har inngått en kontrakt verdt 2 milliarder kroner. Leveransene starter i 2027.';
export function fixture(now = Date.now()) {
  const item = { id: 1, event_key: 'equinor-contract-2026', title: 'Equinor inngår milliardkontrakt',
    summary: sourceText, source_name: 'Equinor', url: sourceUrl, candidate_type: 'kontrakt' };
  const documents = [{ name: 'Equinor', url: sourceUrl, role: 'primary', quality: 'corporate_official', fetched: true,
    publication: { at: new Date(now - 60_000).toISOString(), kind: 'publication_meta' }, documentType: 'article', text: sourceText }];
  const pack = { canWrite: true, matchesEvent: true, confidence: 90, headlineFact: 'Equinor har inngått en kontrakt.',
    headlineFactIds: ['F1'], facts: [{ id: 'F1', fact: sourceText, source_url: sourceUrl, evidence_quote: sourceText }],
    numbers: [{ id: 'N1', value: '2', unit: 'milliarder', currency: 'NOK', entity: 'Equinor',
      source_url: sourceUrl, evidence_quote: sourceText }], entities: ['Equinor'], unknowns: [] };
  const draft = { title: 'Equinor inngår milliardkontrakt', dek: 'Avtalen er verdt 2 milliarder kroner.',
    paragraphs: ['Equinor har inngått en kontrakt verdt 2 milliarder kroner.', 'Leveransene starter i 2027.'],
    section: 'Selskaper', aiAnalysis: '' };
  const response = { passed: true, personal_advice: false, checks: verificationBlocks(draft).map(block => ({
    id: block.id, supported: true, fact_ids: ['F1'], entity_numbers_units_dates_match: true, reason: 'Støttes av F1.' })) };
  const snapshot = factSnapshot({ version: 'fact-pack-v10', primary_source_name: 'Equinor', primary_source_url: sourceUrl,
    source_role: 'primary', source_quality: 'corporate_official', source_hash: fingerprint(sourceText), headline_fact: pack.headlineFact,
    event_type: 'contract', facts: pack.facts, numbers: pack.numbers, entities: pack.entities, unknowns: [],
    market_relevance: 'Norsk børsnotert selskap.', analysis_signals: {}, can_write: true, confidence: 90 });
  const article = { tittel: draft.title, undertittel: draft.dek, brodtekst: draft.paragraphs.join('\n\n'), seksjon: draft.section, tall_validert: true };
  const textSnapshot = articleSnapshot(article);
  const dossier = { ...newDossier(item), sources: documents, factPack: snapshot, factPackHash: fingerprint(snapshot),
    research: { passed: true, reasons: [] }, draft: { ...textSnapshot, hash: fingerprint(textSnapshot) }, verification: { passed: true, reasons: [] } };
  return { item, documents, pack, draft, response, snapshot, article, dossier };
}
