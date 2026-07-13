import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_PREFERENCES = Object.freeze({
  version: 1,
  theme: 'mist',
  compactServices: false,
  hiddenAppIds: [],
  appOrder: [],
});

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))];
}

export function normalizePreferences(value = {}) {
  const theme = ['mist', 'night', 'mint'].includes(value.theme) ? value.theme : DEFAULT_PREFERENCES.theme;
  return {
    version: 1,
    theme,
    compactServices: value.compactServices === true,
    hiddenAppIds: normalizeStringArray(value.hiddenAppIds),
    appOrder: normalizeStringArray(value.appOrder),
  };
}

export class PreferencesStore {
  #path;
  #pending = Promise.resolve();

  constructor(filePath) {
    this.#path = filePath;
  }

  async read() {
    try {
      return normalizePreferences(JSON.parse(await readFile(this.#path, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return { ...DEFAULT_PREFERENCES };
      throw error;
    }
  }

  async write(value) {
    const normalized = normalizePreferences(value);
    const operation = this.#pending.then(async () => {
      await mkdir(path.dirname(this.#path), { recursive: true, mode: 0o700 });
      const temp = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.#path);
      return normalized;
    });
    this.#pending = operation.catch(() => {});
    return operation;
  }
}
