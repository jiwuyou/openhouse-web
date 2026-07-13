import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeResidencyPolicy, residencyPresentation } from '../public/state-core.js';

test('residency contract preserves the fixed suspendedByUser and lastError shape', () => {
  assert.deepEqual(normalizeResidencyPolicy({
    serviceId: 'pi-web', resident: true, suspendedByUser: true,
    registered: false, updatedAt: '2026-07-13T00:00:00Z', lastError: 'start failed',
  }), {
    serviceId: 'pi-web', resident: true, suspendedByUser: true,
    registered: false, updatedAt: '2026-07-13T00:00:00Z', lastError: 'start failed',
  });
});

test('list entry and detail entry derive identical residency and suspension state', () => {
  const policy = { serviceId: 'pi-web', resident: true, suspendedByUser: true, registered: true, updatedAt: null, lastError: null };
  const listEntry = residencyPresentation(policy, 'pi-web');
  const detailEntry = residencyPresentation(normalizeResidencyPolicy(policy, 'pi-web'), 'pi-web');
  assert.deepEqual(listEntry, detailEntry);
  assert.equal(listEntry.label, '常驻已暂停');
  assert.equal(listEntry.tone, 'suspended');
});

test('lastError is represented consistently when a resident service is not suspended', () => {
  const policy = { serviceId: 'broken', resident: true, suspendedByUser: false, registered: true, updatedAt: null, lastError: 'backoff' };
  assert.deepEqual(residencyPresentation(policy), {
    ...policy,
    label: '常驻异常',
    tone: 'failed',
  });
});
