'use strict';

const packageJson = require('../../../package.json');

const STORE_KEY = 'safePrintActivations';

function normalizeAdminClientId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeIso(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const safeActivationAt = normalizeIso(value.safeActivationAt);
  if (!safeActivationAt) return null;

  return {
    safeActivationAt,
    safeActivationVersion: typeof value.safeActivationVersion === 'string' && value.safeActivationVersion.trim()
      ? value.safeActivationVersion.trim()
      : 'unknown'
  };
}

function createElectronStore() {
  const ElectronStore = require('electron-store');
  return new ElectronStore({ name: 'safe-print-activation' });
}

class SafePrintActivation {
  constructor(options = {}) {
    this.store = options.store || createElectronStore();
    this.version = typeof options.version === 'string' && options.version.trim()
      ? options.version.trim()
      : packageJson.version;
    this.now = typeof options.now === 'function'
      ? options.now
      : () => new Date().toISOString();
  }

  getAll() {
    const raw = this.store.get(STORE_KEY, {});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

    const result = {};
    for (const [adminClientId, value] of Object.entries(raw)) {
      const normalizedId = normalizeAdminClientId(adminClientId);
      const record = normalizeRecord(value);
      if (normalizedId && record) result[normalizedId] = record;
    }
    return result;
  }

  get(adminClientId) {
    const normalizedId = normalizeAdminClientId(adminClientId);
    if (!normalizedId) return null;
    return this.getAll()[normalizedId] || null;
  }

  getOrCreate(adminClientId, version = this.version, nowIso = this.now()) {
    const normalizedId = normalizeAdminClientId(adminClientId);
    if (!normalizedId) throw new Error('adminClientId is required for safe print activation');

    const existing = this.get(normalizedId);
    if (existing) return existing;

    const safeActivationAt = normalizeIso(nowIso);
    if (!safeActivationAt) throw new Error('A valid activation timestamp is required');

    const record = {
      safeActivationAt,
      safeActivationVersion: typeof version === 'string' && version.trim() ? version.trim() : 'unknown'
    };
    const all = this.getAll();
    all[normalizedId] = record;
    this.store.set(STORE_KEY, all);
    return record;
  }

  allows(adminClientId, candidateIso) {
    const record = this.get(adminClientId);
    const candidate = normalizeIso(candidateIso);
    if (!record || !candidate) return false;
    return Date.parse(candidate) >= Date.parse(record.safeActivationAt);
  }
}

module.exports = SafePrintActivation;
module.exports.normalizeIso = normalizeIso;
