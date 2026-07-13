import { normalizeResidencyPolicy, residencyPresentation } from './state-core.js';

const state = {
  csrfToken: '',
  connected: false,
  services: [],
  statuses: new Map(),
  residency: new Map(),
  components: [],
  apps: [],
  preferences: { theme: 'mist', compactServices: false, hiddenAppIds: [], appOrder: [] },
  filter: 'all',
  selectedServiceId: '',
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function arrayFrom(value, keys = []) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function idOfService(service) {
  return String(service?.id || service?.serviceId || service?.service_id || service?.spec?.name || '');
}

function idOfStatus(status) {
  return String(status?.serviceId || status?.service_id || status?.id || '');
}

function idOfResidency(policy) {
  return String(policy?.serviceId || policy?.service_id || policy?.id || '');
}

function stateOf(id) {
  return String(state.statuses.get(id)?.state || 'unknown').toLowerCase();
}

function policyOf(id) {
  return normalizeResidencyPolicy(state.residency.get(id), id);
}

function isRunning(value) {
  return ['running', 'starting'].includes(String(value).toLowerCase());
}

function isProblem(value) {
  return ['failed', 'unknown'].includes(String(value).toLowerCase());
}

function statusLabel(value) {
  return ({ running: '运行中', starting: '启动中', stopped: '已停止', stopping: '停止中', failed: '异常', unknown: '未知' })[value] || value;
}

function initials(value) {
  const clean = String(value || 'OH').replace(/[^\p{L}\p{N}]/gu, '');
  return clean.slice(0, 2).toUpperCase() || 'OH';
}

function safeLocalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let toastTimer;
let dashboardRefreshTimer;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('toast-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('toast-visible'), 2600);
}

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(options.method || 'GET')) headers['X-CSRF-Token'] = state.csrfToken;
  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.error || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function takeBootstrapTicket() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const ticket = params.get('ticket') || '';
  if (ticket) history.replaceState(null, '', `${location.pathname}${location.search}`);
  return ticket;
}

function setFormMessage(selector, message = '', success = false) {
  const node = $(selector);
  node.textContent = message;
  node.classList.toggle('form-success', Boolean(message) && success);
}

function showPasswordLogin(message = '') {
  clearInterval(dashboardRefreshTimer);
  dashboardRefreshTimer = undefined;
  const layer = $('#login-layer');
  layer.hidden = false;
  setFormMessage('#login-message', message);
  requestAnimationFrame(() => $('#login-password').focus());
}

function hidePasswordLogin() {
  $('#password-login-form').reset();
  setFormMessage('#login-message');
  $('#login-layer').hidden = true;
}

async function initializeSession() {
  const ticket = takeBootstrapTicket();
  try {
    const session = await api('/api/v1/session');
    state.csrfToken = session.csrfToken;
    return true;
  } catch (error) {
    if (error.status !== 401) throw error;
    if (!ticket) {
      showPasswordLogin();
      return false;
    }
  }
  try {
    const session = await api('/api/v1/session/exchange', { method: 'POST', body: { ticket } });
    state.csrfToken = session.csrfToken;
    return true;
  } catch (error) {
    showPasswordLogin(`一次性票据不可用，请使用密码登录。${error.message ? ` ${error.message}` : ''}`);
    return false;
  }
}

function normalizeDashboard(payload) {
  state.services = arrayFrom(payload.services, ['services']);
  state.statuses = new Map(arrayFrom(payload.statuses, ['statuses', 'services'])
    .filter(idOfStatus).map((item) => [idOfStatus(item), item]));
  state.residency = new Map(arrayFrom(payload.residency, ['residency', 'policies', 'services'])
    .filter(idOfResidency).map((item) => [idOfResidency(item), normalizeResidencyPolicy(item)]));
  state.components = arrayFrom(payload.components, ['components']);
  state.apps = buildApps(state.components, state.services);
}

function componentServiceIds(manifest) {
  const ids = new Set();
  for (const key of ['shellMenu', 'smallphoneApp']) {
    for (const id of manifest?.[key]?.controlEntry?.serviceNames || []) ids.add(id);
  }
  for (const service of manifest?.serviceManager?.services || []) {
    if (service?.name) ids.add(service.name);
  }
  return [...ids];
}

