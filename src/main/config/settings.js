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
    pairing: normalizePairing({ enabled: false }),
    stationId: null
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
    pairing: getLegacyPairingSnapshot(pairings),
    // Id fixo deste Hub, usado pelo "computador da impressao automatica".
    stationId: typeof rawSettings.stationId === 'string' && /^hub:[A-Za-z0-9-]{8,}$/.test(rawSettings.stationId.trim())
      ? rawSettings.stationId.trim()
      : null
  };
}

// So este processo grava o settings.json. Antes, cada consulta (heartbeat de
// 15s, resolucao de impressora, sessao do Supabase) lia e parseava o arquivo do
// disco, e cada heartbeat regravava o arquivo inteiro. O cache guarda a ultima
// versao gravada; quem chama recebe uma copia e pode altera-la livremente.
let settingsCache = null;
let settingsCacheJson = null;

function cloneSettings(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

class Settings {
  static getAll() {
    if (settingsCache) {
      return cloneSettings(settingsCache);
    }

    try {
      if (!fs.existsSync(SETTINGS_FILE)) {
        const defaults = normalizeSettings();
        this.save(defaults);
        return cloneSettings(defaults);
      }

      const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      const normalized = normalizeSettings(parsed);

      if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
        this.save(normalized);
      } else {
        settingsCache = normalized;
        settingsCacheJson = JSON.stringify(normalized, null, 2);
      }

      return cloneSettings(normalized);
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
      const json = JSON.stringify(normalized, null, 2);
      if (settingsCache && json === settingsCacheJson) {
        return true;
      }
      fs.writeFileSync(SETTINGS_FILE, json);
      settingsCache = normalized;
      settingsCacheJson = json;
      return true;
    } catch (e) {
      logger.error('Erro ao salvar configurações:', e);
      return false;
    }
  }

  // Id fixo deste Hub (gerado uma vez e salvo no settings.json).
  static getStationId() {
    const settings = this.getAll();
    if (settings.stationId) return settings.stationId;
    const crypto = require('crypto');
    settings.stationId = `hub:${crypto.randomUUID()}`;
    this.save(settings);
    return settings.stationId;
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

// Testes: descarta o cache para reler o arquivo.
Settings.resetCacheForTests = () => {
  settingsCache = null;
  settingsCacheJson = null;
};

module.exports = Settings;
