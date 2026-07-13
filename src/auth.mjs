import crypto from 'node:crypto';
import { mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';

const SESSION_COOKIE = 'oh_session';

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

export function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => {
    const [name, ...rest] = part.trim().split('=');
    return [name, rest.join('=')];
  }).filter(([name]) => name));
}

export class AuthManager {
  #tickets = new Map();
  #ticketTtlMs;
  #sessionTtlMs;
  #maxSessions;
  #sessions = new Map();
  #onTicketConsumed;

  constructor({
    ticketTtlMs = 60_000,
    sessionTtlMs = 8 * 60 * 60 * 1000,
    maxSessions = 8,
    onTicketConsumed = async () => {},
  } = {}) {
    this.#ticketTtlMs = ticketTtlMs;
    this.#sessionTtlMs = sessionTtlMs;
    this.#maxSessions = maxSessions;
    this.#onTicketConsumed = onTicketConsumed;
  }

  setTicketConsumedHook(hook) {
    this.#onTicketConsumed = hook;
  }

  issueTicket(now = Date.now()) {
    this.#prune(now);
    const ticket = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now + this.#ticketTtlMs;
    this.#tickets.set(digest(ticket).toString('hex'), expiresAt);
    while (this.#tickets.size > 4) this.#tickets.delete(this.#tickets.keys().next().value);
    return { ticket, expiresAt };
  }

  async exchange(ticket, now = Date.now()) {
    this.#prune(now);
    const key = digest(ticket).toString('hex');
    const ticketExpiresAt = this.#tickets.get(key);
    if (!ticketExpiresAt || now >= ticketExpiresAt) {
      throw Object.assign(new Error('bootstrap ticket is invalid, expired, or already used'), { statusCode: 401 });
    }
    this.#tickets.delete(key);
    await this.#onTicketConsumed();
    return this.issueSession(now);
  }

  issueSession(now = Date.now()) {
    this.#prune(now);
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now + this.#sessionTtlMs;
    while (this.#sessions.size >= this.#maxSessions) this.#sessions.delete(this.#sessions.keys().next().value);
    this.#sessions.set(digest(token).toString('hex'), { csrfToken, expiresAt });
    return {
      csrfToken,
      expiresAt: new Date(expiresAt).toISOString(),
      cookie: `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.#sessionTtlMs / 1000)}`,
    };
  }

  revokeSessions() {
    this.#sessions.clear();
  }

  authenticate(req, now = Date.now()) {
    this.#prune(now);
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) throw Object.assign(new Error('authentication required'), { statusCode: 401 });
    const key = digest(token).toString('hex');
    const session = this.#sessions.get(key);
    if (!session || now >= session.expiresAt) {
      this.#sessions.delete(key);
      throw Object.assign(new Error('session is invalid or expired'), { statusCode: 401 });
    }
    return session;
  }

  #prune(now) {
    for (const [key, expiresAt] of this.#tickets) if (now >= expiresAt) this.#tickets.delete(key);
    for (const [key, session] of this.#sessions) if (now >= session.expiresAt) this.#sessions.delete(key);
  }
}

async function atomicTicketFile(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, filePath);
}

export async function createBootstrapAuth(config) {
  const auth = new AuthManager({
    ticketTtlMs: config.ticketTtlMs,
    sessionTtlMs: config.sessionTtlMs,
    maxSessions: config.maxSessions,
  });
  let rotationTimer;
  let publishing = Promise.resolve();
  const publishNextTicket = () => {
    publishing = publishing.then(async () => {
      const issued = auth.issueTicket();
      await atomicTicketFile(config.ticketPath, {
        version: 1,
        ticket: issued.ticket,
        expiresAt: new Date(issued.expiresAt).toISOString(),
      });
      clearTimeout(rotationTimer);
      rotationTimer = setTimeout(() => {
        publishNextTicket().catch((error) => console.error('[openhouse-web] ticket rotation failed:', error.message));
      }, Math.max(1, issued.expiresAt - Date.now()));
      rotationTimer.unref?.();
    });
    return publishing;
  };
  auth.setTicketConsumedHook(publishNextTicket);
  await publishNextTicket();
  return auth;
}
