const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const logger = require('../utils/logger');
const { normalizeAutoPrintMap } = require('../print-routes');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_PRINTERS = Object.freeze({
  default: null,
  kitchen: null,
  attendance: null,
  counter: null,
  delivery: null,
  bar: null
});

function createDefaultPrinters() {
  return {
    default: null,
    kitchen: null,
    counter: null,
    delivery: null,
    bar: null,
    autoPrint: null
  };
}

function normalizePrinterValue(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}

function normalizePrinters(rawPrinters = {}) {
  const normalized = createDefaultPrinters();

  for (const type of Object.keys(DEFAULT_PRINTERS)) {
    normalized[type] = normalizePrinterValue(rawPrinters?.[type]);
  }

  if (!normalized.attendance) {
    normalized.attendance = normalized.counter || normalized.delivery || null;
  }

  // Preserve and normalize the auto-print sub-map alongside the manual targets.
  normalized.autoPrint = normalizeAutoPrintMap(rawPrinters?.autoPrint);

  return normalized;
}

function normalizeStorePrinters(rawStorePrinters = null) {
  const storePrinters = {};

  if (!rawStorePrinters || typeof rawStorePrinters !== 'object') {
    return storePrinters;
  }

  for (const [adminClientId, printers] of Object.entries(rawStorePrinters)) {
    const normalizedAdminClientId = typeof adminClientId === 'string' ? adminClientId.trim() : '';
    if (!normalizedAdminClientId) continue;
    storePrinters[normalizedAdminClientId] = normalizePrinters(printers);
  }

  return storePrinters;
}

function normalizePairing(rawPairing = {}) {
  const safePairing = rawPairing && typeof rawPairing === 'object'
    ? rawPairing
    : {};
  const rawSession = safePairing && typeof safePairing.session === 'object' ? safePairing.session : null;
  const session = rawSession && rawSession.access_token && rawSession.refresh_token
    ? {
      access_token: String(rawSession.access_token),
      refresh_token: String(rawSession.refresh_token),
      token_type: typeof rawSession.token_type === 'string' && rawSession.token_type.trim()
        ? rawSession.token_type.trim()
        : 'bearer',
      expires_at: Number.isFinite(Number(rawSession.expires_at))
        ? Number(rawSession.expires_at)
        : null,
      expires_in: Number.isFinite(Number(rawSession.expires_in))
        ? Number(rawSession.expires_in)
        : null
    }
    : null;

  return {
    enabled: safePairing.enabled !== false,
    adminClientId: typeof safePairing.adminClientId === 'string' && safePairing.adminClientId.trim()
      ? safePairing.adminClientId.trim()
      : null,
    appBaseUrl: typeof safePairing.appBaseUrl === 'string' && safePairing.appBaseUrl.trim()
      ? safePairing.appBaseUrl.trim().replace(/\/+$/, '')
      : null,
    storeName: typeof safePairing.storeName === 'string' && safePairing.storeName.trim()
      ? safePairing.storeName.trim()
      : null,
    supabaseUrl: typeof safePairing.supabaseUrl === 'string' && safePairing.supabaseUrl.trim()
      ? safePairing.supabaseUrl.trim()
      : null,
    anonKey: typeof safePairing.anonKey === 'string' && safePairing.anonKey.trim()
      ? safePairing.anonKey.trim()
      : null,
    userId: typeof safePairing.userId === 'string' && safePairing.userId.trim()
      ? safePairing.userId.trim()
      : null,
    userEmail: typeof safePairing.userEmail === 'string' && safePairing.userEmail.trim()
      ? safePairing.userEmail.trim()
      : null,
    pairedAt: typeof safePairing.pairedAt === 'string' && safePairing.pairedAt.trim()
      ? safePairing.pairedAt.trim()
      : null,
    lastSeenAt: typeof safePairing.lastSeenAt === 'string' && safePairing.lastSeenAt.trim()
      ? safePairing.lastSeenAt.trim()
      : null,
    session
  };
}

