'use strict';

const assert = require('node:assert/strict');
const { calculateRecoveryWindow } = require('../src/main/supabase/recovery-window');

const nowMs = Date.parse('2026-08-20T12:00:00.000Z');
const result = calculateRecoveryWindow({
  nowMs,
  lastSeenAt: '2026-08-20T11:59:55.000Z',
  forceLookbackMs: 30 * 60 * 1000,
  recoverySkewMs: 10 * 1000,
  defaultLookbackMs: 30 * 60 * 1000,
  maxAutomaticAgeMs: 5 * 60 * 1000
});

assert.deepEqual(result, {
  sinceIso: '2026-08-20T11:55:00.000Z',
  untilIso: '2026-08-20T12:00:00.000Z'
});

assert.equal(calculateRecoveryWindow({
  nowMs,
  lastSeenAt: null,
  forceLookbackMs: null,
  recoverySkewMs: 10_000,
  defaultLookbackMs: 30 * 60_000,
  maxAutomaticAgeMs: 5 * 60_000
}).sinceIso, '2026-08-20T11:55:00.000Z');

assert.equal(calculateRecoveryWindow({
  nowMs,
  lastSeenAt: '2026-08-20T11:59:58.000Z',
  forceLookbackMs: 60_000,
  recoverySkewMs: 10_000,
  defaultLookbackMs: 30 * 60_000,
  maxAutomaticAgeMs: 5 * 60_000
}).sinceIso, '2026-08-20T11:59:00.000Z');

console.log('auto-print recovery window: ok');
