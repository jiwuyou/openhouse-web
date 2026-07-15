import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AuthManager } from '../src/auth.mjs';
import { createApp } from '../src/server.mjs';

const browserApp = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const normalizeSource = browserApp.slice(
  browserApp.indexOf('function normalizeServiceStatus'),
  browserApp.indexOf('function idOfResidency'),
);
const isRunningSource = browserApp.slice(
  browserApp.indexOf('function isRunning'),
  browserApp.indexOf('function isProblem'),
);
const { normalizeServiceStatus, isRunning } = Function(
  `'use strict'; ${normalizeSource}\n${isRunningSource}\nreturn { normalizeServiceStatus, isRunning };`,
)();

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function requestStatus(port, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/health', headers }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.end();
  });
}

function mockUpstream() {
  const services = [
    { id: 'pi-web', spec: { name: 'pi-web', description: 'Pi Web', provider: 'termux-process', tags: ['openhouse-component:pi-web'] } },
    { id: 'stopped-service', spec: { name: 'stopped-service', description: 'Stopped service', provider: 'termux-process', tags: [] } },
    { id: 'failed-service', spec: { name: 'failed-service', description: 'Failed service', provider: 'termux-process', tags: [] } },
    { id: 'unknown-service', spec: { name: 'unknown-service', description: 'Unknown service', provider: 'termux-process', tags: [] } },
  ];
  const service = services[0];
  const policies = new Map(services.map(({ id }) => [id, {
    serviceId: id, resident: false, suspendedByUser: false, registered: true, updatedAt: null, lastError: null,
  }]));
  return createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer integration-secret');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/api/v1/services') return json(200, services);
    if (req.url === '/api/v1/services/statuses') return json(200, [
      { service, status: { service_id: 'pi-web', state: 'running', provider: 'termux-process', observed_at: new Date().toISOString() } },
      { service: services[1], status: { state: 'stopped', provider: 'termux-process', observed_at: new Date().toISOString() } },
      { service: services[2], status: null, error: 'provider status probe failed' },
      { service: services[3], status: {}, error: '' },
    ]);
    if (req.url === '/api/v1/residency' && req.method === 'GET') return json(200, [...policies.values()]);
    if (req.url === '/api/v1/registry/components') return json(200, [{ id: 'pi-web', path: 'components/pi-web.json', manifest: { id: 'pi-web', title: 'Pi Web', kind: 'app', shellMenu: { visible: true, entry: { type: 'webview', url: 'http://127.0.0.1:30141/' }, controlEntry: { serviceNames: ['pi-web'] } }, smallphoneApp: {}, serviceManager: { services: [] }, ai: {} } }]);
    if (req.url === '/api/v1/services/pi-web/residency' && req.method === 'PUT') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const resident = JSON.parse(Buffer.concat(chunks)).resident;
      const next = { ...policies.get('pi-web'), resident, suspendedByUser: false, updatedAt: new Date().toISOString() };
      policies.set('pi-web', next); return json(200, next);
    }
    if (req.url === '/api/v1/services/pi-web/residency') return json(200, policies.get('pi-web'));
    if (req.url === '/api/v1/services/pi-web') return json(200, service);
    if (req.url === '/api/v1/services/pi-web/status') return json(200, { service_id: 'pi-web', state: 'running', provider: 'termux-process' });
    if (req.url === '/api/v1/services/pi-web/endpoints') return json(200, { endpoints: [{ url: 'http://127.0.0.1:30141/' }] });
    json(404, { error: 'mock route not found' });
  });
}

