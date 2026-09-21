// Run the actual Next.js application modules from a bounded CI validation job.
// Only the DB factory is injected. Sources, DNS and DeepSeek remain real.
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
export function application(sql) {
  const context = vm.createContext({ Buffer, URL, URLSearchParams, TextDecoder, TextEncoder,
    AbortController, AbortSignal, Response, Headers, Request, setTimeout, clearTimeout, console, process, fetch });
  const modules = new Map();
  const get = key => {
    if (!modules.has(key)) modules.set(key, (async () => {
      if (key === resolve(root, 'lib/db.js') || !key.startsWith('/')) {
        const exports = key === resolve(root, 'lib/db.js') ? { db: () => sql } : await import(key);
        return new vm.SyntheticModule(Object.keys(exports), function () {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { context, identifier: key });
      }
      return new vm.SourceTextModule(await readFile(key, 'utf8'), { context, identifier: key,
        initializeImportMeta(meta) { meta.url = pathToFileURL(key).href; } });
    })());
    return modules.get(key);
  };
  return { async load(path) {
    const module = await get(resolve(root, path));
    if (module.status === 'unlinked') await module.link((specifier, parent) => {
      let key = specifier;
      if (specifier.startsWith('.')) { key = resolve(dirname(parent.identifier), specifier); if (!extname(key)) key += '.js'; }
      return get(key);
    });
    if (module.status !== 'evaluated') await module.evaluate();
    return module.namespace;
  } };
}