function buildApps(components, services) {
  const apps = [];
  for (const record of components) {
    const manifest = record?.manifest || record;
    const layer = manifest?.shellMenu || manifest?.smallphoneApp || {};
    if (!manifest?.id || layer.visible === false || !['app', undefined].includes(manifest.kind)) continue;
    const entry = layer.entry || manifest?.smallphoneApp?.entry;
    apps.push({
      id: manifest.id,
      title: manifest.title || manifest.id,
      description: manifest.description || '',
      url: safeLocalUrl(entry?.url || ''),
      serviceIds: componentServiceIds(manifest),
      order: Number(layer.order || 1000),
    });
  }
  if (!apps.length) {
    for (const service of services) {
      const id = idOfService(service);
      const componentTag = service?.spec?.tags?.find((tag) => tag.startsWith('openhouse-component:'));
      if (!componentTag || id === 'openhouse-web') continue;
      apps.push({
        id: componentTag.slice('openhouse-component:'.length),
        title: service.spec?.name || id,
        description: service.spec?.description || '',
        url: '',
        serviceIds: [id],
        order: 1000,
      });
    }
  }
  const order = new Map(state.preferences.appOrder.map((id, index) => [id, index]));
  return apps
    .filter((app) => !state.preferences.hiddenAppIds.includes(app.id))
    .sort((a, b) => (order.get(a.id) ?? a.order) - (order.get(b.id) ?? b.order) || a.title.localeCompare(b.title));
}

function setConnected(connected, message = '') {
  state.connected = connected;
  const pill = $('#connection-pill');
  pill.classList.toggle('connected', connected);
  pill.classList.toggle('disconnected', !connected);
  $('#connection-label').textContent = connected ? '控制面已连接' : '控制面不可用';
  const health = $('#maintenance-health');
  health.classList.toggle('healthy', connected);
  health.classList.toggle('unhealthy', !connected);
  $('strong', health).textContent = connected ? '控制中枢工作正常' : '无法连接控制中枢';
  $('p', health).textContent = connected ? '服务、常驻与应用注册表均可读取。' : (message || '请使用 Android 原生 Recovery 修复 service-manager。');
}

async function refreshDashboard({ quiet = false } = {}) {
  try {
    normalizeDashboard(await api('/api/v1/dashboard'));
    setConnected(true);
    renderAll();
    if (!quiet) toast('状态已刷新');
  } catch (error) {
    if (error.status === 401) {
      state.csrfToken = '';
      showPasswordLogin('会话已过期，请重新输入密码。');
      return;
    }
    setConnected(false, error.message);
    renderMaintenance();
    if (!quiet) toast(error.message);
  }
}

function renderOverview() {
  const running = state.services.filter((service) => isRunning(stateOf(idOfService(service)))).length;
  const resident = [...state.residency.values()].filter((policy) => policy.resident).length;
  $('#running-count').textContent = String(running);
  $('#resident-count').textContent = String(resident);
  $('#service-count').textContent = String(state.services.length);
  $('#desktop-summary').textContent = `${state.apps.length} 个应用 · ${running} 个服务正在运行`;
}

function renderApps() {
  const grid = $('#app-grid');
  grid.replaceChildren();
  $('#app-empty').classList.toggle('hidden', state.apps.length > 0);
  for (const app of state.apps) {
    const button = el('button', 'app-button');
    button.type = 'button';
    button.dataset.appId = app.id;
    const icon = el('span', 'app-icon', initials(app.title));
    const appRunning = app.serviceIds.some((id) => isRunning(stateOf(id)));
    icon.append(el('span', `app-state-dot ${appRunning ? 'running' : ''}`));
    button.append(icon, el('strong', '', app.title));
    button.addEventListener('click', () => openApp(app));
    grid.append(button);
  }
}

function filteredServices() {
  const registeredIds = new Set(state.services.map(idOfService));
  const orphanPolicies = [...state.residency.values()]
    .filter((policy) => policy.registered === false && !registeredIds.has(policy.serviceId))
    .map((policy) => ({ id: policy.serviceId, spec: { name: policy.serviceId, description: '服务暂未注册' }, orphanedPolicy: true }));
  return [...state.services, ...orphanPolicies].filter((service) => {
    const id = idOfService(service);
    const policy = policyOf(id);
    if (state.filter === 'resident') return policy.resident;
    if (state.filter === 'on-demand') return !policy.resident;
    if (state.filter === 'problem') return isProblem(stateOf(id)) || Boolean(policy.lastError);
    return true;
  });
}

