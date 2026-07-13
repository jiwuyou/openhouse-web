import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function requiredPort(raw, fallback) {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`invalid port: ${raw}`);
  }
  return value;
}

function positiveInteger(raw, fallback, name) {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function assertLoopbackUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('SERVICE_MANAGER_URL must be an http loopback URL');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('SERVICE_MANAGER_URL must contain only scheme, host and port');
  }
  return url.origin;
}

async function tokenFromConfig(configPath) {
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    return typeof parsed.auth_token === 'string' ? parsed.auth_token.trim() : '';
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw new Error(`cannot read service-manager config: ${error.message}`);
  }
}

export async function resolveServiceManagerToken(env = process.env) {
  if (env.SERVICE_MANAGER_TOKEN?.trim()) return env.SERVICE_MANAGER_TOKEN.trim();
  if (env.SERVICE_MANAGER_TOKEN_FILE) {
    return (await readFile(env.SERVICE_MANAGER_TOKEN_FILE, 'utf8')).trim();
  }
  const defaultConfig = path.join(
    env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config'),
    'service-manager',
    'config.json',
  );
  return tokenFromConfig(env.SERVICE_MANAGER_CONFIG || defaultConfig);
}

export async function loadConfig(env = process.env) {
  const host = env.OPENHOUSE_WEB_HOST || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('OPENHOUSE_WEB_HOST must be loopback');
  const port = requiredPort(env.OPENHOUSE_WEB_PORT, 22110);
  const dataDir = env.OPENHOUSE_WEB_DATA_DIR || path.join(
    env.XDG_DATA_HOME || path.join(env.HOME || os.homedir(), '.local', 'share'),
    'openhouseai',
    'openhouse-web',
  );
  const serviceManagerOrigin = assertLoopbackUrl(env.SERVICE_MANAGER_URL || 'http://127.0.0.1:20087');
  const serviceManagerToken = await resolveServiceManagerToken(env);
  const configuredHosts = (env.OPENHOUSE_WEB_ALLOWED_HOSTS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    ...configuredHosts,
  ]);
  return {
    host,
    port,
    dataDir,
    passwordPath: path.join(dataDir, 'password'),
    publicDir: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'public'),
    serviceManagerOrigin,
    serviceManagerToken,
    allowedHosts,
    requestTimeoutMs: positiveInteger(env.OPENHOUSE_WEB_UPSTREAM_TIMEOUT_MS, 10_000, 'OPENHOUSE_WEB_UPSTREAM_TIMEOUT_MS'),
    ticketPath: env.OPENHOUSE_WEB_TICKET_FILE || path.join(dataDir, 'bootstrap-ticket.json'),
    ticketTtlMs: positiveInteger(env.OPENHOUSE_WEB_TICKET_TTL_MS, 60_000, 'OPENHOUSE_WEB_TICKET_TTL_MS'),
    sessionTtlMs: positiveInteger(env.OPENHOUSE_WEB_SESSION_TTL_MS, 28_800_000, 'OPENHOUSE_WEB_SESSION_TTL_MS'),
    maxSessions: positiveInteger(env.OPENHOUSE_WEB_MAX_SESSIONS, 8, 'OPENHOUSE_WEB_MAX_SESSIONS'),
  };
}