test('server enforces host, origin and CSRF while keeping token server-side', async (t) => {
  const upstream = mockUpstream();
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'openhouse-web-integration-'));
  const config = {
    host: '127.0.0.1', port: 0, dataDir,
    passwordPath: path.join(dataDir, 'password'),
    publicDir: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'public'),
    serviceManagerOrigin: `http://127.0.0.1:${upstreamPort}`,
    serviceManagerToken: 'integration-secret', requestTimeoutMs: 2000,
    allowedHosts: new Set(),
  };
  const authManager = new AuthManager({
    ticketTtlMs: 60_000,
    sessionTtlMs: 60_000,
    maxSessions: 4,
  });
  const bootstrapTicket = authManager.issueTicket().ticket;
  const appServer = createServer(createApp(config, { authManager }));
  const port = await listen(appServer);
  t.after(() => close(appServer));
  const host = `127.0.0.1:${port}`;
  config.allowedHosts.add(host);
  const origin = `http://${host}`;

  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-security-policy'), /default-src 'self'/);

  assert.equal(await requestStatus(port, { Host: 'evil.example' }), 421);

  const unauthenticated = await fetch(`${origin}/api/v1/dashboard`);
  assert.equal(unauthenticated.status, 401);

  const passwordWrongOrigin = await fetch(`${origin}/api/v1/session/password`, {
    method: 'POST', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: '123456' }),
  });
  assert.equal(passwordWrongOrigin.status, 403);

  const malformedPasswordLogin = await fetch(`${origin}/api/v1/session/password`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: 'null',
  });
  assert.equal(malformedPasswordLogin.status, 400);

  const extraPasswordField = await fetch(`${origin}/api/v1/session/password`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: '123456', remember: true }),
  });
  assert.equal(extraPasswordField.status, 400);

  const wrongPassword = await fetch(`${origin}/api/v1/session/password`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'not-the-password' }),
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal((await wrongPassword.text()).includes('not-the-password'), false);

  const passwordLogin = await fetch(`${origin}/api/v1/session/password`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: '123456' }),
  });
  assert.equal(passwordLogin.status, 200);
  const passwordSession = await passwordLogin.json();
  const passwordCookieHeader = passwordLogin.headers.get('set-cookie');
  assert.match(passwordCookieHeader, /HttpOnly/);
  assert.match(passwordCookieHeader, /SameSite=Strict/);
  const passwordCookie = passwordCookieHeader.split(';')[0];
  assert.ok(passwordSession.csrfToken);
  assert.equal(await readFile(config.passwordPath, 'utf8'), '123456\n');
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(config.passwordPath)).mode & 0o777, 0o600);

  const wrongOrigin = await fetch(`${origin}/api/v1/session/exchange`, {
    method: 'POST', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: bootstrapTicket }),
  });
  assert.equal(wrongOrigin.status, 403);

  const exchangeResponse = await fetch(`${origin}/api/v1/session/exchange`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: bootstrapTicket }),
  });
  assert.equal(exchangeResponse.status, 200);
  const session = await exchangeResponse.json();
  const setCookie = exchangeResponse.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  assert.ok(session.csrfToken);

  const replay = await fetch(`${origin}/api/v1/session/exchange`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: bootstrapTicket }),
  });
  assert.equal(replay.status, 401);

  const dashboardResponse = await fetch(`${origin}/api/v1/dashboard`, { headers: { Cookie: cookie } });
  const dashboardText = await dashboardResponse.text();
  assert.equal(dashboardResponse.status, 200);
  assert.equal(dashboardText.includes('integration-secret'), false);
  const dashboard = JSON.parse(dashboardText);
  assert.equal(dashboard.services.length, 4);
  assert.equal(dashboard.statuses.length, 4);
  assert.deepEqual(dashboard.statuses.map((item) => item.service.id), [
    'pi-web', 'stopped-service', 'failed-service', 'unknown-service',
  ]);
  assert.equal(dashboard.statuses[0].status.state, 'running');
  assert.equal(dashboard.statuses[1].status.state, 'stopped');
  assert.equal(dashboard.statuses[2].status, null);
  assert.equal(dashboard.statuses[2].error, 'provider status probe failed');
  const normalizedStatuses = dashboard.statuses.map(normalizeServiceStatus);
  assert.deepEqual(normalizedStatuses.map((item) => [item.service_id, item.state]), [
    ['pi-web', 'running'],
    ['stopped-service', 'stopped'],
    ['failed-service', 'failed'],
    ['unknown-service', 'unknown'],
  ]);
  assert.equal(normalizedStatuses[2].message, 'provider status probe failed');
  const statusById = new Map(normalizedStatuses.map((item) => [item.service_id, item]));
  const runningCount = dashboard.services
    .filter(({ id }) => isRunning(statusById.get(id)?.state))
    .length;
  assert.equal(runningCount, 1);

  const authenticatedSession = await fetch(`${origin}/api/v1/session`, { headers: { Cookie: cookie } });
  assert.equal(authenticatedSession.status, 200);
  assert.equal((await authenticatedSession.json()).csrfToken, session.csrfToken);

  const noCsrf = await fetch(`${origin}/api/v1/services/pi-web/residency`, {
    method: 'PUT', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"resident":true}',
  });
  assert.equal(noCsrf.status, 403);

  const mutationWrongOrigin = await fetch(`${origin}/api/v1/services/pi-web/residency`, {
    method: 'PUT',
    headers: { Origin: 'http://evil.example', Cookie: cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: '{"resident":true}',
  });
  assert.equal(mutationWrongOrigin.status, 403);

  const update = await fetch(`${origin}/api/v1/services/pi-web/residency`, {
    method: 'PUT',
    headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: '{"resident":true}',
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).resident, true);

  const passwordWithoutSession = await fetch(`${origin}/api/v1/password`, {
    method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: '123456', newPassword: 'updated-password' }),
  });
  assert.equal(passwordWithoutSession.status, 401);

  const passwordWithoutCsrf = await fetch(`${origin}/api/v1/password`, {
    method: 'PUT', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: '123456', newPassword: 'updated-password' }),
  });
  assert.equal(passwordWithoutCsrf.status, 403);

  const passwordWrongOriginMutation = await fetch(`${origin}/api/v1/password`, {
    method: 'PUT',
    headers: { Origin: 'http://evil.example', Cookie: cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: '123456', newPassword: 'updated-password' }),
  });
  assert.equal(passwordWrongOriginMutation.status, 403);

  const wrongCurrentPassword = await fetch(`${origin}/api/v1/password`, {
    method: 'PUT',
    headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: '654321', newPassword: 'updated-password' }),
  });
  assert.equal(wrongCurrentPassword.status, 401);
  assert.equal((await wrongCurrentPassword.text()).includes('654321'), false);

  const passwordUpdate = await fetch(`${origin}/api/v1/password`, {
    method: 'PUT',
    headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: '123456', newPassword: 'updated-password' }),
  });
  assert.equal(passwordUpdate.status, 200);
  const passwordUpdateText = await passwordUpdate.text();
  assert.equal(passwordUpdateText.includes('123456'), false);
  assert.equal(passwordUpdateText.includes('updated-password'), false);
  const nextSession = JSON.parse(passwordUpdateText);
  const nextCookieHeader = passwordUpdate.headers.get('set-cookie');
  assert.match(nextCookieHeader, /HttpOnly/);
  const nextCookie = nextCookieHeader.split(';')[0];
  assert.ok(nextSession.csrfToken);
  assert.notEqual(nextSession.csrfToken, session.csrfToken);
  assert.equal(await readFile(config.passwordPath, 'utf8'), 'updated-password\n');

  assert.equal((await fetch(`${origin}/api/v1/session`, { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await fetch(`${origin}/api/v1/session`, { headers: { Cookie: passwordCookie } })).status, 401);
  assert.equal((await fetch(`${origin}/api/v1/session`, { headers: { Cookie: nextCookie } })).status, 200);

  const oldPasswordLogin = await fetch(`${origin}/api/v1/session/password`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: '123456' }),
  });
  assert.equal(oldPasswordLogin.status, 401);

  const newPasswordLogin = await fetch(`${origin}/api/v1/session/password`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'updated-password' }),
  });
  assert.equal(newPasswordLogin.status, 200);
  assert.match(newPasswordLogin.headers.get('set-cookie'), /HttpOnly/);
});