function normalizePairings(rawPairings = null, legacyPairing = null) {
  const pairings = {};

  const addPairing = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return;
    const normalized = normalizePairing(candidate);
    if (!normalized.adminClientId) return;
    pairings[normalized.adminClientId] = normalized;
  };

  addPairing(legacyPairing);

  if (Array.isArray(rawPairings)) {
    rawPairings.forEach(addPairing);
  } else if (rawPairings && typeof rawPairings === 'object') {
    Object.values(rawPairings).forEach(addPairing);
  }

  return pairings;
}

function getLegacyPairingSnapshot(pairings) {
  const firstPairing = Object.values(pairings || {}).find((entry) => entry && entry.adminClientId);
  return firstPairing || normalizePairing({ enabled: false });
}

function createDefaultSettings() {
  return {
    printers: createDefaultPrinters(),
    storePrinters: {},
    cachedWindowsPrinters: [],
    usbMappings: {},
    manualPrinters: [],
    printChannel: 'local',
    qzEndpoint: null,
    pairings: {},
    pairing: normalizePairing({ enabled: false })
  };
}

function normalizeSettings(rawSettings = {}) {
  const defaultSettings = createDefaultSettings();
  const pairings = normalizePairings(rawSettings.pairings, rawSettings.pairing);
  const storePrinters = normalizeStorePrinters(rawSettings.storePrinters);
  const cachedWindowsPrinters = Array.isArray(rawSettings.cachedWindowsPrinters)
    ? rawSettings.cachedWindowsPrinters
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null,
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : null,
        type: typeof entry.type === 'string' && entry.type.trim() ? entry.type.trim() : 'WINDOWS_SPOOLER',
        isDefault: entry.isDefault === true,
        status: typeof entry.status === 'string' && entry.status.trim() ? entry.status.trim() : 'ready'
      }))
      .filter((entry) => entry.id && entry.name)
    : [];

  return {
    printers: normalizePrinters(rawSettings.printers),
    storePrinters,
    cachedWindowsPrinters,
    usbMappings: {
      ...defaultSettings.usbMappings,
      ...(rawSettings.usbMappings || {})
    },
    manualPrinters: Array.isArray(rawSettings.manualPrinters)
      ? rawSettings.manualPrinters.filter((entry) => typeof entry === 'string' && entry.trim())
      : [...defaultSettings.manualPrinters],
    printChannel: rawSettings.printChannel === 'qz' ? 'qz' : 'local',
    qzEndpoint: typeof rawSettings.qzEndpoint === 'string' && rawSettings.qzEndpoint.trim()
      ? rawSettings.qzEndpoint.trim()
      : null,
    pairings,
    pairing: getLegacyPairingSnapshot(pairings)
  };
}

