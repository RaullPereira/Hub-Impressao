const Settings = require('../config/settings');
const logger = require('../utils/logger');
const PairedPrintListener = require('./paired-print-listener');
const SafePrintActivation = require('./safe-print-activation');

function normalizeAdminClientId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

class MultiPairedPrintListener {
  constructor(printerManager, options = {}) {
    this.printerManager = printerManager;
    this.listeners = new Map();
    this.safePrintActivation = options.safePrintActivation || new SafePrintActivation();
  }

  setPrinterManager(printerManager) {
    this.printerManager = printerManager;
    for (const listener of this.listeners.values()) {
      listener.setPrinterManager(printerManager);
    }
  }

  createPairingStore(adminClientId) {
    return {
      getPairing: () => Settings.getPairing(adminClientId),
      savePairing: (pairing) => Settings.savePairing(pairing),
      updatePairing: (partialPairing) => Settings.updatePairing(adminClientId, partialPairing),
      clearPairing: () => Settings.clearPairing(adminClientId)
    };
  }

  ensureListener(adminClientId) {
    const normalizedAdminClientId = normalizeAdminClientId(adminClientId);
    if (!normalizedAdminClientId) {
      throw new Error('adminClientId é obrigatório para obter listener pareado');
    }

    if (!this.listeners.has(normalizedAdminClientId)) {
      const listener = new PairedPrintListener(this.printerManager, {
        adminClientId: normalizedAdminClientId,
        pairingStore: this.createPairingStore(normalizedAdminClientId),
        storageKey: `hub-impressao-supabase-session:${normalizedAdminClientId}`,
        safePrintActivation: this.safePrintActivation
      });
      this.listeners.set(normalizedAdminClientId, listener);
    }

    return this.listeners.get(normalizedAdminClientId);
  }

  buildStoreStatus(adminClientId) {
    const normalizedAdminClientId = normalizeAdminClientId(adminClientId);
    if (!normalizedAdminClientId) {
      return {
        paired: false,
        active: false,
        controlsAutoPrint: false,
        status: 'unpaired',
        adminClientId: null,
        appBaseUrl: null,
        storeName: null,
        userEmail: null,
        pairedAt: null,
        lastSeenAt: null,
        autoPrintEnabled: false,
        autoPrintType: 'counter',
        autoPrintOnAcceptEnabled: false,
        kdsReadyPrintEnabled: false,
        kdsReadyPrintRoutes: [],
        lastError: null
      };
    }

    const listener = this.listeners.get(normalizedAdminClientId);
    if (listener) {
      return listener.getStatus();
    }

    const pairing = Settings.getPairing(normalizedAdminClientId);
    const paired = Boolean(pairing?.adminClientId && pairing.enabled !== false);

    return {
      paired,
      active: false,
      controlsAutoPrint: false,
      status: paired ? 'idle' : 'unpaired',
      adminClientId: pairing?.adminClientId || normalizedAdminClientId,
      appBaseUrl: pairing?.appBaseUrl || null,
      storeName: pairing?.storeName || null,
      userEmail: pairing?.userEmail || null,
      pairedAt: pairing?.pairedAt || null,
      lastSeenAt: pairing?.lastSeenAt || null,
      autoPrintEnabled: false,
      autoPrintType: 'counter',
      autoPrintOnAcceptEnabled: false,
      kdsReadyPrintEnabled: false,
      kdsReadyPrintRoutes: [],
      lastError: null
    };
  }

  notifyOrderPrintedViaWebSocket(adminClientId, orderId) {
    const normalizedAdminClientId = normalizeAdminClientId(adminClientId);
    if (!normalizedAdminClientId || !orderId) return;
    const listener = this.listeners.get(normalizedAdminClientId);
    if (listener) {
      listener.notifyOrderPrintedViaWebSocket(orderId);
    }
  }

  notifyOrderPrintingViaWebSocket(adminClientId, orderId) {
    const normalizedAdminClientId = normalizeAdminClientId(adminClientId);
    if (!normalizedAdminClientId || !orderId) return;
    const listener = this.listeners.get(normalizedAdminClientId);
    if (listener) {
      listener.notifyOrderPrintingViaWebSocket(orderId);
    }
  }

  notifyOrderPrintFailedViaWebSocket(adminClientId, orderId) {
    const normalizedAdminClientId = normalizeAdminClientId(adminClientId);
    if (!normalizedAdminClientId || !orderId) return;
    const listener = this.listeners.get(normalizedAdminClientId);
    if (listener) {
      listener.notifyOrderPrintFailedViaWebSocket(orderId);
    }
  }

  isStoreAutoPrintEnabled(adminClientId) {
    const normalizedAdminClientId = normalizeAdminClientId(adminClientId);
    if (!normalizedAdminClientId) return true;

    const listener = this.listeners.get(normalizedAdminClientId);
    if (!listener) return false;

    return listener.getStatus().autoPrintEnabled === true;
  }