function serviceCard(service) {
  const id = idOfService(service);
  const status = stateOf(id);
  const policy = policyOf(id);
  const residency = residencyPresentation(policy, id);
  const card = el('article', 'service-card');
  const orb = el('button', 'service-orb', initials(service?.spec?.name || id));
  orb.type = 'button';
  if (!service.orphanedPolicy) orb.addEventListener('click', () => openService(id));
  const copy = el('button', 'service-copy');
  copy.type = 'button';
  copy.style.cssText = 'border:0;background:transparent;text-align:left;padding:0;';
  copy.append(el('strong', '', service?.spec?.name || id));
  const meta = el('span', 'service-meta');
  meta.append(el('span', `state-badge ${status}`, statusLabel(status)));
  meta.append(el('span', `residency-badge ${residency.tone}`, residency.label));
  copy.append(meta);
  if (!service.orphanedPolicy) copy.addEventListener('click', () => openService(id));
  if (service.orphanedPolicy) {
    const remove = el('button', 'danger-button', '移除');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await api(`/api/v1/residency/${encodeURIComponent(id)}`, { method: 'DELETE' });
        state.residency.delete(id);
        toast('已移除未注册服务的常驻策略');
        renderAll();
      } catch (error) { toast(error.message); }
      finally { remove.disabled = false; }
    });
    card.append(orb, copy, remove);
    return card;
  }
  const toggle = el('label', 'resident-toggle');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(policy.resident);
  input.setAttribute('aria-label', `${service?.spec?.name || id} 常驻`);
  input.addEventListener('change', async () => {
    input.disabled = true;
    try { await setResidency(id, input.checked); }
    catch (error) { input.checked = !input.checked; toast(error.message); }
    finally { input.disabled = false; }
  });
  toggle.append(input, el('span', '', '常驻'));
  card.append(orb, copy, toggle);
  return card;
}

function renderServices() {
  const list = $('#service-list');
  list.classList.toggle('compact', state.preferences.compactServices);
  list.replaceChildren();
  const services = filteredServices();
  if (!services.length) list.append(el('div', 'empty-state', '此筛选下没有服务。'));
  else services.forEach((service) => list.append(serviceCard(service)));
}

function renderMaintenance() {
  const list = $('#attention-list');
  list.replaceChildren();
  const issues = [];
  if (!state.connected) issues.push({ title: '控制中枢不可用', detail: 'Web 层不能修复控制中枢，请进入 Android 原生 Recovery。' });
  for (const service of state.services) {
    const id = idOfService(service);
    const policy = policyOf(id);
    if (isProblem(stateOf(id))) issues.push({ title: `${service.spec?.name || id} 状态异常`, detail: state.statuses.get(id)?.message || '打开服务详情查看日志或执行修复。' });
    if (policy.lastError) issues.push({ title: `${service.spec?.name || id} 常驻恢复失败`, detail: policy.lastError });
    else if (policy.resident && policy.suspendedByUser) issues.push({ title: `${service.spec?.name || id} 常驻已暂停`, detail: '手动启动或重启会解除暂停。' });
  }
  for (const policy of state.residency.values()) {
    if (policy.registered === false) issues.push({ title: `${policy.serviceId} 服务暂未注册`, detail: '常驻策略仍被保留，可在服务控制中移除。' });
  }
  if (!issues.length) issues.push({ title: '没有待处理事项', detail: '当前未检测到服务或常驻异常。' });
  for (const issue of issues) {
    const item = el('article', 'attention-item');
    item.append(el('strong', '', issue.title), el('p', '', issue.detail));
    list.append(item);
  }
}

function renderPreferences() {
  document.body.dataset.theme = state.preferences.theme;
  const radio = $(`input[name="theme"][value="${state.preferences.theme}"]`);
  if (radio) radio.checked = true;
  $('#compact-services').checked = state.preferences.compactServices;
}

function renderAll() {
  renderOverview();
  renderApps();
  renderServices();
  renderMaintenance();
  renderPreferences();
}

async function setResidency(id, resident) {
  const policy = await api(`/api/v1/services/${encodeURIComponent(id)}/residency`, { method: 'PUT', body: { resident } });
  state.residency.set(id, normalizeResidencyPolicy(policy, id));
  toast(resident ? '已设为常驻并启动' : '已取消常驻，当前进程保持不变');
  await refreshDashboard({ quiet: true });
}

