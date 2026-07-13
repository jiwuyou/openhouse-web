import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.mjs';
import { AuthManager, createBootstrapAuth } from './auth.mjs';
import { PasswordStore } from './password-store.mjs';
import { PreferencesStore } from './preferences-store.mjs';
import { ServiceManagerClient, validServiceId } from './service-manager-client.mjs';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join('; ');

function securityHeaders() {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CSP,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
}

function send(res, status, body = '', headers = {}) {
  res.writeHead(status, { ...securityHeaders(), ...headers });
  res.end(body);
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, value === null ? '' : JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
}

async function readJsonBody(req, maxBytes = 32 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 });
  }
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requestOrigin(req) {
  const proto = 'http';
  return `${proto}://${req.headers.host}`;
}

function assertHost(req, config) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!config.allowedHosts.has(host)) {
    throw Object.assign(new Error('host is not allowed'), { statusCode: 421 });
  }
}

function assertOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin !== requestOrigin(req)) {
    throw Object.assign(new Error('origin is not allowed'), { statusCode: 403 });
  }
}

function assertMutationSecurity(req, session) {
  assertOrigin(req);
  const headerToken = req.headers['x-csrf-token'];
  if (!timingSafeEqualText(headerToken, session.csrfToken)) {
    throw Object.assign(new Error('invalid CSRF token'), { statusCode: 403 });
  }
}

function serviceIdFromPath(pathname, suffix = '') {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = pathname.match(new RegExp(`^/api/v1/services/([^/]+)${escapedSuffix}$`));
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  if (!validServiceId(id)) throw Object.assign(new Error('invalid service id'), { statusCode: 400 });
  return id;
}

function residencyIdFromPath(pathname) {
  const match = pathname.match(/^\/api\/v1\/residency\/([^/]+)$/);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  if (!validServiceId(id)) throw Object.assign(new Error('invalid service id'), { statusCode: 400 });
  return id;
}

