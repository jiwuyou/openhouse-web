import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

async function walk(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await walk(target));
    else out.push(target);
  }
  return out;
}

const files = [
  ...await walk(path.join(root, 'src')),
  ...await walk(path.join(root, 'public')),
  ...await walk(path.join(root, 'scripts')),
  ...await walk(path.join(root, 'test')),
];

for (const file of files.filter((value) => value.endsWith('.js') || value.endsWith('.mjs'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `syntax check failed: ${file}`);
}

for (const file of [path.join(root, 'package.json'), ...await walk(path.join(root, 'config'))].filter((value) => value.endsWith('.json'))) {
  JSON.parse(await readFile(file, 'utf8'));
}

const service = JSON.parse(await readFile(path.join(root, 'config/openhouse-web.service.json'), 'utf8'));
if (service.id !== 'openhouse-web') throw new Error('service id must be openhouse-web');
if (service.service?.residentByDefault !== true) throw new Error('openhouse-web must be resident by default');
if (service.service?.ports?.[0]?.preferred !== 22110) throw new Error('openhouse-web must prefer port 22110');

const client = await readFile(path.join(root, 'src/service-manager-client.mjs'), 'utf8');
for (const required of [
  '/api/v1/residency',
  '/residency$',
  '/api/v1/residency/',
]) {
  if (!client.includes(required)) throw new Error(`missing fixed residency contract fragment: ${required}`);
}

const server = await readFile(path.join(root, 'src/server.mjs'), 'utf8');
for (const required of [
  'auth.authenticate(req)',
  'assertMutationSecurity(req, session)',
  '/api/v1/session/exchange',
  '/api/v1/session/password',
  '/api/v1/password',
  'auth.revokeSessions()',
  'auth.issueSession()',
]) {
  if (!server.includes(required)) throw new Error(`missing authenticated BFF invariant: ${required}`);
}
const auth = await readFile(path.join(root, 'src/auth.mjs'), 'utf8');
for (const required of ['HttpOnly', 'SameSite=Strict', 'issueTicket(now = Date.now())', 'issueSession(now = Date.now())', 'maxSessions']) {
  if (!auth.includes(required)) throw new Error(`missing session security invariant: ${required}`);
}
const configSource = await readFile(path.join(root, 'src/config.mjs'), 'utf8');
if (!configSource.includes("passwordPath: path.join(dataDir, 'password')")) {
  throw new Error('password file must remain fixed at dataDir/password');
}
const passwordStore = await readFile(path.join(root, 'src/password-store.mjs'), 'utf8');
for (const required of [
  "DEFAULT_PASSWORD = '123456'",
  'MIN_PASSWORD_LENGTH = 6',
  'MAX_PASSWORD_LENGTH = 128',
  "`${password}\\n`",
  '0o700',
  '0o600',
  "rename(temporary, this.#filePath)",
]) {
  if (!passwordStore.includes(required)) throw new Error(`missing password storage invariant: ${required}`);
}
for (const forbidden of ['console.log(password', 'console.error(password', 'JSON.stringify({ password']) {
  if (server.includes(forbidden) || passwordStore.includes(forbidden)) {
    throw new Error(`password implementation contains a credential disclosure pattern: ${forbidden}`);
  }
}

const browser = await readFile(path.join(root, 'public/app.js'), 'utf8');
for (const forbidden of ['localStorage', 'SERVICE_MANAGER_TOKEN', 'Authorization: `Bearer']) {
  if (browser.includes(forbidden)) throw new Error(`browser bundle contains forbidden credential behavior: ${forbidden}`);
}

console.log(`check passed: ${files.length} files inspected`);