async function serviceAction(id, action) {
  await api(`/api/v1/services/${encodeURIComponent(id)}/actions`, { method: 'POST', body: { action } });
  toast(({ start: '启动请求已发送', stop: '停止请求已发送', restart: '重启请求已发送', repair: '修复请求已发送' })[action]);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await refreshDashboard({ quiet: true });
  if ($('#service-dialog').open) await openService(id);
}

function endpointUrl(payload) {
  const values = arrayFrom(payload, ['endpoints']);
  for (const endpoint of values) {
    if (typeof endpoint?.url === 'string') return safeLocalUrl(endpoint.url);
    if (endpoint?.scheme && endpoint?.host && endpoint?.port) return safeLocalUrl(`${endpoint.scheme}://${endpoint.host}:${endpoint.port}${endpoint.path || '/'}`);
  }
  return '';
}

async function openApp(app) {
  const primary = app.serviceIds[0];
  if (!primary) {
    if (app.url) window.open(app.url, '_blank', 'noopener,noreferrer');
    else toast('此应用没有服务入口');
    return;
  }
  await openService(primary, app);
}

async function openService(id, app = null) {
  state.selectedServiceId = id;
  const dialog = $('#service-dialog');
  $('#dialog-title').textContent = app?.title || id;
  const body = $('#dialog-body');
  body.replaceChildren(el('p', 'detail-description', '正在读取服务详情…'));
  if (!dialog.open) dialog.showModal();
  try {
    const detail = await api(`/api/v1/services/${encodeURIComponent(id)}`);
    if (state.selectedServiceId !== id) return;
    renderServiceDialog(id, detail, app);
  } catch (error) {
    body.replaceChildren(el('p', 'detail-description', error.message));
  }
}

function renderServiceDialog(id, detail, app) {
  const body = $('#dialog-body');
  body.replaceChildren();
  const service = detail.service || {};
  const status = String(detail.status?.state || stateOf(id)).toLowerCase();
  const policy = normalizeResidencyPolicy(detail.residency || policyOf(id), id);
  const residency = residencyPresentation(policy, id);
  const badges = el('div', 'detail-state');
  badges.append(el('span', `state-badge ${status}`, statusLabel(status)));
  badges.append(el('span', `residency-badge ${residency.tone}`, residency.label));
  body.append(badges);
  body.append(el('p', 'detail-description', app?.description || service?.spec?.description || '本机服务'));

  const actions = el('div', 'detail-actions');
  for (const [action, label, className] of [
    ['start', '启动', 'primary-button'], ['restart', '重启', 'secondary-button'],
    ['stop', '停止', 'danger-button'], ['repair', '修复', 'secondary-button'],
  ]) {
    const button = el('button', className, label);
    button.type = 'button';
    button.addEventListener('click', () => serviceAction(id, action).catch((error) => toast(error.message)));
    actions.append(button);
  }
  body.append(actions);

  const residentRow = el('label', 'detail-row');
  residentRow.append(el('span', '', '常驻服务'));
  const resident = document.createElement('input');
  resident.type = 'checkbox';
  resident.checked = Boolean(policy.resident);
  resident.addEventListener('change', () => setResidency(id, resident.checked).then(() => openService(id, app)).catch((error) => { resident.checked = !resident.checked; toast(error.message); }));
  residentRow.append(resident);
  body.append(residentRow);

  const endpoint = endpointUrl(detail.endpoints) || app?.url || '';
  if (endpoint) {
    const open = el('button', 'primary-button', '打开应用');
    open.type = 'button';
    open.style.width = '100%';
    open.addEventListener('click', () => window.open(endpoint, '_blank', 'noopener,noreferrer'));
    body.append(open);
  }
  for (const [label, value] of [['服务 ID', id], ['Provider', service?.spec?.provider || detail.status?.provider || '—'], ['PID', detail.status?.pid || '—']]) {
    const row = el('div', 'detail-row');
    row.append(el('span', '', label), el('code', '', String(value)));
    body.append(row);
  }
  const logs = el('button', 'secondary-button', '读取最近日志');
  logs.type = 'button';
  logs.style.width = '100%';
  logs.addEventListener('click', async () => {
    logs.disabled = true;
    try {
      const payload = await api(`/api/v1/services/${encodeURIComponent(id)}/logs?tail=200`);
      const text = typeof payload === 'string' ? payload : payload?.logs || payload?.content || JSON.stringify(payload, null, 2);
      const old = $('.log-box', body);
      if (old) old.remove();
      logs.before(el('pre', 'log-box', text || '没有日志。'));
    } catch (error) { toast(error.message); }
    finally { logs.disabled = false; }
  });
  body.append(logs);
}

