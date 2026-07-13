import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_PREFERENCES, PreferencesStore, normalizePreferences } from '../src/preferences-store.mjs';

test('preferences normalize to a bounded schema', () => {
  assert.deepEqual(normalizePreferences({ theme: 'unknown', compactServices: 1, hiddenAppIds: ['a', 'a', '', 4], appOrder: ['b'] }), {
    ...DEFAULT_PREFERENCES,
    hiddenAppIds: ['a'],
    appOrder: ['b'],
  });
});

test('preferences are atomically persisted with private permissions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhouse-web-pref-'));
  const target = path.join(root, 'nested', 'preferences.json');
  const store = new PreferencesStore(target);
  await Promise.all([
    store.write({ theme: 'night', hiddenAppIds: ['one'] }),
    store.write({ theme: 'mint', compactServices: true }),
  ]);
  assert.deepEqual(await store.read(), {
    ...DEFAULT_PREFERENCES,
    theme: 'mint',
    compactServices: true,
  });
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  const contents = await readFile(target, 'utf8');
  assert.doesNotThrow(() => JSON.parse(contents));
});
