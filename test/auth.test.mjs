import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AuthManager, createBootstrapAuth } from '../src/auth.mjs';

const cookiePair = (session) => session.cookie.split(';')[0];
const requestWith = (session) => ({ headers: { cookie: cookiePair(session) } });

async function handoff(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function waitForNewHandoff(filePath, previousTicket, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await handoff(filePath);
    if (current.ticket !== previousTicket) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('bootstrap handoff did not rotate');
}

test('each issued ticket has a short TTL and cannot be replayed', async () => {
  const manager = new AuthManager({ ticketTtlMs: 1000, sessionTtlMs: 1000 });
  const expired = manager.issueTicket(1000);
  await assert.rejects(manager.exchange(expired.ticket, 2000), /invalid, expired/);

  const once = manager.issueTicket(3000);
  const session = await manager.exchange(once.ticket, 3001);
  assert.match(session.cookie, /HttpOnly/);
  await assert.rejects(manager.exchange(once.ticket, 3002), /already used/);
});

test('consuming the first handoff publishes a second ticket without invalidating its session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhouse-web-ticket-next-'));
  const ticketPath = path.join(root, 'handoff', 'ticket.json');
  const auth = await createBootstrapAuth({ ticketPath, ticketTtlMs: 60_000, sessionTtlMs: 60_000, maxSessions: 4 });
  assert.equal((await stat(ticketPath)).mode & 0o777, 0o600);

  const first = await handoff(ticketPath);
  const firstSession = await auth.exchange(first.ticket);
  const second = await handoff(ticketPath);
  assert.notEqual(second.ticket, first.ticket);
  await assert.rejects(auth.exchange(first.ticket), /already used/);

  const secondSession = await auth.exchange(second.ticket);
  assert.ok(auth.authenticate(requestWith(firstSession)));
  assert.ok(auth.authenticate(requestWith(secondSession)));
  const third = await handoff(ticketPath);
  assert.notEqual(third.ticket, second.ticket);
  assert.equal((await stat(ticketPath)).mode & 0o777, 0o600);
});

test('an expired handoff is automatically replaced while the service remains running', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhouse-web-ticket-expiry-'));
  const ticketPath = path.join(root, 'handoff', 'ticket.json');
  const auth = await createBootstrapAuth({ ticketPath, ticketTtlMs: 500, sessionTtlMs: 60_000, maxSessions: 4 });
  const first = await handoff(ticketPath);
  const second = await waitForNewHandoff(ticketPath, first.ticket, 2_000);
  assert.notEqual(second.ticket, first.ticket);
  await assert.rejects(auth.exchange(first.ticket), /invalid, expired/);
  assert.match((await auth.exchange(second.ticket)).cookie, /HttpOnly/);
});

test('active sessions are bounded and oldest sessions are evicted', async () => {
  const auth = new AuthManager({ ticketTtlMs: 60_000, sessionTtlMs: 60_000, maxSessions: 2 });
  const sessions = [];
  for (let index = 0; index < 3; index += 1) {
    const issued = auth.issueTicket(1000 + index);
    sessions.push(await auth.exchange(issued.ticket, 1000 + index));
  }
  assert.throws(() => auth.authenticate(requestWith(sessions[0]), 1005), /session is invalid/);
  assert.ok(auth.authenticate(requestWith(sessions[1]), 1005));
  assert.ok(auth.authenticate(requestWith(sessions[2]), 1005));
});

test('direct sessions use the ticket session contract and can all be revoked', () => {
  const auth = new AuthManager({ sessionTtlMs: 60_000, maxSessions: 4 });
  const first = auth.issueSession(1000);
  const second = auth.issueSession(1001);
  assert.match(first.cookie, /HttpOnly/);
  assert.match(first.cookie, /SameSite=Strict/);
  assert.ok(first.csrfToken);
  assert.ok(auth.authenticate(requestWith(first), 1002));
  assert.ok(auth.authenticate(requestWith(second), 1002));

  auth.revokeSessions();
  assert.throws(() => auth.authenticate(requestWith(first), 1003), /session is invalid/);
  assert.throws(() => auth.authenticate(requestWith(second), 1003), /session is invalid/);
});