function navigate(view) {
  $$('.view').forEach((node) => node.classList.toggle('view-active', node.dataset.view === view));
  $$('[data-nav]').forEach((node) => node.classList.toggle('tab-active', node.dataset.nav === view));
}

function diagnostics() {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    connected: state.connected,
    services: state.services.map((service) => {
      const id = idOfService(service);
      const policy = policyOf(id);
      return { id, state: stateOf(id), resident: policy.resident, suspendedByUser: policy.suspendedByUser, lastError: policy.lastError || null };
    }),
  }, null, 2);
}

function bindEvents() {
  $$('[data-nav]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.nav)));
  $$('[data-refresh]').forEach((button) => button.addEventListener('click', () => refreshDashboard()));
  $('#refresh-button').addEventListener('click', () => refreshDashboard());
  $('#refresh-all').addEventListener('click', () => refreshDashboard());
  $('#connection-pill').addEventListener('click', () => navigate('maintenance'));
  $$('.filter-chip').forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    $$('.filter-chip').forEach((item) => item.classList.toggle('filter-active', item === button));
    renderServices();
  }));
  $('#preferences-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      state.preferences = await api('/api/v1/preferences', {
        method: 'PUT',
        body: { ...state.preferences, theme: form.get('theme'), compactServices: $('#compact-services').checked },
      });
      state.apps = buildApps(state.components, state.services);
      renderAll();
      toast('设置已保存');
    } catch (error) { toast(error.message); }
  });
  $('#password-login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $('button[type="submit"]', form);
    const passwordInput = $('#login-password');
    let password = passwordInput.value;
    passwordInput.value = '';
    submit.disabled = true;
    setFormMessage('#login-message');
    try {
      const session = await api('/api/v1/session/password', {
        method: 'POST',
        body: { password },
      });
      state.csrfToken = session.csrfToken;
      hidePasswordLogin();
      await loadAuthenticatedUi();
    } catch (error) {
      setFormMessage('#login-message', error.status === 401 ? '密码错误，请重新输入。' : error.message);
      passwordInput.focus();
    } finally {
      password = '';
      submit.disabled = false;
    }
  });
  $('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const submit = $('button[type="submit"]', formElement);
    let currentPassword = String(form.get('currentPassword') || '');
    let newPassword = String(form.get('newPassword') || '');
    let confirmPassword = String(form.get('confirmPassword') || '');
    formElement.reset();
    setFormMessage('#password-message');
    if (newPassword !== confirmPassword) {
      setFormMessage('#password-message', '两次输入的新密码不一致。');
      currentPassword = '';
      newPassword = '';
      confirmPassword = '';
      return;
    }
    submit.disabled = true;
    try {
      const session = await api('/api/v1/password', {
        method: 'PUT',
        body: { currentPassword, newPassword },
      });
      state.csrfToken = session.csrfToken;
      setFormMessage('#password-message', '密码已更新。', true);
      toast('登录密码已更新');
    } catch (error) {
      setFormMessage('#password-message', error.message);
    } finally {
      currentPassword = '';
      newPassword = '';
      confirmPassword = '';
      submit.disabled = false;
    }
  });
  $('#copy-diagnostics').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(diagnostics()); toast('诊断摘要已复制'); }
    catch { toast('当前 WebView 不允许写入剪贴板'); }
  });
}

function updateClock() {
  $('#clock').textContent = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

async function loadAuthenticatedUi() {
  state.preferences = await api('/api/v1/preferences');
  renderPreferences();
  await refreshDashboard({ quiet: true });
  clearInterval(dashboardRefreshTimer);
  dashboardRefreshTimer = setInterval(() => refreshDashboard({ quiet: true }), 15_000);
}

async function main() {
  bindEvents();
  updateClock();
  setInterval(updateClock, 30_000);
  try {
    if (await initializeSession()) await loadAuthenticatedUi();
  } catch (error) {
    setConnected(false, error.message);
    renderMaintenance();
    toast(error.message);
  }
}

main();