  shouldDeferOrderUntilAccept(adminClientId, orderData) {
    const normalizedAdminClientId = normalizeAdminClientId(adminClientId);
    if (!normalizedAdminClientId || !orderData) return false;

    const listener = this.listeners.get(normalizedAdminClientId);
    if (!listener || typeof listener.shouldDeferOrderUntilAccept !== 'function') return false;

    return listener.shouldDeferOrderUntilAccept(orderData);
  }

  getAllStatuses() {
    const ids = new Set([
      ...Settings.getAllPairings().map((pairing) => pairing.adminClientId).filter(Boolean),
      ...this.listeners.keys()
    ]);

    return Array.from(ids).map((adminClientId) => this.buildStoreStatus(adminClientId));
  }

  getStatus(adminClientId = null) {
    const normalizedAdminClientId = normalizeAdminClientId(adminClientId);
    if (normalizedAdminClientId) {
      return this.buildStoreStatus(normalizedAdminClientId);
    }

    const pairings = this.getAllStatuses();
    const activeCount = pairings.filter((entry) => entry.active).length;
    const pairedCount = pairings.filter((entry) => entry.paired).length;
    const firstPairing = pairings[0] || this.buildStoreStatus(null);

    if (pairings.length === 1) {
      return Object.assign({}, firstPairing, { pairings });
    }

    return {
      paired: pairedCount > 0,
      active: activeCount > 0,
      controlsAutoPrint: activeCount > 0,
      status: activeCount > 0 ? 'active' : pairedCount > 0 ? 'idle' : 'unpaired',
      adminClientId: pairings.length === 1 ? firstPairing.adminClientId : null,
      appBaseUrl: pairings.length === 1 ? firstPairing.appBaseUrl : null,
      storeName: pairings.length === 1 ? firstPairing.storeName : null,
      userEmail: pairings.length === 1 ? firstPairing.userEmail : null,
      pairedAt: pairings.length === 1 ? firstPairing.pairedAt : null,
      lastSeenAt: pairings.length === 1 ? firstPairing.lastSeenAt : null,
      autoPrintEnabled: pairings.length === 1 ? firstPairing.autoPrintEnabled : false,
      autoPrintType: pairings.length === 1 ? firstPairing.autoPrintType : 'counter',
      autoPrintOnAcceptEnabled: pairings.length === 1 ? firstPairing.autoPrintOnAcceptEnabled : false,
      kdsReadyPrintEnabled: pairings.length === 1 ? firstPairing.kdsReadyPrintEnabled : false,
      kdsReadyPrintRoutes: pairings.length === 1 && Array.isArray(firstPairing.kdsReadyPrintRoutes) ? firstPairing.kdsReadyPrintRoutes : [],
      lastError: null,
      pairedCount,
      activeCount,
      pairings
    };
  }

  async startFromSettings() {
    const pairings = Settings.getAllPairings().filter((pairing) => pairing?.adminClientId);
    for (const pairing of pairings) {
      const listener = this.ensureListener(pairing.adminClientId);
      try {
        await listener.startFromSettings();
      } catch (error) {
        logger.error(`[Pairing] Falha ao iniciar listener da loja ${pairing.adminClientId}:`, error);
      }
    }

    return this.getStatus();
  }

  async recoverAllNow(source = 'manual') {
    const pairings = Settings.getAllPairings().filter((pairing) => pairing?.adminClientId);

    for (const pairing of pairings) {
      const listener = this.ensureListener(pairing.adminClientId);
      try {
        await listener.recoverNow(source);
      } catch (error) {
        logger.error(`[Pairing] Falha ao recuperar listener da loja ${pairing.adminClientId}:`, error);
      }
    }

    return this.getStatus();
  }

  async recover(adminClientId = null, source = 'manual') {
    const normalizedAdminClientId = normalizeAdminClientId(adminClientId);

    if (normalizedAdminClientId) {
      const listener = this.ensureListener(normalizedAdminClientId);
      await listener.recoverNow(source);
      return this.buildStoreStatus(normalizedAdminClientId);
    }

    return this.recoverAllNow(source);
  }

  async pair(payload) {
    const adminClientId = normalizeAdminClientId(payload?.adminClientId);
    if (!adminClientId) {
      throw new Error('adminClientId é obrigatório');
    }

    const listener = this.ensureListener(adminClientId);
    return listener.pair(payload);
  }

  async unpair(adminClientId = null) {
    const normalizedAdminClientId = normalizeAdminClientId(adminClientId);

    if (normalizedAdminClientId) {
      const listener = this.listeners.get(normalizedAdminClientId);
      if (listener) {
        await listener.unpair();
        this.listeners.delete(normalizedAdminClientId);
      } else {
        Settings.clearPairing(normalizedAdminClientId);
      }

      return this.buildStoreStatus(normalizedAdminClientId);
    }

    const activeListeners = Array.from(this.listeners.values());
    this.listeners.clear();

    await Promise.allSettled(activeListeners.map((listener) => listener.stop()));
    Settings.clearPairing();
    return this.getStatus();
  }

  async stop() {
    const activeListeners = Array.from(this.listeners.values());
    this.listeners.clear();
    await Promise.allSettled(activeListeners.map((listener) => listener.stop()));
  }
}

module.exports = MultiPairedPrintListener;
