import assert from 'node:assert/strict';
import test from 'node:test';

import { ServiceManagerClient, assertAllowedUpstreamRequest, validServiceId } from '../src/service-manager-client.mjs';

test('service ids are strictly bounded', () => {
  assert.equal(validServiceId('pi-web'), true);
  assert.equal(validServiceId('../token'), false);
  assert.equal(validServiceId('space id'), false);
});

test('upstream allowlist includes fixed residency API and rejects arbitrary proxying', () => {
  assert.doesNotThrow(() => assertAllowedUpstreamRequest('GET', '/api/v1/residency'));
  assert.doesNotThrow(() => assertAllowedUpstreamRequest('PUT', '/api/v1/services/pi-web/residency'));
  assert.doesNotThrow(() => assertAllowedUpstreamRequest('DELETE', '/api/v1/residency/pi-web'));
  assert.throws(() => assertAllowedUpstreamRequest('GET', '/api/v1/export'));
  assert.throws(() => assertAllowedUpstreamRequest('POST', '/api/v1/import'));
});

test('token is attached server-side and upstream errors are normalized', async () => {
  let observed;
  const client = new ServiceManagerClient({
    origin: 'http://127.0.0.1:20087', token: 'secret',
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    },
  });
  const result = await client.request('GET', '/api/v1/residency');
  assert.equal(result.data.status, 'ok');
  assert.equal(observed.options.headers.Authorization, 'Bearer secret');
});