async function staticResponse(req, res, config, pathname) {
  const target = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try { decoded = decodeURIComponent(target); } catch { return false; }
  const relative = decoded.replace(/^\/+/, '');
  const filePath = path.resolve(config.publicDir, relative);
  if (filePath !== config.publicDir && !filePath.startsWith(`${config.publicDir}${path.sep}`)) return false;
  try {
    if (!(await stat(filePath)).isFile()) return false;
    const data = await readFile(filePath);
    send(res, 200, req.method === 'HEAD' ? '' : data, {
      'Content-Type': MIME_TYPES.get(path.extname(filePath)) || 'application/octet-stream',
      'Cache-Control': filePath.endsWith('.html') ? 'no-store' : 'public, max-age=300',
    });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function createApp(config, { fetchImpl = fetch, authManager, passwordStore } = {}) {
  if (!authManager) throw new Error('authManager is required');
  const preferences = new PreferencesStore(path.join(config.dataDir, 'preferences.json'));
  const passwords = passwordStore || new PasswordStore(config.passwordPath || path.join(config.dataDir, 'password'));
  const serviceManager = new ServiceManagerClient({
    origin: config.serviceManagerOrigin,
    token: config.serviceManagerToken,
    timeoutMs: config.requestTimeoutMs,
    fetchImpl,
  });
  const auth = authManager;

  return async function handler(req, res) {
    try {
      assertHost(req, config);
      const url = new URL(req.url, requestOrigin(req));
      const { pathname } = url;

      if (req.method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, { status: 'ok', service: 'openhouse-web', version: 1 });
      }
      if (req.method === 'POST' && pathname === '/api/v1/session/exchange') {
        assertOrigin(req);
        const body = await readJsonBody(req);
        if (!hasExactKeys(body, ['ticket']) || typeof body.ticket !== 'string') {
          throw Object.assign(new Error('body must be {"ticket": string}'), { statusCode: 400 });
        }
        const session = await auth.exchange(body.ticket);
        return sendJson(res, 200, { csrfToken: session.csrfToken, expiresAt: session.expiresAt }, {
          'Set-Cookie': session.cookie,
        });
      }
      if (req.method === 'POST' && pathname === '/api/v1/session/password') {
        assertOrigin(req);
        const body = await readJsonBody(req);
        if (!hasExactKeys(body, ['password']) || typeof body.password !== 'string') {
          throw Object.assign(new Error('body must be {"password": string}'), { statusCode: 400 });
        }
        if (!await passwords.verify(body.password)) {
          throw Object.assign(new Error('password is invalid'), { statusCode: 401 });
        }
        const session = auth.issueSession();
        return sendJson(res, 200, { csrfToken: session.csrfToken, expiresAt: session.expiresAt }, {
          'Set-Cookie': session.cookie,
        });
      }

      if (pathname.startsWith('/api/')) {
        const session = auth.authenticate(req);
        if (req.method === 'GET' && pathname === '/api/v1/session') {
          return sendJson(res, 200, { csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() });
        }
        if (!['GET', 'HEAD'].includes(req.method)) assertMutationSecurity(req, session);

        if (req.method === 'PUT' && pathname === '/api/v1/password') {
          const body = await readJsonBody(req);
          if (!hasExactKeys(body, ['currentPassword', 'newPassword'])
            || typeof body.currentPassword !== 'string'
            || typeof body.newPassword !== 'string'
          ) {
            throw Object.assign(
              new Error('body must be {"currentPassword": string, "newPassword": string}'),
              { statusCode: 400 },
            );
          }
          await passwords.replace(body.currentPassword, body.newPassword);
          auth.revokeSessions();
          const nextSession = auth.issueSession();
          return sendJson(res, 200, {
            csrfToken: nextSession.csrfToken,
            expiresAt: nextSession.expiresAt,
          }, {
            'Set-Cookie': nextSession.cookie,
          });
        }

        if (req.method === 'GET' && pathname === '/api/v1/dashboard') {
          const [services, statuses, residency, components] = await Promise.all([
            serviceManager.request('GET', '/api/v1/services'),
            serviceManager.request('GET', '/api/v1/services/statuses'),
            serviceManager.request('GET', '/api/v1/residency'),
            serviceManager.request('GET', '/api/v1/registry/components'),
          ]);
          return sendJson(res, 200, {
            services: services.data,
            statuses: statuses.data,
            residency: residency.data,
            components: components.data,
          });
        }
        if (req.method === 'GET' && pathname === '/api/v1/preferences') {
          return sendJson(res, 200, await preferences.read());
        }
        if (req.method === 'PUT' && pathname === '/api/v1/preferences') {
          return sendJson(res, 200, await preferences.write(await readJsonBody(req)));
        }
        if (req.method === 'GET' && pathname === '/api/v1/residency') {
          const upstream = await serviceManager.request('GET', '/api/v1/residency');
          return sendJson(res, upstream.status, upstream.data);
        }
        const residencyDeleteId = residencyIdFromPath(pathname);
        if (req.method === 'DELETE' && residencyDeleteId) {
          const upstream = await serviceManager.request('DELETE', `/api/v1/residency/${residencyDeleteId}`);
          return sendJson(res, upstream.status, upstream.data);
        }
        const residencyServiceId = serviceIdFromPath(pathname, '/residency');
        if (residencyServiceId && req.method === 'GET') {
          const upstream = await serviceManager.request('GET', `/api/v1/services/${residencyServiceId}/residency`);
          return sendJson(res, upstream.status, upstream.data);
        }
        if (residencyServiceId && req.method === 'PUT') {
          const body = await readJsonBody(req);
          if (typeof body.resident !== 'boolean' || Object.keys(body).some((key) => key !== 'resident')) {
            throw Object.assign(new Error('body must be {"resident": boolean}'), { statusCode: 400 });
          }
          const upstream = await serviceManager.request('PUT', `/api/v1/services/${residencyServiceId}/residency`, body);
          return sendJson(res, upstream.status, upstream.data);
        }
        const actionServiceId = serviceIdFromPath(pathname, '/actions');
        if (req.method === 'POST' && actionServiceId) {
          const body = await readJsonBody(req);
          const action = body.action;
          if (!['start', 'stop', 'restart', 'repair'].includes(action) || Object.keys(body).some((key) => key !== 'action')) {
            throw Object.assign(new Error('unsupported service action'), { statusCode: 400 });
          }
          const upstream = await serviceManager.request('POST', `/api/v1/services/${actionServiceId}/${action}`);
          return sendJson(res, upstream.status, upstream.data);
        }
        const logsServiceId = serviceIdFromPath(pathname, '/logs');
        if (req.method === 'GET' && logsServiceId) {
          const requestedTail = Number(url.searchParams.get('tail') || 200);
          const tail = Number.isInteger(requestedTail) ? Math.min(1000, Math.max(1, requestedTail)) : 200;
          const upstream = await serviceManager.request('GET', `/api/v1/services/${logsServiceId}/logs?limit=${tail}`);
          return sendJson(res, upstream.status, upstream.data);
        }
        const endpointsServiceId = serviceIdFromPath(pathname, '/endpoints');
        if (req.method === 'GET' && endpointsServiceId) {
          const upstream = await serviceManager.request('GET', `/api/v1/services/${endpointsServiceId}/endpoints`);
          return sendJson(res, upstream.status, upstream.data);
        }
        const detailServiceId = serviceIdFromPath(pathname);
        if (req.method === 'GET' && detailServiceId) {
          const [service, status, endpoints, residency] = await Promise.all([
            serviceManager.request('GET', `/api/v1/services/${detailServiceId}`),
            serviceManager.request('GET', `/api/v1/services/${detailServiceId}/status`),
            serviceManager.request('GET', `/api/v1/services/${detailServiceId}/endpoints`),
            serviceManager.request('GET', `/api/v1/services/${detailServiceId}/residency`),
          ]);
          return sendJson(res, 200, {
            service: service.data,
            status: status.data,
            endpoints: endpoints.data,
            residency: residency.data,
          });
        }
        return sendJson(res, 404, { error: 'API route not found' });
      }

      if (['GET', 'HEAD'].includes(req.method) && await staticResponse(req, res, config, pathname)) return;
      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      if (status >= 500) console.error('[openhouse-web]', error);
      sendJson(res, status, { error: error?.message || 'internal server error' });
    }
  };
}

export async function startServer(env = process.env) {
  const config = await loadConfig(env);
  const authManager = await createBootstrapAuth(config);
  const passwordStore = new PasswordStore(config.passwordPath);
  await passwordStore.initialize();
  const server = createServer(createApp(config, { authManager, passwordStore }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  console.log(`OpenHouse Web listening on http://${config.host}:${config.port}; bootstrap ticket: ${config.ticketPath}`);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
