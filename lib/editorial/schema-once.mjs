const clients = new WeakMap();

// Transitional protection for legacy schema helpers. Explicit migrations own
// the new case schema; old helpers share in-flight work and retry after failure.
export function schemaOnce(sql, name, initialize) {
  if (!clients.has(sql)) clients.set(sql, new Map());
  const entries = clients.get(sql);
  if (!entries.has(name)) entries.set(name, Promise.resolve().then(initialize).catch(error => {
    entries.delete(name);
    throw error;
  }));
  return entries.get(name);
}
