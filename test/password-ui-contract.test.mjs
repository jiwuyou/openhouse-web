import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

test('unauthenticated UI offers password login without pre-filling the default password', () => {
  assert.match(html, /id="login-layer"[^>]*hidden/);
  assert.match(html, /id="password-login-form"/);
  assert.match(html, /name="password"[^>]*type="password"[^>]*autocomplete="current-password"/);
  assert.match(html, /默认密码为\s*<strong>123456<\/strong>/);
  assert.doesNotMatch(html, /value="123456"/);
  assert.match(styles, /\.login-layer\[hidden\]\s*\{\s*display:\s*none/);
});

test('cookie and ticket sessions remain automatic before password login is shown', () => {
  const initialize = methodSource('async function initializeSession()', 'function normalizeDashboard');
  assert.match(initialize, /api\('\/api\/v1\/session'\)/);
  assert.match(initialize, /api\('\/api\/v1\/session\/exchange',\s*\{\s*method:\s*'POST',\s*body:\s*\{ ticket \}/);
  assert.match(initialize, /if \(!ticket\)\s*\{[\s\S]*showPasswordLogin\(\)/);
  assert.ok(initialize.indexOf("/api/v1/session/exchange") < initialize.lastIndexOf('showPasswordLogin'));
  assert.match(app, /api\('\/api\/v1\/session\/password',\s*\{\s*method:\s*'POST',\s*body:\s*\{ password \}/);
});

test('settings change-password form uses the fixed API and confirms locally', () => {
  assert.match(html, /id="password-form"/);
  assert.match(html, /name="currentPassword"[^>]*type="password"/);
  assert.match(html, /name="newPassword"[^>]*type="password"/);
  assert.match(html, /name="confirmPassword"[^>]*type="password"/);
  assert.match(app, /newPassword !== confirmPassword/);
  assert.match(app, /api\('\/api\/v1\/password',\s*\{\s*method:\s*'PUT',\s*body:\s*\{ currentPassword, newPassword \}/);
  assert.match(app, /const session = await api\('\/api\/v1\/password'[\s\S]*state\.csrfToken = session\.csrfToken/);
});

test('passwords are not retained in app state, browser storage, preferences, or diagnostics', () => {
  const stateBlock = app.slice(app.indexOf('const state = {'), app.indexOf('\n};', app.indexOf('const state = {')) + 3);
  const diagnostics = methodSource('function diagnostics()', 'function bindEvents');
  const preferencesSubmit = app.slice(
    app.indexOf("$('#preferences-form').addEventListener"),
    app.indexOf("$('#password-login-form').addEventListener"),
  );

  assert.doesNotMatch(stateBlock, /password/i);
  assert.doesNotMatch(diagnostics, /password/i);
  assert.doesNotMatch(preferencesSubmit, /password/i);
  assert.doesNotMatch(app, /localStorage|sessionStorage|indexedDB/i);
  assert.match(app, /passwordInput\.value = ''/);
  assert.match(app, /formElement\.reset\(\)/);
  assert.match(app, /currentPassword = ''[\s\S]*newPassword = ''[\s\S]*confirmPassword = ''/);
});

function methodSource(startMarker, endMarker) {
  const start = app.indexOf(startMarker);
  const end = app.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return app.slice(start, end);
}
