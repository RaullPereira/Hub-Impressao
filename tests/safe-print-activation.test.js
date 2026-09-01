const assert = require('node:assert/strict');

const SafePrintActivation = require('../src/main/supabase/safe-print-activation');

function createMemoryStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    set: (key, value) => values.set(key, value),
    snapshot: () => Object.fromEntries(values)
  };
}

const activationIso = '2026-09-01T12:00:00.000Z';
const store = createMemoryStore();
const activation = new SafePrintActivation({
  store,
  version: '1.9.5',
  now: () => activationIso
});

const first = activation.getOrCreate('store-1');
assert.deepEqual(first, {
  safeActivationAt: activationIso,
  safeActivationVersion: '1.9.5'
});

assert.equal(
  activation.getOrCreate('store-1', '2.0.0', '2026-09-02T00:00:00.000Z').safeActivationAt,
  activationIso,
  'restart/update must preserve the original cutoff'
);

assert.equal(activation.allows('store-1', '2026-09-01T11:59:59.999Z'), false);
assert.equal(activation.allows('store-1', activationIso), true);
assert.equal(activation.allows('store-1', '2026-09-01T12:00:00.001Z'), true);
assert.equal(activation.allows('store-1', null), false, 'unknown timestamps fail closed');

const second = activation.getOrCreate('store-2', '1.9.5', '2026-09-01T13:00:00.000Z');
assert.equal(second.safeActivationAt, '2026-09-01T13:00:00.000Z');
assert.notEqual(second.safeActivationAt, first.safeActivationAt, 'cutoffs are scoped per store');

const restarted = new SafePrintActivation({
  store,
  version: '1.9.6',
  now: () => '2026-09-03T00:00:00.000Z'
});
assert.deepEqual(restarted.get('store-1'), first, 'cutoff survives a new manager instance');

console.log('safe print activation: ok');
