const SERVICE_ID = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';

const ROUTES = [
  { method: 'GET', pattern: /^\/api\/v1\/health$/ },
  { method: 'GET', pattern: /^\/api\/v1\/services$/ },
  { method: 'GET', pattern: /^\/api\/v1\/services\/statuses$/ },
  { method: 'GET', pattern: new RegExp(`^/api/v1/services/${SERVICE_ID}$`) },
  { method: 'GET', pattern: new RegExp(`^/api/v1/services/${SERVICE_ID}/status$`) },
  { method: 'GET', pattern: new RegExp(`^/api/v1/services/${SERVICE_ID}/endpoints$`) },
  { method: 'GET', pattern: new RegExp(`^/api/v1/services/${SERVICE_ID}/logs(?:\\?limit=[0-9]{1,4})?$`) },
  { method: 'POST', pattern: new RegExp(`^/api/v1/services/${SERVICE_ID}/(?:start|stop|restart|repair)$`) },
  { method: 'GET', pattern: /^\/api\/v1\/registry\/components$/ },
  { method: 'GET', pattern: /^\/api\/v1\/residency$/ },
  { method: 'GET', pattern: new RegExp(`^/api/v1/services/${SERVICE_ID}/residency$`) },
  { method: 'PUT', pattern: new RegExp(`^/api/v1/services/${SERVICE_ID}/residency$`) },
  { method: 'DELETE', pattern: new RegExp(`^/api/v1/residency/${SERVICE_ID}$`) },
];

export function validServiceId(value) {
  return new RegExp(`^${SERVICE_ID}$`).test(value);
}

export function assertAllowedUpstreamRequest(method, requestPath) {
  const upper = method.toUpperCase();
  if (!ROUTES.some((route) => route.method === upper && route.pattern.test(requestPath))) {
    throw Object.assign(new Error('upstream route is not allowed'), { statusCode: 404 });
  }
}

export class ServiceManagerClient {
  constructor({ origin, token, timeoutMs = 10_000, fetchImpl = fetch }) {
    this.origin = origin;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async request(method, requestPath, body) {
    assertAllowedUpstreamRequest(method, requestPath);
    if (!this.token) {
      throw Object.assign(new Error('service-manager token is not configured'), { statusCode: 503 });
    }
    const headers = { Accept: 'application/json', Authorization: `Bearer ${this.token}` };
    const options = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await this.fetchImpl(`${this.origin}${requestPath}`, options);
    } catch (error) {
      throw Object.assign(new Error(`service-manager unavailable: ${error.message}`), { statusCode: 502 });
    }
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { message: text }; }
    }
    if (!response.ok) {
      const message = data?.message || data?.error || `service-manager returned ${response.status}`;
      throw Object.assign(new Error(message), { statusCode: response.status, upstream: data });
    }
    return { status: response.status, data };
  }
}
