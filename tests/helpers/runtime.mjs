import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

export const root = fileURLToPath(new URL('../../', import.meta.url));

// Actual PostgreSQL engine. Lazy descriptors reproduce Neon's HTTP transaction
// boundary: constructing sql`...` must not execute a write before transaction().
export async function database() {
  const pg = new PGlite();
  const queries = [];
  const describe = (text, params = []) => ({ text, params,
    then(resolve, reject) { return execute(pg, this).then(resolve, reject); } });
  const execute = async (client, query) => {
    queries.push(query.text);
    return (await client.query(query.text, query.params)).rows;
  };
  const sql = (strings, ...params) => describe(strings.reduce((out, part, i) => out + (i ? `$${i}` : '') + part, ''), params);
  sql.query = describe;
  sql.transaction = descriptors => pg.transaction(async tx => {
    const results = [];
    for (const descriptor of descriptors) results.push(await execute(tx, descriptor));
    return results;
  });
  await pg.exec(`CREATE TABLE articles (
    id BIGSERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
    tittel TEXT NOT NULL, undertittel TEXT, brodtekst TEXT NOT NULL, seksjon TEXT,
    forfatter TEXT, bilde_url TEXT, bilde_kreditt TEXT, ai_score INT, ai_begrunnelse TEXT, ai_modell TEXT,
    tall_validert BOOLEAN DEFAULT FALSE, valideringsnotat TEXT, kilde_url TEXT, kilde_hentet TIMESTAMPTZ,
    pinned BOOLEAN DEFAULT FALSE, pinned_pos INT, publisert_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE ai_usage (id BIGSERIAL PRIMARY KEY, steg TEXT, modell TEXT, tokens_inn INT,
    tokens_ut INT, kostnad_usd NUMERIC, created_at TIMESTAMPTZ DEFAULT now());`);
  return { pg, sql, queries };
}

// The app uses Next's extensionless ES module imports. Evaluate those same source
// files, replacing only boundaries to the DB, network and paid AI provider.
export function application(sql, { ai, fetcher, environment = {} } = {}) {
  const mocks = new Map([
    [resolve(root, 'lib/db.js'), { db: () => sql }],
    [resolve(root, 'lib/ai/deepseek-client.js'), { deepSeekJsonRequest: ai || (() => { throw new Error('Unexpected paid AI call'); }) }],
    ['node:dns/promises', { lookup: async () => [{ address: '93.184.216.34', family: 4 }] }],
    ['pdf-parse', { PDFParse: class { constructor() { throw new Error('PDF is not an HTML fixture'); } } }],
  ]);
  const context = vm.createContext({ Buffer, URL, URLSearchParams, TextDecoder, TextEncoder,
    AbortController, AbortSignal, Response, Headers, Request, setTimeout, clearTimeout, console,
    process: { env: environment }, fetch: fetcher || (() => { throw new Error('Unexpected network call'); }) });
  const modules = new Map();
  const get = key => {
    if (!modules.has(key)) modules.set(key, (async () => {
      if (mocks.has(key) || !key.startsWith('/')) {
        const exports = mocks.get(key) || await import(key);
        return new vm.SyntheticModule(Object.keys(exports), function () {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { context, identifier: key });
      }
      return new vm.SourceTextModule(await readFile(key, 'utf8'), {
        context, identifier: key,
        initializeImportMeta(meta) { meta.url = pathToFileURL(key).href; },
      });
    })());
    return modules.get(key);
  };
  return {
    async load(path) {
      const module = await get(resolve(root, path));
      if (module.status === 'unlinked') await module.link((specifier, parent) => {
        let key = specifier;
        if (specifier.startsWith('.')) {
          key = resolve(dirname(parent.identifier), specifier);
          if (!extname(key)) key += '.js';
        }
        return get(key);
      });
      if (module.status !== 'evaluated') await module.evaluate();
      return module.namespace;
    },
  };
}

export async function initialize(db, app) {
  const writer = await app.load('lib/ai/write-article.js');
  const selection = await app.load('lib/autopilot/editorial-selection.js');
  await writer.ensureArticleWriterSchema(db.sql);
  await selection.ensureEditorialSelectionSchema(db.sql);
  await db.pg.exec(await readFile(resolve(root, 'migrations/001_editorial_cases.sql'), 'utf8'));
  return { writer, selection };
}
