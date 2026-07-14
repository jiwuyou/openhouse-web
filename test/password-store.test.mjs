import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_PASSWORD,
  PasswordStore,
  validatePassword,
} from '../src/password-store.mjs';

test('missing password is atomically initialized to the fixed default with private permissions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhouse-web-password-init-'));
  const dataDir = path.join(root, 'data');
  const passwordPath = path.join(dataDir, 'password');
  const store = new PasswordStore(passwordPath);

  assert.equal(await store.initialize(), DEFAULT_PASSWORD);
  assert.equal(await readFile(passwordPath, 'utf8'), '123456\n');
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(passwordPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dataDir), ['password']);
});

test('concurrent stores initialize once without overwriting the winner or leaving temporary files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhouse-web-password-concurrent-'));
  const dataDir = path.join(root, 'data');
  const passwordPath = path.join(dataDir, 'password');
  const first = new PasswordStore(passwordPath);
  const second = new PasswordStore(passwordPath);

  assert.deepEqual(
    await Promise.all([first.initialize(), second.initialize()]),
    [DEFAULT_PASSWORD, DEFAULT_PASSWORD],
  );
  await first.replace(DEFAULT_PASSWORD, 'winner-password');

  const later = new PasswordStore(passwordPath);
  assert.equal(await later.initialize(), 'winner-password');
  assert.equal(await readFile(passwordPath, 'utf8'), 'winner-password\n');
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(passwordPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dataDir), ['password']);
});

test('existing plaintext password is preserved and permissions are tightened', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhouse-web-password-existing-'));
  const dataDir = path.join(root, 'data');
  const passwordPath = path.join(dataDir, 'password');
  await mkdir(dataDir, { mode: 0o755 });
  await writeFile(passwordPath, 'existing-password\n', { mode: 0o644 });

  const store = new PasswordStore(passwordPath);
  assert.equal(await store.initialize(), 'existing-password');
  assert.equal(await readFile(passwordPath, 'utf8'), 'existing-password\n');
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(passwordPath)).mode & 0o777, 0o600);
});

test('password replacement verifies the old value and leaves no temporary files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhouse-web-password-replace-'));
  const dataDir = path.join(root, 'data');
  const passwordPath = path.join(dataDir, 'password');
  const store = new PasswordStore(passwordPath);
  await store.initialize();

  assert.equal(await store.verify('123456'), true);
  assert.equal(await store.verify('654321'), false);
  await assert.rejects(
    store.replace('654321', 'new-password'),
    (error) => error?.statusCode === 401 && /current password is invalid/.test(error.message),
  );
  assert.equal(await readFile(passwordPath, 'utf8'), '123456\n');

  await store.replace('123456', 'new-password');
  assert.equal(await store.verify('123456'), false);
  assert.equal(await store.verify('new-password'), true);
  assert.equal(await readFile(passwordPath, 'utf8'), 'new-password\n');
  assert.equal((await stat(passwordPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dataDir), ['password']);
});

test('password validation uses a 6-128 character contract and rejects line/control delimiters', () => {
  assert.equal(validatePassword('123456'), '123456');
  assert.equal(validatePassword('😀😀😀😀😀😀'), '😀😀😀😀😀😀');
  assert.throws(() => validatePassword('12345'), /6-128/);
  assert.throws(() => validatePassword('x'.repeat(129)), /6-128/);
  assert.throws(() => validatePassword('abc\rdef'), /CR, LF, or NUL/);
  assert.throws(() => validatePassword('abc\ndef'), /CR, LF, or NUL/);
  assert.throws(() => validatePassword('abc\0def'), /CR, LF, or NUL/);
  assert.throws(() => validatePassword(null), /must be a string/);
});