class Settings {
  static getAll() {
    try {
      if (!fs.existsSync(SETTINGS_FILE)) {
        const defaults = normalizeSettings();
        this.save(defaults);
        return defaults;
      }

      const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      const normalized = normalizeSettings(parsed);

      if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
        this.save(normalized);
      }

      return normalized;
    } catch (e) {
      logger.error('Erro ao ler configurações:', e);
      return normalizeSettings();
    }
  }

  static save(newSettings) {
    try {
      const dir = path.dirname(SETTINGS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const normalized = normalizeSettings(newSettings);
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(normalized, null, 2));
      logger.info('Configurações salvas');
      return true;
    } catch (e) {
      logger.error('Erro ao salvar configurações:', e);
      return false;
    }
  }

  static getPrinterForType(type) {
    const settings = this.getAll();
    return settings.printers?.[type] || settings.printers?.default || null;
  }

  static setPrinterForType(type, printerId) {
    const settings = this.getAll();
    if (!settings.printers) settings.printers = {};
    settings.printers[type] = printerId;
    return this.save(settings);
  }

  static getStorePrinters(adminClientId) {
    const settings = this.getAll();
    const normalizedAdminClientId = typeof adminClientId === 'string'
      ? adminClientId.trim()
      : '';

    if (!normalizedAdminClientId) {
      return createDefaultPrinters();
    }

    return normalizePrinters(settings.storePrinters?.[normalizedAdminClientId] || {});
  }

  static setStorePrinters(adminClientId, printers, options = {}) {
    const normalizedAdminClientId = typeof adminClientId === 'string'
      ? adminClientId.trim()
      : '';

    if (!normalizedAdminClientId) {
      return false;
    }

    const settings = this.getAll();
    if (!settings.storePrinters || typeof settings.storePrinters !== 'object') {
      settings.storePrinters = {};
    }

    const nextPrinters = options.replace === true
      ? (printers || {})
      : {
        ...(settings.storePrinters[normalizedAdminClientId] || {}),
        ...(printers || {})
      };

    settings.storePrinters[normalizedAdminClientId] = normalizePrinters(nextPrinters);

    return this.save(settings);
  }

  static getUsbMapping(usbId) {
    const settings = this.getAll();
    return settings.usbMappings?.[usbId] || null;
  }

  static getCachedWindowsPrinters() {
    const settings = this.getAll();
    return Array.isArray(settings.cachedWindowsPrinters)
      ? settings.cachedWindowsPrinters
      : [];
  }

  static setCachedWindowsPrinters(printers) {
    const settings = this.getAll();
    settings.cachedWindowsPrinters = Array.isArray(printers)
      ? printers
      : [];
    return this.save(settings);
  }

  static setUsbMapping(usbId, windowsPrinterName) {
    const settings = this.getAll();
    if (!settings.usbMappings) settings.usbMappings = {};
    settings.usbMappings[usbId] = windowsPrinterName;
    return this.save(settings);
  }

  static getManualPrinters() {
    const settings = this.getAll();
    return settings.manualPrinters || [];
  }

  static addManualPrinter(name) {
    const settings = this.getAll();
    if (!settings.manualPrinters) settings.manualPrinters = [];
    if (!settings.manualPrinters.includes(name)) settings.manualPrinters.push(name);
    return this.save(settings);
  }

  static removeManualPrinter(name) {
    const settings = this.getAll();
    if (!settings.manualPrinters) return false;
    settings.manualPrinters = settings.manualPrinters.filter((entry) => entry !== name);
    return this.save(settings);
  }

  static getPairing(adminClientId = null) {
    const settings = this.getAll();
    const normalizedAdminClientId = typeof adminClientId === 'string'
      ? adminClientId.trim()
      : null;

    if (normalizedAdminClientId) {
      return settings.pairings?.[normalizedAdminClientId] || normalizePairing({ enabled: false, adminClientId: normalizedAdminClientId });
    }

    return settings.pairing || getLegacyPairingSnapshot(settings.pairings);
  }

  static getPairings() {
    const settings = this.getAll();
    return Object.assign({}, settings.pairings || {});
  }

  static getAllPairings() {
    return Object.values(this.getPairings());
  }

  static savePairing(pairing) {
    const settings = this.getAll();
    const normalized = normalizePairing(pairing);
    if (!normalized.adminClientId) {
      return false;
    }

    if (!settings.pairings || typeof settings.pairings !== 'object') {
      settings.pairings = {};
    }

    settings.pairings[normalized.adminClientId] = normalized;
    settings.pairing = getLegacyPairingSnapshot(settings.pairings);
    return this.save(settings);
  }

  static updatePairing(adminClientIdOrPartial, maybePartialPairing) {
    const adminClientId = typeof adminClientIdOrPartial === 'string'
      ? adminClientIdOrPartial.trim()
      : null;
    const partialPairing = adminClientId
      ? (maybePartialPairing || {})
      : (adminClientIdOrPartial || {});
    const current = adminClientId ? this.getPairing(adminClientId) : this.getPairing();
    const nextPairing = Object.assign({}, current, partialPairing);

    if (adminClientId) {
      nextPairing.adminClientId = adminClientId;
    }

    return this.savePairing(nextPairing);
  }

  static clearPairing(adminClientId = null) {
    const settings = this.getAll();

    if (typeof adminClientId === 'string' && adminClientId.trim()) {
      if (settings.pairings && typeof settings.pairings === 'object') {
        delete settings.pairings[adminClientId.trim()];
      }
      settings.pairing = getLegacyPairingSnapshot(settings.pairings);
      return this.save(settings);
    }

    settings.pairings = {};
    settings.pairing = normalizePairing({ enabled: false });
    return this.save(settings);
  }
}

module.exports = Settings;
