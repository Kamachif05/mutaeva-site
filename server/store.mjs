import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function validatePrices(input, catalog) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== catalog.length) throw new Error('invalid_prices');
  const prices = {};
  for (const { id } of catalog) {
    const value = input[id];
    if (!value || Object.keys(value).length !== 2) throw new Error('invalid_prices');
    prices[id] = {};
    for (const city of ['moscow', 'makhachkala']) {
      const price = value[city];
      if (!price || Object.keys(price).length !== 2 ||
          !Number.isInteger(price.amount) || price.amount < 0 || price.amount > 1000000 ||
          typeof price.from !== 'boolean') throw new Error('invalid_prices');
      prices[id][city] = { amount: price.amount, from: price.from };
    }
  }
  return prices;
}

export async function createStore(directory, seed) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = join(directory, 'prices.json');
  let state;
  try {
    state = JSON.parse(await readFile(filename, 'utf8'));
    state.prices = validatePrices(state.prices, seed.services);
    if (!Number.isInteger(state.revision) || state.revision < 1 ||
        !Number.isFinite(Date.parse(state.updatedAt))) throw new Error('invalid_state');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { revision: 1, updatedAt: new Date().toISOString(), prices: validatePrices(seed.prices, seed.services) };
    await writeFile(filename, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
  }
  let queue = Promise.resolve();
  return {
    read: () => structuredClone({ ...state, services: seed.services }),
    save(revision, input) {
      const task = queue.then(async () => {
        if (revision !== state.revision) return null;
        const prices = validatePrices(input, seed.services);
        const next = { revision: state.revision + 1, updatedAt: new Date().toISOString(), prices };
        const backupDirectory = join(directory, 'backups');
        await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
        const backup = join(backupDirectory, `prices-${state.revision}.json`);
        const previous = JSON.stringify(state, null, 2);
        try { await writeFile(backup, previous, { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          // A failed earlier save may already have made this exact backup.
          if (error.code !== 'EEXIST' || await readFile(backup, 'utf8') !== previous) throw error;
        }
        const temporary = join(directory, `prices-${randomUUID()}.tmp`);
        await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
        await rename(temporary, filename);
        state = next;
        return this.read();
      });
      queue = task.catch(() => {});
      return task;
    }
  };
}
