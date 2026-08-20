'use strict';

function parseTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function calculateRecoveryWindow({
  nowMs = Date.now(),
  lastSeenAt = null,
  forceLookbackMs = null,
  recoverySkewMs,
  defaultLookbackMs,
  maxAutomaticAgeMs
}) {
  const lastSeenMs = parseTimestamp(lastSeenAt);
  const candidates = [
    lastSeenMs === null ? null : lastSeenMs - recoverySkewMs,
    nowMs - (forceLookbackMs || defaultLookbackMs)
  ].filter(Number.isFinite);
  const requestedSinceMs = Math.min(...candidates);
  const sinceMs = Math.max(nowMs - maxAutomaticAgeMs, requestedSinceMs);

  return {
    sinceIso: new Date(sinceMs).toISOString(),
    untilIso: new Date(nowMs).toISOString()
  };
}

module.exports = { calculateRecoveryWindow };
