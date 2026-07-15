const Settings = require('../config/settings');
const logger = require('../utils/logger');
const { performance } = require('node:perf_hooks');
const BaseWebSocketTransport = require('ws');
const { DEFAULT_PRINT_SETTINGS } = require('../printer/pedidoshub-formatter');
const PrinterDispatchQueue = require('../printer/printer-dispatch-queue');
const fetchCompat = require('../utils/fetch');
const {
  calculatePickupMs,
  createPrintTraceId,
  emitPrintPerformance
} = require('../utils/print-telemetry');
const {
  buildLegacyAutoPrintRoutes,
  buildAutoPrintRoutesForOrder,
  getAutoPrintPrinterForRoute,
  normalizeAutoPrintMap,
  normalizeAutoPrintRoute
} = require('../print-routes');

const HEARTBEAT_INTERVAL_MS = 15000;
const WATCHDOG_INTERVAL_MS = 20000;
const RECOVERY_SKEW_MS = 10000;
const RECOVERY_LOOKBACK_MS = 30 * 60 * 1000;
const AUTO_PRINT_RECOVERY_MAX_AGE_MS = 5 * 60 * 1000;
const PENDING_PRINT_JOB_RECOVERY_MAX_AGE_MS = AUTO_PRINT_RECOVERY_MAX_AGE_MS;
const PENDING_PRINT_JOB_RECOVERY_LIMIT = 50;
const CHANNEL_SUBSCRIBE_TIMEOUT_MS = 15000;
const REALTIME_CLIENT_TIMEOUT_MS = 30000;
const MAX_RUNTIME_CACHE = 500;
const SUPABASE_STORAGE_KEY = 'hub-impressao-supabase-session';
const PAYMENT_METHODS_CACHE_TTL_MS = 60000;
const SESSION_REFRESH_THRESHOLD_MS = 3 * 60 * 1000;
const PRINT_RETRY_ATTEMPTS = 3;
const PRINTER_REFRESH_TTL_MS = 30000;

let createClientLoader = null;

class SafeWebSocketTransport extends BaseWebSocketTransport {
  constructor(...args) {
    super(...args);

    // Prevent handshake failures like HTTP 502 from crashing the Electron main
    // process before Realtime hooks its own handlers.
    this.on('error', () => {});
  }
}

async function getCreateClient() {
  if (!createClientLoader) {
    createClientLoader = Promise.resolve().then(() => {
      const supabase = require('@supabase/supabase-js');
      if (typeof supabase?.createClient === 'function') {
        return supabase.createClient;
      }

      throw new Error('Pacote @supabase/supabase-js carregado sem createClient');
    });
  }
  return createClientLoader;
}

function normalizeSession(session) {
  if (!session || !session.access_token || !session.refresh_token) {
    return null;
  }

  return {
    access_token: String(session.access_token),
    refresh_token: String(session.refresh_token),
    token_type: typeof session.token_type === 'string' && session.token_type.trim()
      ? session.token_type.trim()
      : 'bearer',
    expires_at: Number.isFinite(Number(session.expires_at))
      ? Number(session.expires_at)
      : null,
    expires_in: Number.isFinite(Number(session.expires_in))
      ? Number(session.expires_in)
      : null
  };
}

function isPixOnlineOrder(order) {
  const paymentMethod = String(order?.payment_method || '').toLowerCase();
  return paymentMethod === 'pix_online' || (paymentMethod.includes('pix') && paymentMethod.includes('online'));
}

function isOrderCancelled(order) {
  const status = String(order?.status || '').toLowerCase();
  return ['cancelled', 'canceled', 'rejected'].includes(status);
}

function getOrderCustomData(order) {
  const customData = order?.custom_data || order?.customData;
  return customData && typeof customData === 'object' && !Array.isArray(customData)
    ? customData
    : {};
}

function wasAutoPrintedOffline(order) {
  const customData = getOrderCustomData(order);
  return Boolean(customData.offlineAutoPrintedAt || customData.offlineAutoPrinted === true);
}

function isManualPrintOnlyOrder(order) {
  const customData = getOrderCustomData(order);
  return Boolean(
    customData.manual_print_only === true ||
    customData.manualPrintOnly === true ||
    (customData.workshop_vehicle && typeof customData.workshop_vehicle === 'object') ||
    (customData.workshopVehicle && typeof customData.workshopVehicle === 'object')
  );
}

// Detecta se o pedido e do tipo delivery. Espelha o isDeliveryOrder do frontend
// (order_type / delivery_type === 'delivery'); o formatter ja usa order_type/orderType.
function isDeliveryOrder(order) {
  const type = String(
    order?.order_type ?? order?.orderType ?? order?.delivery_type ?? order?.deliveryType ?? ''
  ).trim().toLowerCase();
  return type === 'delivery';
}

// Origens consideradas "pedido do cardapio digital / online" para a regra
// "imprimir somente ao aceitar".
const DIGITAL_MENU_SOURCES = new Set(['digital_menu', 'online', 'ifood']);

function isDigitalMenuOrder(order) {
  const customData = getOrderCustomData(order);
  return [
    order?.source,
    order?.origin,
    order?.order_origin,
    customData?.source,
    customData?.origin,
    customData?.order_origin
  ].some((value) => DIGITAL_MENU_SOURCES.has(String(value ?? '').trim().toLowerCase()));
}

// Status em que um pedido online ainda nao foi aceito pelo lojista.
const AWAITING_ACCEPTANCE_STATUSES = new Set(['awaiting', 'confirmed', 'pending_payment']);

function isAwaitingAcceptance(order) {
  return AWAITING_ACCEPTANCE_STATUSES.has(String(order?.status || '').trim().toLowerCase());
}

// Quando "imprimir somente ao aceitar" esta ligado, pedidos do cardapio digital
// que ainda estao aguardando aceite NAO devem ser impressos na chegada.
function shouldDeferUntilAccept(order, settings) {
  return Boolean(
    settings &&
    settings.autoPrintOnAcceptEnabled &&
    isDigitalMenuOrder(order) &&
    isAwaitingAcceptance(order)
  );
}

function parseIsoDate(value) {
  if (!value || typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isOlderThan(value, maxAgeMs, options = {}) {
  const { staleWhenMissing = false } = options;
  const parsed = parseIsoDate(value);
  if (!parsed) return staleWhenMissing;
  return (Date.now() - parsed.getTime()) > maxAgeMs;
}

function isRecoveredOrderTooOld(order) {
  return isOlderThan(order?.created_at || order?.createdAt, AUTO_PRINT_RECOVERY_MAX_AGE_MS);
}

function isRecoveredPrintJobTooOld(job) {
  return isOlderThan(job?.created_at || job?.createdAt, PENDING_PRINT_JOB_RECOVERY_MAX_AGE_MS, {
    staleWhenMissing: true
  });
}

function normalizeAppBaseUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

function getBearerAuthorization(session) {
  const accessToken = typeof session?.access_token === 'string' ? session.access_token.trim() : '';
  if (!accessToken) return null;
  return `Bearer ${accessToken}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArrayLike(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function patchRealtimeConnect(realtime) {
  if (!realtime || realtime.__hubConnectPatched) return;

  const originalConnect = typeof realtime.connect === 'function'
    ? realtime.connect.bind(realtime)
    : null;

  if (!originalConnect) return;

  realtime.connect = (...args) => {
    const result = originalConnect(...args);

    if (realtime.conn && typeof realtime.setupConnection === 'function') {
      realtime.setupConnection();
    }

    return result;
  };

  realtime.__hubConnectPatched = true;
}

function safeDisposeRealtimeClient(realtime) {
  if (!realtime) return null;

  const conn = realtime.conn || null;
  let closeError = null;

  if (conn) {
    try {
      conn.onclose = () => {};
      conn.onerror = () => {};
      conn.onopen = () => {};
      conn.onmessage = () => {};

      if (conn.readyState === BaseWebSocketTransport.CONNECTING) {
        if (typeof conn.terminate === 'function') {
          conn.terminate();
        } else if (typeof conn.destroy === 'function') {
          conn.destroy();
        }
      } else if (
        conn.readyState !== BaseWebSocketTransport.CLOSED &&
        conn.readyState !== BaseWebSocketTransport.CLOSING &&
        typeof conn.close === 'function'
      ) {
        conn.close();
      }
    } catch (error) {
      closeError = error;
    }
  }

  realtime.conn = null;
  realtime.pendingHeartbeatRef = null;

  if (realtime.heartbeatTimer) {
    clearInterval(realtime.heartbeatTimer);
    realtime.heartbeatTimer = null;
  }

  if (realtime.reconnectTimer && typeof realtime.reconnectTimer.reset === 'function') {
    realtime.reconnectTimer.reset();
  }

  if (Array.isArray(realtime.channels)) {
    realtime.channels.length = 0;
  }

  if (Array.isArray(realtime.sendBuffer)) {
    realtime.sendBuffer.length = 0;
  }

  return closeError;
}

function mapPrintSettingsFromDB(data) {
  return {
    paperWidth: data?.paper_width || DEFAULT_PRINT_SETTINGS.paperWidth,
    marginLeft: data?.margin_left || 0,
    marginRight: data?.margin_right || 0,
    lineSpacing: data?.line_spacing || DEFAULT_PRINT_SETTINGS.lineSpacing,
    fontSize: data?.font_size || DEFAULT_PRINT_SETTINGS.fontSize,
    mediumTitle: data?.medium_title ?? DEFAULT_PRINT_SETTINGS.mediumTitle,
    mediumItems: data?.medium_items ?? DEFAULT_PRINT_SETTINGS.mediumItems,
    showStoreName: data?.show_store_name ?? DEFAULT_PRINT_SETTINGS.showStoreName,
    storeName: data?.store_name || DEFAULT_PRINT_SETTINGS.storeName,
    showStorePhone: data?.store_phone || DEFAULT_PRINT_SETTINGS.showStorePhone,
    showDateTime: data?.show_date_time ?? DEFAULT_PRINT_SETTINGS.showDateTime,
    showItemPrice: data?.show_item_price ?? DEFAULT_PRINT_SETTINGS.showItemPrice,
    showItemQuantity: data?.show_item_quantity ?? DEFAULT_PRINT_SETTINGS.showItemQuantity,
    showItemNotes: data?.show_item_notes ?? DEFAULT_PRINT_SETTINGS.showItemNotes,
    groupByCategory: data?.group_by_category ?? DEFAULT_PRINT_SETTINGS.groupByCategory,
    showTotal: data?.show_total ?? DEFAULT_PRINT_SETTINGS.showTotal,
    showPaymentMethod: data?.show_payment_method ?? DEFAULT_PRINT_SETTINGS.showPaymentMethod,
    showDeliveryInfo: data?.show_delivery_info ?? DEFAULT_PRINT_SETTINGS.showDeliveryInfo,
    customFooter: data?.custom_footer || DEFAULT_PRINT_SETTINGS.customFooter,
    autoCut: data?.auto_cut ?? DEFAULT_PRINT_SETTINGS.autoCut,
    feedLines: data?.feed_lines || DEFAULT_PRINT_SETTINGS.feedLines,
    separatorChar: data?.separator_char || DEFAULT_PRINT_SETTINGS.separatorChar,
    showCustomerInfo: data?.show_customer_info ?? DEFAULT_PRINT_SETTINGS.showCustomerInfo,
    showOrderNotes: data?.show_order_notes ?? DEFAULT_PRINT_SETTINGS.showOrderNotes,
    showOperator: data?.show_operator ?? DEFAULT_PRINT_SETTINGS.showOperator,
    logoBase64: data?.logo_base64 || DEFAULT_PRINT_SETTINGS.logoBase64,
    autoPrintEnabled: data?.auto_print_enabled ?? DEFAULT_PRINT_SETTINGS.autoPrintEnabled,
    autoPrintType: data?.auto_print_type === 'kitchen' || data?.auto_print_type === 'both'
      ? data.auto_print_type
      : DEFAULT_PRINT_SETTINGS.autoPrintType,
    autoPrintRoutes: buildLegacyAutoPrintRoutes({
      autoPrintType: data?.auto_print_type,
      autoPrintRoutes: data?.auto_print_routes,
      barPrintEnabled: data?.bar_print_enabled === true
    }).map((entry) => entry.route),
    autoPrintOnAcceptEnabled: data?.auto_print_on_accept_enabled === true,
    barPrintEnabled: data?.bar_print_enabled === true
  };
}

function resolvePaymentMethodName(paymentMethodId, methods) {
  if (!paymentMethodId) return '';

  if (paymentMethodId && !String(paymentMethodId).includes('_') && String(paymentMethodId).length < 20) {
    return paymentMethodId;
  }

  const method = methods.find((entry) => entry.id === paymentMethodId);
  return method?.name || paymentMethodId;
}

function createDefaultPairingStore(adminClientId = null) {
  return {
    getPairing: () => Settings.getPairing(adminClientId),
    savePairing: (pairing) => Settings.savePairing(pairing),
    updatePairing: (partialPairing) => {
      if (adminClientId) {
        return Settings.updatePairing(adminClientId, partialPairing);
      }
      return Settings.updatePairing(partialPairing);
    },
    clearPairing: () => Settings.clearPairing(adminClientId)
  };
}

class PairedPrintListener {
  constructor(printerManager, options = {}) {
    const adminClientId = typeof options.adminClientId === 'string' && options.adminClientId.trim()
      ? options.adminClientId.trim()
      : null;

    this.printerManager = printerManager;
    this.dispatchQueue = options.dispatchQueue || new PrinterDispatchQueue();
    this.pairingStore = options.pairingStore || createDefaultPairingStore(adminClientId);
    this.supabaseStorageKey = typeof options.storageKey === 'string' && options.storageKey.trim()
      ? options.storageKey.trim()
      : SUPABASE_STORAGE_KEY;
    this.fetchImpl = options.fetchImpl || fetchCompat;
    this.renderTimeoutMs = Number.isFinite(Number(options.renderTimeoutMs))
      ? Math.max(1000, Number(options.renderTimeoutMs))
      : 5000;
    this.performanceNow = typeof options.performanceNow === 'function'
      ? options.performanceNow
      : () => performance.now();
    this.wallClockNow = typeof options.wallClockNow === 'function'
      ? options.wallClockNow
      : () => Date.now();
    this.traceIdFactory = typeof options.traceIdFactory === 'function'
      ? options.traceIdFactory
      : () => createPrintTraceId();
    this.supabase = null;
    this.currentPairing = this.pairingStore.getPairing();
    this.status = 'idle';
    this.lastError = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.watchdogTimer = null;
    this.watchdogRunning = false;
    this.isStopping = false;
    this.connectionAttemptId = 0;
    this.orderChannel = null;
    this.printJobsChannel = null;
    this.printSettingsChannel = null;
    this.authSubscription = null;
    this.processedOrderIds = new Set();
    this.processingOrderIds = new Set();
    this.processedJobIds = new Set();
    this.processingJobIds = new Set();
    // IDs de pedidos do cardapio digital ADIADOS na chegada pela regra
    // "imprimir somente ao aceitar". Usado como rede de seguranca: o watchdog
    // reprocessa esses pedidos por ID (sem depender de created_at nem do
    // evento UPDATE do Realtime) e imprime assim que saem do estado de espera.
    this.deferredAcceptOrderIds = new Set();
    this.deferredAcceptOrderTimes = new Map();
    this.paymentMethodsCache = {
      adminClientId: null,
      data: [],
      time: 0
    };
    this.printSettings = Object.assign({}, DEFAULT_PRINT_SETTINGS);
    this.lastSettingsRefreshAt = 0;
    this.lastRecoveryRunAt = 0;
    this.lastPrinterRefreshAt = 0;
  }

  setPrinterManager(printerManager) {
    this.printerManager = printerManager;
  }

  getLogContext() {
    const adminClientId = this.currentPairing?.adminClientId || 'sem-loja';
    const storeName = this.currentPairing?.storeName || null;
    return storeName
      ? `[Pairing][${storeName}][${adminClientId}]`
      : `[Pairing][${adminClientId}]`;
  }

  getPrintPerformanceNow() {
    try {
      const value = Number(this.performanceNow());
      return Number.isFinite(value) ? value : performance.now();
    } catch {
      return performance.now();
    }
  }

  getPrintPerformanceElapsed(startedAt) {
    return Math.max(0, this.getPrintPerformanceNow() - Number(startedAt || 0));
  }

  createAutoPrintTelemetryContext(order, source) {
    try {
      const startedAt = this.getPrintPerformanceNow();
      const handlerStartedAt = this.wallClockNow();
      return {
        traceId: this.traceIdFactory(),
        storeId: this.currentPairing?.adminClientId || null,
        orderId: order?.id == null ? '' : String(order.id),
        source: source == null ? '' : String(source),
        pickupMs: calculatePickupMs(order, source, handlerStartedAt),
        startedAt
      };
    } catch {
      return null;
    }
  }

  emitAutoPrintTelemetry(context, details = {}) {
    if (!context) return null;

    try {
      return emitPrintPerformance(logger, {
        traceId: context.traceId,
        storeId: context.storeId,
        orderId: context.orderId,
        via: details.via,
        printer: details.printer,
        source: context.source,
        outcome: details.outcome
      }, {
        pickupMs: context.pickupMs,
        claimMs: details.claimMs,
        renderMs: details.renderMs,
        queueWaitMs: details.queueWaitMs,
        spoolMs: details.spoolMs,
        totalMs: details.totalMs ?? (
          Math.max(0, Number(context.pickupMs) || 0) +
          this.getPrintPerformanceElapsed(context.startedAt)
        )
      });
    } catch {
      return null;
    }
  }

  hasValidPairing(pairing) {
    return Boolean(
      pairing &&
      pairing.enabled !== false &&
      pairing.adminClientId &&
      pairing.appBaseUrl &&
      pairing.supabaseUrl &&
      pairing.anonKey &&
      pairing.session &&
      pairing.session.access_token &&
      pairing.session.refresh_token
    );
  }

  createSupabaseStorage() {
    return {
      getItem: async (key) => {
        if (key !== this.supabaseStorageKey) return null;
        const pairing = this.pairingStore.getPairing();
        return pairing?.session ? JSON.stringify(pairing.session) : null;
      },
      setItem: async (key, value) => {
        if (key !== this.supabaseStorageKey || typeof value !== 'string') return;
        try {
          const parsed = JSON.parse(value);
          const session = normalizeSession(parsed);
          this.pairingStore.updatePairing({ session });
          this.currentPairing = this.pairingStore.getPairing();
        } catch (error) {
          logger.warn('[Pairing] Falha ao persistir sessão do Supabase:', error && error.message ? error.message : error);
        }
      },
      removeItem: async (key) => {
        if (key !== this.supabaseStorageKey) return;
        this.pairingStore.updatePairing({ session: null });
        this.currentPairing = this.pairingStore.getPairing();
      }
    };
  }

  resetRuntimeCaches() {
    this.processedOrderIds.clear();
    this.processingOrderIds.clear();
    this.processedJobIds.clear();
    this.processingJobIds.clear();
    // Nao limpamos deferredAcceptOrderIds aqui: ele e a rede de seguranca para
    // pedidos adiados aguardando aceite e deve sobreviver a reconexoes do Realtime.
  }

  trimRuntimeCache(setRef) {
    if (setRef.size > MAX_RUNTIME_CACHE) {
      setRef.clear();
    }
  }

  rememberDeferredAcceptOrder(orderId) {
    const id = String(orderId || '').trim();
    if (!id) return;
    this.deferredAcceptOrderIds.add(id);
    this.deferredAcceptOrderTimes.set(id, Date.now());
    this.trimRuntimeCache(this.deferredAcceptOrderIds);
  }

  forgetDeferredAcceptOrder(orderId) {
    const id = String(orderId || '').trim();
    if (!id) return;
    this.deferredAcceptOrderIds.delete(id);
    this.deferredAcceptOrderTimes.delete(id);
  }

  isDeferredAcceptOrderTooOld(orderId) {
    const id = String(orderId || '').trim();
    if (!id) return true;
    const rememberedAt = this.deferredAcceptOrderTimes.get(id);
    if (!Number.isFinite(rememberedAt)) return false;
    return (Date.now() - rememberedAt) > AUTO_PRINT_RECOVERY_MAX_AGE_MS;
  }

  getStatus() {
    const pairing = this.currentPairing || this.pairingStore.getPairing();
    const active = this.status === 'active';
    const paired = this.hasValidPairing(pairing);

    return {
      paired,
      active,
      controlsAutoPrint: paired && active,
      status: this.status,
      adminClientId: pairing?.adminClientId || null,
      appBaseUrl: pairing?.appBaseUrl || null,
      storeName: pairing?.storeName || null,
      userEmail: pairing?.userEmail || null,
      pairedAt: pairing?.pairedAt || null,
      lastSeenAt: pairing?.lastSeenAt || null,
      autoPrintEnabled: this.printSettings.autoPrintEnabled === true,
      autoPrintType: this.printSettings.autoPrintType || 'counter',
      autoPrintRoutes: Array.isArray(this.printSettings.autoPrintRoutes) ? this.printSettings.autoPrintRoutes : ['counter'],
      autoPrintOnAcceptEnabled: this.printSettings.autoPrintOnAcceptEnabled === true,
      barPrintEnabled: this.printSettings.barPrintEnabled === true,
      lastError: this.lastError
    };
  }

  touchHeartbeat() {
    if (!this.currentPairing?.adminClientId) return;
    const now = new Date().toISOString();
    this.pairingStore.updatePairing({ lastSeenAt: now });
    this.currentPairing = this.pairingStore.getPairing();
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.touchHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.touchHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  startWatchdog() {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      void this.runWatchdog('interval');
    }, WATCHDOG_INTERVAL_MS);
    void this.runWatchdog('startup');
  }

  stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.watchdogRunning = false;
  }

  async ensureSessionFresh(force = false) {
    if (!this.supabase?.auth || !this.currentPairing?.session) return;

    const expiresAt = Number(this.currentPairing.session.expires_at || 0) * 1000;
    const shouldRefresh =
      force ||
      (expiresAt > 0 && (expiresAt - Date.now()) <= SESSION_REFRESH_THRESHOLD_MS);

    if (!shouldRefresh) {
      return;
    }

    let refreshedSession = null;

    if (typeof this.supabase.auth.refreshSession === 'function') {
      const { data, error } = await this.supabase.auth.refreshSession();
      if (error) {
        throw error;
      }
      refreshedSession = normalizeSession(data?.session || null);
    }

    if (!refreshedSession && typeof this.supabase.auth.setSession === 'function') {
      const { data, error } = await this.supabase.auth.setSession({
        access_token: this.currentPairing.session.access_token,
        refresh_token: this.currentPairing.session.refresh_token
      });
      if (error) {
        throw error;
      }
      refreshedSession = normalizeSession(data?.session || this.currentPairing.session);
    }

    if (refreshedSession) {
      this.pairingStore.updatePairing({ session: refreshedSession });
      this.currentPairing = this.pairingStore.getPairing();
      if (this.supabase?.realtime && typeof this.supabase.realtime.setAuth === 'function') {
        await this.supabase.realtime.setAuth(refreshedSession.access_token);
      }
      logger.info(`${this.getLogContext()} Sessão do serviço renovada.`);
    }
  }

  async runWatchdog(source = 'manual') {
    if (this.watchdogRunning || this.isStopping) return;
    if (!this.currentPairing?.adminClientId) return;
    if (this.status !== 'active' && this.status !== 'reconnecting') return;

    this.watchdogRunning = true;

    try {
      await this.ensureSessionFresh();

      if ((Date.now() - this.lastSettingsRefreshAt) > 60000) {
        await this.refreshPrintSettings();
      }

      await this.processPendingJobs();

      if ((Date.now() - this.lastRecoveryRunAt) > (WATCHDOG_INTERVAL_MS - 1000)) {
        await this.recoverMissedOrders({ forceLookbackMs: RECOVERY_LOOKBACK_MS });
      }

      // Rede de seguranca da regra "imprimir somente ao aceitar": roda sempre
      // (e barata — so consulta quando ha pedidos adiados pendentes) e nao depende
      // da janela de created_at do recoverMissedOrders.
      await this.recoverDeferredAcceptOrders();
    } catch (error) {
      logger.warn(
        `${this.getLogContext()} Watchdog (${source}) detectou falha:`,
        error && error.message ? error.message : error
      );
      this.scheduleReconnect(error);
    } finally {
      this.watchdogRunning = false;
    }
  }

  isRetriablePrintError(error) {
    if (error?.printOutcomeUncertain === true) return false;

    const message = String(error && error.message ? error.message : error || '').toLowerCase();
    return [
      'renderizar impressao',
      'renderizar impressão',
      'payload de impressao invalido',
      'payload de impressão inválido',
      'fetch failed',
      'network',
      'timeout',
      'closed',
      'socket',
      'econn',
      'auth',
      'token',
      'sessao',
      'sessão',
      'http 500',
      'http 502',
      'http 503',
      'http 504'
    ].some((snippet) => message.includes(snippet));
  }

  shouldForceSessionRefresh(error) {
    const message = String(error && error.message ? error.message : error || '').toLowerCase();
    return ['auth', 'token', 'sessao', 'sessão', 'jwt', '401', '403'].some((snippet) => message.includes(snippet));
  }

  async refreshPrintersIfNeeded(force = false) {
    if (!this.printerManager || typeof this.printerManager.refreshPrinters !== 'function') return;

    const now = Date.now();
    if (!force && typeof this.printerManager.getPrinters === 'function') {
      const cachedPrinters = this.printerManager.getPrinters();
      if (Array.isArray(cachedPrinters) && cachedPrinters.length > 0) {
        // A descoberta automática do Hub já atualiza este cache a cada 30s.
        // Não bloquear um pedido aguardando PowerShell quando já conhecemos a
        // impressora; retries continuam usando force=true para recuperar troca,
        // desconexão ou instalação recente.
        this.lastPrinterRefreshAt = now;
        return;
      }
    }

    if (!force && this.lastPrinterRefreshAt && (now - this.lastPrinterRefreshAt) < PRINTER_REFRESH_TTL_MS) {
      return;
    }

    await this.printerManager.refreshPrinters(process.platform === 'win32');
    this.lastPrinterRefreshAt = Date.now();
  }

  async runPrintActionWithRetry(action, contextLabel) {
    let lastError = null;

    for (let attempt = 1; attempt <= PRINT_RETRY_ATTEMPTS; attempt += 1) {
      try {
        if (attempt > 1) {
          if (this.shouldForceSessionRefresh(lastError)) {
            await this.ensureSessionFresh(true);
          }

          try {
            await this.refreshPrintersIfNeeded(true);
          } catch (error) {
            logger.warn(`${this.getLogContext()} Falha ao atualizar impressoras antes do retry:`, error && error.message ? error.message : error);
          }

          await delay(Math.min(1000 * attempt, 4000));
        }

        return await action();
      } catch (error) {
        lastError = error;

        if (attempt >= PRINT_RETRY_ATTEMPTS || !this.isRetriablePrintError(error)) {
          throw error;
        }

        logger.warn(
          `${this.getLogContext()} Retry ${attempt}/${PRINT_RETRY_ATTEMPTS - 1} para ${contextLabel}:`,
          error && error.message ? error.message : error
        );
      }
    }

    throw lastError;
  }

  async recoverNow(source = 'manual') {
    if (!this.hasValidPairing(this.currentPairing)) {
      return this.getStatus();
    }

    if (this.status === 'active' || this.status === 'reconnecting') {
      await this.runWatchdog(source);
      return this.getStatus();
    }

    return this.startFromSettings();
  }

  async startFromSettings() {
    const pairing = this.pairingStore.getPairing();
    this.currentPairing = pairing;

    if (!this.hasValidPairing(pairing)) {
      logger.info('[Pairing] Nenhum pareamento ativo encontrado no bootstrap.');
      this.status = 'idle';
      return this.getStatus();
    }

    return this.startWithPairing(pairing, { recoverMissedOrders: true });
  }

  async pair(payload) {
    const adminClientId = typeof payload?.adminClientId === 'string' ? payload.adminClientId.trim() : '';
    const supabaseUrl = typeof payload?.supabaseUrl === 'string' ? payload.supabaseUrl.trim() : '';
    const anonKey = typeof payload?.anonKey === 'string' ? payload.anonKey.trim() : '';
    const session = normalizeSession(payload?.session);

    if (!adminClientId) {
      throw new Error('adminClientId é obrigatório');
    }
    if (!supabaseUrl) {
      throw new Error('supabaseUrl é obrigatório');
    }
    if (!anonKey) {
      throw new Error('anonKey é obrigatório');
    }
    if (!session) {
      throw new Error('Sessão Supabase inválida ou ausente');
    }

    const existingPairing = this.pairingStore.getPairing();
    const sameAdminClient = existingPairing?.adminClientId === adminClientId;
    const now = new Date().toISOString();

    const nextPairing = {
      enabled: true,
      adminClientId,
      appBaseUrl: normalizeAppBaseUrl(payload?.appBaseUrl) || existingPairing?.appBaseUrl || null,
      storeName: typeof payload?.storeName === 'string' && payload.storeName.trim()
        ? payload.storeName.trim()
        : existingPairing?.storeName || null,
      supabaseUrl,
      anonKey,
      userId: typeof payload?.userId === 'string' && payload.userId.trim()
        ? payload.userId.trim()
        : existingPairing?.userId || null,
      userEmail: typeof payload?.userEmail === 'string' && payload.userEmail.trim()
        ? payload.userEmail.trim()
        : existingPairing?.userEmail || null,
      pairedAt: now,
      lastSeenAt: sameAdminClient && existingPairing?.lastSeenAt ? existingPairing.lastSeenAt : now,
      session
    };

    this.pairingStore.savePairing(nextPairing);
    this.currentPairing = this.pairingStore.getPairing();

    // Se já está ativo com o mesmo adminClientId, apenas atualiza appBaseUrl e sessão
    // sem reiniciar o listener (evita reconexão desnecessária a cada heartbeat do browser).
    if (sameAdminClient && this.status === 'active') {
      logger.info(`${this.getLogContext()} Re-pareamento leve: appBaseUrl e sessão atualizados sem reiniciar listener.`);
      if (this.supabase?.auth && nextPairing.session?.access_token) {
        try {
          await this.supabase.auth.setSession({
            access_token: nextPairing.session.access_token,
            refresh_token: nextPairing.session.refresh_token
          });
        } catch (e) {
          logger.warn(`${this.getLogContext()} Falha ao atualizar sessão no re-pareamento leve:`, e && e.message ? e.message : e);
        }
      }
      return this.getStatus();
    }

    await this.startWithPairing(this.currentPairing, {
      recoverMissedOrders: sameAdminClient
    });

    return this.getStatus();
  }

  async unpair() {
    await this.stop({ clearPairing: true });
    return this.getStatus();
  }

  async stop(options = {}) {
    const { clearPairing = false } = options;
    this.isStopping = true;
    const logContext = this.getLogContext();

    this.stopHeartbeat();
    this.stopWatchdog();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const channels = [this.orderChannel, this.printJobsChannel, this.printSettingsChannel].filter(Boolean);
    this.orderChannel = null;
    this.printJobsChannel = null;
    this.printSettingsChannel = null;

    const supabase = this.supabase;
    const realtime = supabase?.realtime || null;

    for (const channel of channels) {
      if (!channel || typeof channel.unsubscribe !== 'function') continue;

      try {
        await channel.unsubscribe();
      } catch (error) {
        logger.warn(
          `${logContext} Falha ao encerrar canal do Supabase:`,
          error && error.message ? error.message : error
        );
      }
    }

    if (this.authSubscription && typeof this.authSubscription.unsubscribe === 'function') {
      try {
        this.authSubscription.unsubscribe();
      } catch (error) {}
    }
    this.authSubscription = null;

    if (supabase?.auth && typeof supabase.auth.stopAutoRefresh === 'function') {
      try {
        supabase.auth.stopAutoRefresh();
      } catch (error) {}
    }

    const closeError = safeDisposeRealtimeClient(realtime);
    if (closeError) {
      logger.warn(
        `${logContext} Falha ao encerrar socket Realtime:`,
        closeError && closeError.message ? closeError.message : closeError
      );
    }

    this.supabase = null;
    this.resetRuntimeCaches();
    this.status = clearPairing ? 'idle' : 'stopped';
    this.lastError = clearPairing ? null : this.lastError;

    if (clearPairing) {
      this.pairingStore.clearPairing();
      this.currentPairing = this.pairingStore.getPairing();
      this.printSettings = Object.assign({}, DEFAULT_PRINT_SETTINGS);
      this.paymentMethodsCache = {
        adminClientId: null,
        data: [],
        time: 0
      };
    }

    this.isStopping = false;
  }

  async startWithPairing(pairing, options = {}) {
    const { recoverMissedOrders = true } = options;

    await this.stop();
    const connectionAttemptId = this.connectionAttemptId + 1;
    this.connectionAttemptId = connectionAttemptId;
    this.status = 'connecting';
    this.lastError = null;
    this.currentPairing = pairing;

    try {
      const createClient = await getCreateClient();

      this.supabase = createClient(pairing.supabaseUrl, pairing.anonKey, {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: false,
          storage: this.createSupabaseStorage(),
          storageKey: this.supabaseStorageKey
        },
        realtime: {
          transport: SafeWebSocketTransport,
          timeout: REALTIME_CLIENT_TIMEOUT_MS
        },
        global: {
          headers: {
            'x-client-info': 'hub-impressao-background'
          }
        }
      });
      patchRealtimeConnect(this.supabase?.realtime);

      if (this.supabase.auth && typeof this.supabase.auth.onAuthStateChange === 'function') {
        const { data } = this.supabase.auth.onAuthStateChange((event, session) => {
          logger.info(`${this.getLogContext()} Evento de autenticação do serviço: ${event}`);
          this.pairingStore.updatePairing({ session: normalizeSession(session) });
          this.currentPairing = this.pairingStore.getPairing();
          if (event === 'SIGNED_OUT') {
            this.scheduleReconnect(new Error('Sessão do serviço foi encerrada.'), connectionAttemptId);
          }
        });
        this.authSubscription = data?.subscription || null;
      }

      const { data: sessionData, error: sessionError } = await this.supabase.auth.setSession({
        access_token: pairing.session.access_token,
        refresh_token: pairing.session.refresh_token
      });

      if (sessionError) {
        throw sessionError;
      }

      const session = normalizeSession(sessionData?.session || pairing.session);
      if (!session) {
        throw new Error('Não foi possível estabelecer uma sessão Supabase válida no serviço.');
      }

      this.pairingStore.updatePairing({ session });
      this.currentPairing = this.pairingStore.getPairing();
      await this.supabase.realtime.setAuth(session.access_token);

      if (this.supabase.auth && typeof this.supabase.auth.startAutoRefresh === 'function') {
        try {
          this.supabase.auth.startAutoRefresh();
        } catch (error) {
          logger.warn('[Pairing] Falha ao iniciar auto refresh de sessão:', error && error.message ? error.message : error);
        }
      }

      await this.refreshPrintSettings();
      await this.subscribeChannels(connectionAttemptId);

      this.status = 'active';
      this.reconnectAttempt = 0;
      this.startHeartbeat();
      this.startWatchdog();

      if (recoverMissedOrders && pairing.lastSeenAt) {
        await this.recoverMissedOrders();
      } else {
        logger.info(`${this.getLogContext()} Primeiro pareamento detectado. Sem recuperação retroativa para evitar duplicidade.`);
        this.touchHeartbeat();
      }

      await this.processPendingJobs();
      return this.getStatus();
    } catch (error) {
      this.lastError = error && error.message ? error.message : String(error);
      this.status = 'error';
      logger.error('[Pairing] Falha ao iniciar listener pareado:', error);
      throw error;
    }
  }

  async subscribeChannels() {
    if (!this.supabase || !this.currentPairing?.adminClientId) {
      throw new Error('Supabase ou adminClientId indisponível para inscrição.');
    }

    const adminClientId = this.currentPairing.adminClientId;
    const connectionAttemptId = this.connectionAttemptId;

    this.orderChannel = this.supabase
      .channel(`hub-impressao-orders-${adminClientId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'orders',
          filter: `admin_client_id=eq.${adminClientId}`
        },
        async (payload) => {
          try {
            if (this.isStopping || connectionAttemptId !== this.connectionAttemptId) return;
            this.touchHeartbeat();
            const order = payload.new;
            if (!order?.id) return;

            if (payload.eventType === 'INSERT') {
              if (isPixOnlineOrder(order) && order.payment_status !== 'paid') {
                logger.info(`${this.getLogContext()} PIX online pendente para pedido #${order.order_number || order.id}. Aguardando confirmação.`);
                return;
              }

              await this.handleAutoPrintOrder(order, 'realtime_insert');
            }

            if (payload.eventType === 'UPDATE') {
              if (
                isPixOnlineOrder(order) &&
                order.payment_status === 'paid' &&
                order.status === 'awaiting'
              ) {
                logger.info(`${this.getLogContext()} PIX confirmado para pedido #${order.order_number || order.id}.`);
                await this.handleAutoPrintOrder(order, 'realtime_update_paid');
              }

              // "Imprimir somente ao aceitar": pedido do cardapio digital saiu de
              // awaiting/confirmed/pending_payment para um status imprimivel = foi aceito.
              const previousStatus = String(payload.old?.status || '').trim().toLowerCase();
              const wasAwaitingAcceptance = AWAITING_ACCEPTANCE_STATUSES.has(previousStatus);
              if (
                this.printSettings.autoPrintOnAcceptEnabled &&
                isDigitalMenuOrder(order) &&
                wasAwaitingAcceptance &&
                !isAwaitingAcceptance(order) &&
                !isOrderCancelled(order)
              ) {
                logger.info(`${this.getLogContext()} Pedido #${order.order_number || order.id} do cardapio digital aceito. Imprimindo agora.`);
                await this.handleAutoPrintOrder(order, 'realtime_update_accepted');
              }
            }
          } catch (error) {
            logger.error('[Pairing] Erro ao processar evento de pedido:', error);
          }
        }
      );

    this.printJobsChannel = this.supabase
      .channel(`hub-impressao-print-jobs-${adminClientId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'print_jobs',
          filter: `admin_client_id=eq.${adminClientId}`
        },
        async (payload) => {
          try {
            if (this.isStopping || connectionAttemptId !== this.connectionAttemptId) return;
            this.touchHeartbeat();
            const job = payload.new;
            if (!job?.id || job.status !== 'pending') return;
            await this.processPrintJob(job, 'realtime_insert');
          } catch (error) {
            logger.error('[Pairing] Erro ao processar evento de print job:', error);
          }
        }
      );

    this.printSettingsChannel = this.supabase
      .channel(`hub-impressao-print-settings-${adminClientId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'print_settings',
          filter: `admin_client_id=eq.${adminClientId}`
        },
        async () => {
          try {
            if (this.isStopping || connectionAttemptId !== this.connectionAttemptId) return;
            this.touchHeartbeat();
            await this.refreshPrintSettings();
          } catch (error) {
            logger.error('[Pairing] Erro ao atualizar configurações de impressão:', error);
          }
        }
      );

    await Promise.all([
      this.awaitChannelSubscription(this.orderChannel, 'orders', connectionAttemptId),
      this.awaitChannelSubscription(this.printJobsChannel, 'print_jobs', connectionAttemptId),
      this.awaitChannelSubscription(this.printSettingsChannel, 'print_settings', connectionAttemptId)
    ]);
  }

  awaitChannelSubscription(channel, label, connectionAttemptId) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        handler(value);
      };

      const timeout = setTimeout(() => {
        if (this.isStopping || connectionAttemptId !== this.connectionAttemptId) {
          finish(resolve);
          return;
        }
        const error = new Error(`Timeout ao assinar canal ${label}`);
        this.scheduleReconnect(error, connectionAttemptId);
        finish(reject, error);
      }, CHANNEL_SUBSCRIBE_TIMEOUT_MS);

      channel.subscribe((status) => {
        if (this.isStopping || connectionAttemptId !== this.connectionAttemptId) {
          clearTimeout(timeout);
          finish(resolve);
          return;
        }

        logger.info(`${this.getLogContext()} Canal ${label} status=${status}`);

        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout);
          finish(resolve);
          return;
        }

        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          clearTimeout(timeout);
          const error = new Error(`Canal ${label} entrou em estado ${status}`);
          this.scheduleReconnect(error, connectionAttemptId);
          finish(reject, error);
        }
      });
    });
  }

  scheduleReconnect(reason, connectionAttemptId = this.connectionAttemptId) {
    if (reason?.printOutcomeUncertain === true) {
      return;
    }

    if (this.isStopping || connectionAttemptId !== this.connectionAttemptId) {
      return;
    }

    if (!this.currentPairing || !this.hasValidPairing(this.currentPairing)) {
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    this.status = 'reconnecting';
    this.lastError = reason && reason.message ? reason.message : String(reason);

    const delayMs = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30000);
    this.reconnectAttempt += 1;

    logger.warn(`${this.getLogContext()} Reconectando listener em ${delayMs}ms. Motivo: ${this.lastError}`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      try {
        await this.startFromSettings();
      } catch (error) {
        this.scheduleReconnect(error);
      }
    }, delayMs);
  }

  async refreshPrintSettings() {
    if (!this.supabase || !this.currentPairing?.adminClientId) {
      this.printSettings = Object.assign({}, DEFAULT_PRINT_SETTINGS);
      return this.printSettings;
    }

    const { data, error } = await this.supabase
      .from('print_settings')
      .select('*')
      .eq('admin_client_id', this.currentPairing.adminClientId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    this.printSettings = mapPrintSettingsFromDB(data || {});
    this.lastSettingsRefreshAt = Date.now();

    logger.info(
      `${this.getLogContext()} Configurações sincronizadas: autoPrint=${this.printSettings.autoPrintEnabled} type=${this.printSettings.autoPrintType} routes=${(this.printSettings.autoPrintRoutes || []).join(',')} bar=${this.printSettings.barPrintEnabled === true}`
    );

    return this.printSettings;
  }

  async recoverMissedOrders(options = {}) {
    const { forceLookbackMs = null } = options;
    if (!this.supabase || !this.currentPairing?.adminClientId) return;
    if (!this.printSettings.autoPrintEnabled && !this.printSettings.autoPrintOnAcceptEnabled) {
      logger.info(`${this.getLogContext()} Auto print desativado. Recuperação de pedidos ignorada.`);
      this.touchHeartbeat();
      return;
    }

    const lastSeenAt = parseIsoDate(this.currentPairing.lastSeenAt);
    let sinceDate = lastSeenAt
      ? new Date(lastSeenAt.getTime() - RECOVERY_SKEW_MS)
      : new Date(Date.now() - (forceLookbackMs || RECOVERY_LOOKBACK_MS));

    if (forceLookbackMs) {
      const minimumSince = new Date(Date.now() - forceLookbackMs);
      if (sinceDate.getTime() < minimumSince.getTime()) {
        sinceDate = minimumSince;
      }
    }

    const automaticRecoverySince = new Date(Date.now() - AUTO_PRINT_RECOVERY_MAX_AGE_MS);
    if (sinceDate.getTime() < automaticRecoverySince.getTime()) {
      sinceDate = automaticRecoverySince;
    }

    const sinceIso = sinceDate.toISOString();
    logger.info(`${this.getLogContext()} Recuperando pedidos desde ${sinceIso}`);

    const { data: recentOrders, error } = await this.supabase
      .from('orders')
      .select('*')
      .eq('admin_client_id', this.currentPairing.adminClientId)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .limit(50);

    if (error) {
      throw error;
    }

    const eligibleOrders = (recentOrders || []).filter((order) => {
      if (!order?.id) return false;
      if (isManualPrintOnlyOrder(order)) return false;
      if (isRecoveredOrderTooOld(order)) return false;
      if (isOrderCancelled(order)) return false;
      if (isPixOnlineOrder(order) && order.payment_status !== 'paid') return false;
      // Nao recuperar/imprimir pedidos do cardapio digital ainda aguardando aceite.
      // Mas registra na rede de seguranca para imprimir assim que forem aceitos —
      // importante para repopular o Set apos um reinicio do Hub.
      if (shouldDeferUntilAccept(order, this.printSettings)) {
        this.rememberDeferredAcceptOrder(order.id);
        return false;
      }
      if (
        this.printSettings.autoPrintOnAcceptEnabled &&
        isDigitalMenuOrder(order) &&
        !isAwaitingAcceptance(order)
      ) {
        return true;
      }
      if (!this.printSettings.autoPrintEnabled) {
        return false;
      }
      return true;
    });

    if (!eligibleOrders.length) {
      this.touchHeartbeat();
      return;
    }

    for (const order of eligibleOrders) {
      await this.handleAutoPrintOrder(order, 'recovery');
    }

    this.lastRecoveryRunAt = Date.now();
    this.touchHeartbeat();
  }

  /**
   * Rede de seguranca para a regra "imprimir somente ao aceitar".
   *
   * O recoverMissedOrders padrao filtra por created_at (janela curta, ~lastSeenAt).
   * Um pedido aceito foi CRIADO quando chegou (minutos antes), entao o seu created_at
   * fica fora da janela e ele nunca seria recuperado se o evento UPDATE do aceite
   * fosse perdido (queda de Realtime, app em segundo plano, REPLICA IDENTITY ausente).
   *
   * Aqui reprocessamos por ID os pedidos que ESTE Hub adiou na chegada: buscamos o
   * estado atual e, se ja sairam do estado de espera (foram aceitos) e ainda nao tem
   * print job, imprimimos. Independe de created_at e do evento UPDATE.
   */
  async recoverDeferredAcceptOrders() {
    if (!this.supabase || !this.currentPairing?.adminClientId) return;
    if (!this.printSettings.autoPrintOnAcceptEnabled) return;
    if (this.deferredAcceptOrderIds.size === 0) return;

    const ids = Array.from(this.deferredAcceptOrderIds)
      .filter((id) => {
        if (!this.isDeferredAcceptOrderTooOld(id)) return true;
        this.forgetDeferredAcceptOrder(id);
        logger.warn(`${this.getLogContext()} Pedido ${id} aguardou aceite por mais de ${Math.round(AUTO_PRINT_RECOVERY_MAX_AGE_MS / 60000)}min. Auto print atrasado cancelado para evitar backlog.`);
        return false;
      })
      .slice(0, 50);

    if (ids.length === 0) return;

    const { data: orders, error } = await this.supabase
      .from('orders')
      .select('*')
      .eq('admin_client_id', this.currentPairing.adminClientId)
      .in('id', ids);

    if (error) {
      logger.warn(`${this.getLogContext()} Falha ao recuperar pedidos adiados (aceite):`, error.message || error);
      return;
    }

    // IDs que sumiram (apagados) saem do Set para nao crescer indefinidamente.
    const foundIds = new Set((orders || []).map((order) => String(order.id)));
    for (const id of ids) {
      if (!foundIds.has(id)) this.forgetDeferredAcceptOrder(id);
    }

    for (const order of orders || []) {
      const orderId = String(order.id);

      if (isManualPrintOnlyOrder(order)) {
        this.forgetDeferredAcceptOrder(orderId);
        continue;
      }

      if (isOrderCancelled(order)) {
        this.forgetDeferredAcceptOrder(orderId);
        continue;
      }

      // Ainda aguardando aceite: mantem na rede de seguranca para a proxima rodada.
      if (shouldDeferUntilAccept(order, this.printSettings)) {
        continue;
      }

      // Saiu do estado de espera = foi aceito. Imprime agora (handleAutoPrintOrder
      // ja faz o claim atomico no ledger e remove o ID do Set de adiados).
      logger.info(`${this.getLogContext()} Pedido #${order.order_number || orderId} aceito detectado via rede de seguranca (sem depender do UPDATE). Imprimindo.`);
      await this.handleAutoPrintOrder(order, 'recovery_accept');
    }
  }

  async processPendingJobs() {
    if (!this.supabase || !this.currentPairing?.adminClientId) return;

    const cutoff = new Date(Date.now() - PENDING_PRINT_JOB_RECOVERY_MAX_AGE_MS).toISOString();

    const { data: expiredJobs, error: expireError } = await this.supabase
      .from('print_jobs')
      .update({ status: 'failed' })
      .eq('admin_client_id', this.currentPairing.adminClientId)
      .eq('status', 'pending')
      .lt('created_at', cutoff)
      .select('id, order_id, printer_type, created_at');

    if (expireError) {
      logger.warn(`${this.getLogContext()} Falha ao expirar print_jobs antigos:`, expireError.message || expireError);
    } else if (Array.isArray(expiredJobs) && expiredJobs.length > 0) {
      logger.warn(`${this.getLogContext()} ${expiredJobs.length} print_job(s) antigo(s) marcado(s) como failed para evitar backlog de impressão.`);
    }

    const { data, error } = await this.supabase
      .from('print_jobs')
      .select('*')
      .eq('admin_client_id', this.currentPairing.adminClientId)
      .eq('status', 'pending')
      .gte('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(PENDING_PRINT_JOB_RECOVERY_LIMIT);

    if (error) {
      throw error;
    }

    for (const job of data || []) {
      await this.processPrintJob(job, 'pending_recovery');
    }
  }

  async hasPrintJobWithStatuses(orderId, statuses = ['printed']) {
    if (!this.supabase || !this.currentPairing?.adminClientId) return false;
    if (!Array.isArray(statuses) || statuses.length === 0) return false;

    const { data, error } = await this.supabase
      .from('print_jobs')
      .select('id')
      .eq('admin_client_id', this.currentPairing.adminClientId)
      .eq('order_id', orderId)
      .in('status', statuses)
      .limit(1);

    if (error) {
      logger.warn('[Pairing] Falha ao verificar histórico de impressão:', error.message || error);
      return false;
    }

    return Array.isArray(data) && data.length > 0;
  }

  async isOrderAlreadyPrinted(orderId) {
    return this.hasPrintJobWithStatuses(orderId, ['printed']);
  }

  async hasPendingOrPrintedPrintJob(orderId) {
    return this.hasPrintJobWithStatuses(orderId, ['pending', 'printed']);
  }

  async markOrderPrinted(orderId, printerType = 'counter') {
    if (!this.supabase || !this.currentPairing?.adminClientId) return;

    const printedAt = new Date().toISOString();
    const adminClientId = this.currentPairing.adminClientId;

    // Tenta fazer UPDATE em job pendente/falho existente
    const { data: updated } = await this.supabase
      .from('print_jobs')
      .update({ status: 'printed', printed_at: printedAt, printer_type: printerType })
      .eq('admin_client_id', adminClientId)
      .eq('order_id', orderId)
      .in('status', ['pending', 'failed'])
      .select()
      .limit(1);

    if (updated && updated.length > 0) {
      return updated[0];
    }

    // Nenhum job pendente — insere direto com ON CONFLICT DO NOTHING.
    // O índice único parcial (admin_client_id, order_id WHERE status='printed')
    // garante atomicidade: só um processo vence, os demais retornam sem dados.
    const { data, error } = await this.supabase
      .from('print_jobs')
      .insert({
        admin_client_id: adminClientId,
        order_id: orderId,
        printer_type: printerType,
        status: 'printed',
        printed_at: printedAt
      })
      .select()
      .single();

    // Código 23505 = unique_violation — outro processo já registrou, tudo certo
    if (error && error.code !== '23505') {
      throw error;
    }

    return data || null;
  }

  // Reivindica atomicamente a impressão de um pedido ANTES do papel sair.
  // O índice parcial idx_print_jobs_unique_printed_order (admin_client_id, order_id WHERE status='printed')
  // garante que apenas um Hub vença a corrida — os demais recebem 23505 e abortam o print.
  // Tradeoff intencional: se o processo cair apos o claim e antes/durante o spool,
  // o ledger pode ficar como impresso sem papel. Priorizamos nao duplicar papel;
  // falhas observadas liberam apenas a via afetada, com duas tentativas no fluxo abaixo.
  // Retorna a linha criada quando vence, null quando outro Hub já reivindicou.
  async claimAutoPrintLedger(orderId, printerType) {
    if (!this.supabase || !this.currentPairing?.adminClientId) return null;

    const { data, error } = await this.supabase
      .from('print_jobs')
      .insert({
        admin_client_id: this.currentPairing.adminClientId,
        order_id: orderId,
        printer_type: printerType,
        status: 'printed',
        printed_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return null;
      }
      throw error;
    }

    return data;
  }

  // Reverte um claim quando a impressão fisica falha — mantém o pedido elegível
  // para retry/recovery em vez de deixá-lo "registrado como impresso" sem papel.
  async releaseAutoPrintLedger(jobId) {
    if (!this.supabase || !jobId) return;

    const { error } = await this.supabase
      .from('print_jobs')
      .delete()
      .eq('id', jobId);

    if (error) {
      throw error;
    }
  }

  // CAS atômico: vence o UPDATE apenas o Hub que encontra o job ainda em 'pending'.
  // Os demais recebem data=null e param antes de mandar papel para a impressora.
  async claimPrintJob(jobId) {
    if (!this.supabase || !jobId) return null;

    const { data, error } = await this.supabase
      .from('print_jobs')
      .update({ status: 'printed', printed_at: new Date().toISOString() })
      .eq('id', jobId)
      .eq('status', 'pending')
      .select()
      .maybeSingle();

    if (error) throw error;
    return data || null;
  }

  async updatePrintJobStatus(jobId, status) {
    if (!this.supabase) return;

    const payload = {
      status,
      printed_at: status === 'printed' ? new Date().toISOString() : null
    };

    const { error } = await this.supabase
      .from('print_jobs')
      .update(payload)
      .eq('id', jobId);

    if (error) {
      throw error;
    }
  }

  async getPaymentMethods() {
    if (!this.supabase || !this.currentPairing?.adminClientId) {
      return [];
    }

    const now = Date.now();
    if (
      this.paymentMethodsCache.adminClientId === this.currentPairing.adminClientId &&
      (now - this.paymentMethodsCache.time) < PAYMENT_METHODS_CACHE_TTL_MS
    ) {
      return this.paymentMethodsCache.data;
    }

    const { data, error } = await this.supabase
      .from('payment_methods')
      .select('id, name')
      .eq('admin_client_id', this.currentPairing.adminClientId);

    if (error) {
      logger.warn('[Pairing] Erro ao buscar metodos de pagamento:', error.message || error);
      return this.paymentMethodsCache.data || [];
    }

    this.paymentMethodsCache = {
      adminClientId: this.currentPairing.adminClientId,
      data: data || [],
      time: now
    };

    return this.paymentMethodsCache.data;
  }

  async prepareOrderForPrinting(order) {
    const paymentMethods = await this.getPaymentMethods();
    const paymentMethodName = resolvePaymentMethodName(order.payment_method, paymentMethods);
    const rawPaymentMethod = String(order.payment_method || '');
    const isPaidOnline = rawPaymentMethod === 'pix_online' || rawPaymentMethod.toLowerCase().includes('online');

    return Object.assign({}, order, {
      items: parseArrayLike(order.items),
      payment_method: isPaidOnline ? 'Pix Online' : paymentMethodName,
      payment_status: order.payment_status,
      customData: order.customData || order.custom_data,
      origin: order.origin || order.order_origin || order.source
    });
  }

  hasMultipleStoreContexts() {
    const configuredStoreCount = Object.keys(Settings.getAll().storePrinters || {}).filter(Boolean).length;
    const pairedStoreCount = Settings.getAllPairings().filter((pairing) => pairing?.adminClientId).length;
    return configuredStoreCount > 1 || pairedStoreCount > 1;
  }

  hasStorePrinterConfig(adminClientId) {
    if (!adminClientId) return false;
    const storePrinters = Settings.getAll().storePrinters || {};
    return Object.prototype.hasOwnProperty.call(storePrinters, adminClientId);
  }

  resolvePrinterId(type) {
    const adminClientId = this.currentPairing?.adminClientId || null;
    if (adminClientId) {
      const storePrinters = Settings.getStorePrinters(adminClientId);
      const configuredStorePrinter = storePrinters?.[type] || storePrinters?.default || null;
      if (configuredStorePrinter) {
        return configuredStorePrinter;
      }

      if (this.hasStorePrinterConfig(adminClientId) || this.hasMultipleStoreContexts()) {
        logger.warn(
          `${this.getLogContext()} Nenhuma impressora especifica para ${type}. Fallback global bloqueado para evitar impressao fora da configuracao da loja.`
        );
        return null;
      }
    }

    const configured = Settings.getPrinterForType(type);
    if (configured) {
      return configured;
    }

    const discovered = this.printerManager?.getPrinters?.() || [];
    if (!Array.isArray(discovered) || discovered.length === 0) {
      return null;
    }

    return discovered[0].id || discovered[0].name || null;
  }

  async resolveAvailablePrinterId(type) {
    const configuredPrinterId = this.resolvePrinterId(type);
    if (!configuredPrinterId) {
      return null;
    }

    if (this.printerManager && typeof this.printerManager.resolveAvailablePrinterName === 'function') {
      const availablePrinter = await this.printerManager.resolveAvailablePrinterName(configuredPrinterId, { allowDefault: false });
      if (!availablePrinter) {
        logger.warn(
          `${this.getLogContext()} Impressora configurada para ${type} nao esta disponivel no Windows: ${configuredPrinterId}`
        );
        return null;
      }

      return availablePrinter;
    }

    return configuredPrinterId;
  }

  // Resolver de AUTO-PRINT por impressora (separado do resolvePrinterId manual).
  // Le APENAS o sub-mapa explicito storePrinters.autoPrint[type]; passa pelo check
  // de disponibilidade (allowDefault:false). NUNCA cai para storePrinters.default,
  // Settings.getPrinterForType nem para a primeira impressora descoberta.
  async resolveAutoPrintPrinterId(type) {
    const adminClientId = this.currentPairing?.adminClientId || null;
    if (!adminClientId) {
      return null;
    }

    const storePrinters = Settings.getStorePrinters(adminClientId);
    const autoPrintMap = storePrinters?.autoPrint || null;
    const route = normalizeAutoPrintRoute(type);
    const configuredPrinterId = route
      ? getAutoPrintPrinterForRoute(autoPrintMap, route)
      : null;

    if (!configuredPrinterId) {
      // Sem impressora explicitamente configurada para esta via no auto-print → sem fallback.
      return null;
    }

    if (this.printerManager && typeof this.printerManager.resolveAvailablePrinterName === 'function') {
      const availablePrinter = await this.printerManager.resolveAvailablePrinterName(configuredPrinterId, { allowDefault: false });
      if (!availablePrinter) {
        logger.warn(
          `${this.getLogContext()} Impressora de auto-print para ${route || type} nao esta disponivel: ${configuredPrinterId}`
        );
        return null;
      }

      return availablePrinter;
    }

    return configuredPrinterId;
  }

  async resolvePrintPayload(orderId, printType, job = null) {
    const inlinePayload = job ? this.getJobPayload(job, printType) : null;
    if (inlinePayload) {
      return inlinePayload;
    }

    const appBaseUrl = this.currentPairing?.appBaseUrl || '';
    if (!appBaseUrl) {
      throw new Error(`Render oficial indisponivel para impressao do pedido ${orderId}`);
    }

    logger.info(`${this.getLogContext()} Buscando payload oficial no Pedidos Hub para pedido ${orderId}`);
    return this.fetchRenderedPayload(orderId, printType);
  }

  async fetchRenderedPayload(orderId, printType) {
    const payload = await this.requestOfficialRender({
      adminClientId: this.currentPairing?.adminClientId || null,
      orderId,
      printType
    });
    const normalized = this.normalizeRenderedPayload(payload, printType);
    if (!normalized) {
      throw new Error(`PedidosHub retornou um payload de impressão inválido para ${printType}`);
    }

    return normalized;
  }

  async requestOfficialRender(requestPayload) {
    const appBaseUrl = normalizeAppBaseUrl(this.currentPairing?.appBaseUrl);
    if (!appBaseUrl) {
      throw new Error('Origem do PedidosHub não configurada no pareamento');
    }

    await this.ensureSessionFresh();

    let authorization = getBearerAuthorization(this.currentPairing?.session);
    if (!authorization) {
      throw new Error('Sessão do serviço indisponível para renderizar a impressão');
    }

    const endpoint = `${appBaseUrl}/api/print/render`;
    const makeRequest = async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.renderTimeoutMs);

      try {
        const response = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: authorization
          },
          body: JSON.stringify(requestPayload),
          signal: controller.signal
        });
        let raw = null;
        if (typeof response?.json === 'function') {
          try {
            raw = await response.json();
          } catch (error) {
            if (controller.signal.aborted || error?.name === 'AbortError') {
              throw error;
            }
          }
        }
        return { response, raw };
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') {
          throw new Error(`Timeout ao renderizar impressão no PedidosHub após ${this.renderTimeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    };

    let { response, raw } = await makeRequest();

    if (response.status === 401) {
      logger.warn(`${this.getLogContext()} Render oficial retornou 401; renovando sessão e tentando novamente.`);
      await this.ensureSessionFresh(true);
      authorization = getBearerAuthorization(this.currentPairing?.session);
      if (!authorization) {
        throw new Error('Sessão do serviço indisponível após renovar autenticação');
      }
      ({ response, raw } = await makeRequest());
    }
    if (!response.ok) {
      const detail = raw?.error || raw?.message || `HTTP ${response.status}`;
      throw new Error(`Falha ao renderizar impressão no PedidosHub: ${detail}`);
    }

    return raw?.payload || raw?.data || raw;
  }

  normalizeRenderedPayload(candidate, printType) {
    if (!candidate || typeof candidate.rawContent !== 'string' || !candidate.rawContent.trim()) {
      return null;
    }

    return {
      rawContent: candidate.rawContent.trim(),
      encoding: typeof candidate.encoding === 'string' && candidate.encoding.trim()
        ? candidate.encoding.trim()
        : 'base64',
      printType
    };
  }

  async fetchRenderedPayloads(orderId, printTypes) {
    const uniqueTypes = Array.isArray(printTypes) ? [...new Set(printTypes)] : [];
    if (uniqueTypes.length === 0) {
      throw new Error('Nenhum tipo de impressão solicitado para renderização');
    }

    const payload = await this.requestOfficialRender({
      adminClientId: this.currentPairing?.adminClientId || null,
      orderId,
      printTypes: uniqueTypes
    });
    const variants = payload?.variants;

    if (variants && typeof variants === 'object' && !Array.isArray(variants)) {
      const normalizedEntries = uniqueTypes.map((printType) => [
        printType,
        this.normalizeRenderedPayload(variants[printType], printType)
      ]);

      if (normalizedEntries.every(([, candidate]) => candidate)) {
        return Object.fromEntries(normalizedEntries);
      }
    }

    const legacyEntries = await Promise.all(uniqueTypes.map(async (printType) => [
      printType,
      await this.fetchRenderedPayload(orderId, printType)
    ]));
    return Object.fromEntries(legacyEntries);
  }

  getJobPayload(job, requestedType) {
    const content = job && typeof job.content === 'object' ? job.content : null;
    if (!content) return null;

    const requestedKey = requestedType === 'kitchen' || requestedType === 'both'
      ? requestedType
      : 'counter';

    const variant = content.variants && typeof content.variants === 'object'
      ? content.variants[requestedKey] || null
      : null;

    const candidate = variant && typeof variant === 'object' ? variant : content;
    if (typeof candidate.rawContent !== 'string' || !candidate.rawContent.trim()) {
      return null;
    }

    return {
      rawContent: candidate.rawContent.trim(),
      encoding: typeof candidate.encoding === 'string' && candidate.encoding.trim()
        ? candidate.encoding.trim()
        : 'base64'
    };
  }

  async printRawPayload(printerId, payload, printType) {
    if (!this.printerManager || typeof this.printerManager.print !== 'function') {
      throw new Error('PrinterManager indisponível no serviço local');
    }

    await this.printerManager.print({
      printer: printerId,
      rawContent: payload.rawContent,
      encoding: payload.encoding || 'base64',
      useRawContent: true,
      printType
    });
  }

  async printWithRouting(orderId, requestedType, job = null, orderData = null) {
    const printType = requestedType === 'kitchen' || requestedType === 'both' ? requestedType : 'counter';
    await this.refreshPrintersIfNeeded();

    if (printType === 'both') {
      const [kitchenPrinter, counterPrinter] = await Promise.all([
        this.resolveAvailablePrinterId('kitchen'),
        this.resolveAvailablePrinterId('counter')
      ]);

      if (!kitchenPrinter && !counterPrinter) {
        throw new Error('Nenhuma impressora configurada para auto print');
      }

      const kitchenPrinterKey = PrinterDispatchQueue.normalizePrinterKey(kitchenPrinter);
      const counterPrinterKey = PrinterDispatchQueue.normalizePrinterKey(counterPrinter);
      if (kitchenPrinter && counterPrinter && kitchenPrinterKey === counterPrinterKey) {
        const combinedPayload = await this.resolvePrintPayload(orderId, 'both', job, orderData);
        await this.dispatchQueue.enqueue(
          kitchenPrinter,
          () => this.printRawPayload(kitchenPrinter, combinedPayload, 'both')
        );
        return;
      }

      const routes = [];
      if (kitchenPrinter) {
        routes.push({ printerId: kitchenPrinter, printType: 'kitchen' });
      }
      if (counterPrinter) {
        routes.push({ printerId: counterPrinter, printType: 'counter' });
      }

      let payloads;
      if (routes.length === 1) {
        const route = routes[0];
        payloads = {
          [route.printType]: await this.resolvePrintPayload(
            orderId,
            route.printType,
            job,
            orderData
          )
        };
      } else if (job && job.content && typeof job.content === 'object') {
        const payloadEntries = await Promise.all(routes.map(async (route) => [
          route.printType,
          await this.resolvePrintPayload(orderId, route.printType, job, orderData)
        ]));
        payloads = Object.fromEntries(payloadEntries);
      } else {
        payloads = await this.fetchRenderedPayloads(
          orderId,
          routes.map((route) => route.printType)
        );
      }

      const printTasks = routes.map((route) => this.dispatchQueue.enqueue(
        route.printerId,
        () => this.printRawPayload(route.printerId, payloads[route.printType], route.printType)
      ));
      const printResults = await Promise.allSettled(printTasks);
      const firstFailure = printResults.find((result) => result.status === 'rejected');
      if (firstFailure) {
        throw firstFailure.reason;
      }
      return;
    }

    const printerId = await this.resolveAvailablePrinterId(printType);
    if (!printerId) {
      throw new Error(`Nenhuma impressora configurada para o tipo ${printType}`);
    }

    const payload = await this.resolvePrintPayload(orderId, printType, job, orderData);
    await this.dispatchQueue.enqueue(
      printerId,
      () => this.printRawPayload(printerId, payload, printType)
    );
  }

  async handleAutoPrintOrder(order, source) {
    const telemetryContext = this.createAutoPrintTelemetryContext(order, source);
    if (!this.currentPairing?.adminClientId) return;
    if (!order?.id) return;
    if (isManualPrintOnlyOrder(order)) {
      const orderId = String(order.id);
      this.forgetDeferredAcceptOrder(orderId);
      this.processedOrderIds.add(orderId);
      this.trimRuntimeCache(this.processedOrderIds);
      logger.info(`${this.getLogContext()} Atendimento #${order.order_number || orderId} exige recibo manual. Auto print ignorado.`);
      return;
    }
    if (isOrderCancelled(order)) {
      // Pedido cancelado/recusado nunca imprime e sai da rede de seguranca.
      this.forgetDeferredAcceptOrder(order.id);
      return;
    }
    if (isPixOnlineOrder(order) && order.payment_status !== 'paid') return;
    if (wasAutoPrintedOffline(order)) {
      const orderId = String(order.id);
      this.forgetDeferredAcceptOrder(orderId);
      this.processedOrderIds.add(orderId);
      this.trimRuntimeCache(this.processedOrderIds);
      logger.info(`${this.getLogContext()} Pedido #${order.order_number || orderId} ja foi impresso offline pelo navegador. Auto print do Hub ignorado.`);
      return;
    }
    // Regra "imprimir somente ao aceitar": pedidos do cardapio digital
    // que ainda nao foram aceitos pelo lojista nao saem na chegada.
    // A impressao acontece no handler de UPDATE (transicao de aceite) ou,
    // como rede de seguranca, na varredura recoverDeferredAcceptOrders().
    if (shouldDeferUntilAccept(order, this.printSettings)) {
      this.rememberDeferredAcceptOrder(order.id);
      logger.info(`${this.getLogContext()} Pedido #${order.order_number || order.id} do cardapio digital aguardando aceite. Impressao adiada (fonte=${source}).`);
      return;
    }

    if (
      !this.printSettings.autoPrintEnabled &&
      !(
        this.printSettings.autoPrintOnAcceptEnabled &&
        isDigitalMenuOrder(order) &&
        !isAwaitingAcceptance(order)
      )
    ) {
      return;
    }

    const orderId = String(order.id);

    // Passou da checagem de defer (nao esta mais aguardando aceite): sai da
    // rede de seguranca de adiados, independentemente do resultado da impressao.
    this.forgetDeferredAcceptOrder(orderId);

    // Guard em memória (mesma instância)
    if (this.processingOrderIds.has(orderId) || this.processedOrderIds.has(orderId)) {
      logger.info(`${this.getLogContext()} Pedido #${order.order_number || orderId} já em processamento/impresso (memória). Ignorando.`);
      return;
    }

    this.processingOrderIds.add(orderId);
    this.trimRuntimeCache(this.processingOrderIds);

    // Sub-mapa explicito de auto-print por impressora (task 3.8). Quando NAO e null,
    // entramos no modo per-printer: cada via vai SOMENTE para a impressora explicitamente
    // configurada, sem fallback para default. Quando e null, mantemos o caminho legado
    // (printWithRouting com o autoPrintType global) inalterado.
    const storePrinters = Settings.getStorePrinters(this.currentPairing.adminClientId);
    const autoPrintMap = normalizeAutoPrintMap(storePrinters?.autoPrint || null);

    let claimedJob = null;

    try {
      if (autoPrintMap) {
        // Modo per-printer: roteia cada via aplicavel apenas para sua impressora
        // explicita, reivindica o ledger por printer_type (exactly-once por via) e
        // pula vias sem impressora configurada (sem fallback para default).
        await this.autoPrintPerPrinter(order, orderId, autoPrintMap, source, telemetryContext);
        this.processedOrderIds.add(orderId);
        this.trimRuntimeCache(this.processedOrderIds);
        logger.info(`${this.getLogContext()} Pedido #${order.order_number || orderId} processado para auto-print por impressora.`);
        return;
      }

      const hasScheduledOrPrintedJob = await this.hasPendingOrPrintedPrintJob(orderId);
      if (hasScheduledOrPrintedJob) {
        logger.info(
          `${this.getLogContext()} Pedido #${order.order_number || orderId} já possui print job pendente/impresso. Ignorando auto print.`
        );
        this.processedOrderIds.add(orderId);
        this.trimRuntimeCache(this.processedOrderIds);
        return;
      }

      // Modo legado (sem sub-mapa autoPrint): usa a seleção por checkbox
      // persistida em auto_print_routes, com fallback para auto_print_type antigo.
      const legacyRoutes = buildLegacyAutoPrintRoutes(this.printSettings);
      if (legacyRoutes.length === 0) {
        logger.info(`${this.getLogContext()} Pedido #${order.order_number || orderId}: nenhuma via automática selecionada.`);
        this.processedOrderIds.add(orderId);
        this.trimRuntimeCache(this.processedOrderIds);
        return;
      }

      let printedAnyRoute = false;
      for (const route of legacyRoutes) {
        const claimStartedAt = this.getPrintPerformanceNow();
        let claimMs = 0;
        try {
          claimedJob = await this.claimAutoPrintLedger(orderId, route.ledgerType);
          claimMs = this.getPrintPerformanceElapsed(claimStartedAt);
        } catch (claimError) {
          claimMs = this.getPrintPerformanceElapsed(claimStartedAt);
          this.emitAutoPrintTelemetry(telemetryContext, {
            via: route.ledgerType,
            outcome: 'failed',
            claimMs
          });
          throw claimError;
        }

        if (!claimedJob) {
          this.emitAutoPrintTelemetry(telemetryContext, {
            via: route.ledgerType,
            outcome: 'skipped',
            claimMs
          });
          logger.info(
            `${this.getLogContext()} Pedido #${order.order_number || orderId} via ${route.ledgerType} já reivindicada por outro Hub. Via ignorada.`
          );
          continue;
        }

        logger.info(
          `${this.getLogContext()} Imprimindo pedido #${order.order_number || orderId} via ${route.printType} (fonte=${source})`
        );

        const legacyPrintStartedAt = this.getPrintPerformanceNow();
        let spoolMs = 0;
        try {
          await this.runPrintActionWithRetry(
            () => this.printWithRouting(orderId, route.printType, null, order),
            `auto print ${route.ledgerType} do pedido #${order.order_number || orderId}`
          );
          spoolMs = this.getPrintPerformanceElapsed(legacyPrintStartedAt);
          this.emitAutoPrintTelemetry(telemetryContext, {
            via: route.ledgerType,
            outcome: 'printed',
            claimMs,
            spoolMs
          });
          printedAnyRoute = true;
          claimedJob = null;
        } catch (printError) {
          spoolMs = this.getPrintPerformanceElapsed(legacyPrintStartedAt);
          this.emitAutoPrintTelemetry(telemetryContext, {
            via: route.ledgerType,
            outcome: 'failed',
            claimMs,
            spoolMs
          });

          if (printError?.printOutcomeUncertain !== true) {
            // Falha comprovada devolve a reivindicacao para recovery. Resultado
            // incerto mantem o claim conservador para evitar papel duplicado.
            try {
              await this.releaseAutoPrintLedger(claimedJob.id);
            } catch (releaseError) {
              logger.warn(
                `${this.getLogContext()} Falha ao liberar claim ${claimedJob.id} apos erro de auto-print legado:`,
                releaseError
              );
            }
          }
          claimedJob = null;
          throw printError;
        }
      }

      if (!printedAnyRoute) {
        logger.info(
          `${this.getLogContext()} Pedido #${order.order_number || orderId} já reivindicado por outro Hub. Auto print ignorado para evitar duplicidade.`
        );
        this.processedOrderIds.add(orderId);
        this.trimRuntimeCache(this.processedOrderIds);
        return;
      }

      this.processedOrderIds.add(orderId);
      this.trimRuntimeCache(this.processedOrderIds);
      logger.info(`${this.getLogContext()} Pedido #${order.order_number || orderId} impresso e registrado.`);
    } catch (error) {
      logger.error(
        `[Pairing] Falha ao imprimir automaticamente pedido #${order.order_number || orderId}:`,
        error
      );
      if (this.isRetriablePrintError(error)) {
        this.scheduleReconnect(error);
      }
    } finally {
      this.processingOrderIds.delete(orderId);
    }
  }

  // Auto-print por impressora (modo per-printer). Espelha buildAutoPrintTargets do
  // frontend: monta as vias aplicaveis a partir do sub-mapa autoPrint + tipo do pedido,
  // imprime cada via exatamente uma vez na sua impressora explicita e PULA vias sem
  // impressora resolvida (sem fallback para default). O ledger e reivindicado por
  // printer_type para que cada via seja exactly-once de forma independente.
  async autoPrintPerPrinter(order, orderId, autoPrintMap, source, telemetryContext = null) {
    const activeTelemetry = telemetryContext || this.createAutoPrintTelemetryContext(order, source);
    await this.refreshPrintersIfNeeded();

    const vias = buildAutoPrintRoutesForOrder(autoPrintMap, order, {
      barPrintEnabled: this.printSettings.barPrintEnabled === true,
      autoPrintRoutes: this.printSettings.autoPrintRoutes,
      autoPrintType: this.printSettings.autoPrintType
    })
      .map((via) => ({
        resolveType: via.route,
        printType: via.printType,
        ledgerType: via.route
      }));

    if (vias.length === 0) {
      logger.info(
        `${this.getLogContext()} Pedido #${order.order_number || orderId}: nenhuma via aplicavel com impressora de auto-print configurada. Nada a imprimir.`
      );
      return;
    }

    const resolutionResults = await Promise.allSettled(vias.map(async (via) => ({
      ...via,
      printerId: await this.resolveAutoPrintPrinterId(via.resolveType)
    })));

    const availableVias = [];
    const resolverFailures = [];
    resolutionResults.forEach((result, index) => {
      const configuredVia = vias[index];
      if (result.status === 'rejected') {
        this.emitAutoPrintTelemetry(activeTelemetry, {
          via: configuredVia.ledgerType,
          outcome: 'failed'
        });
        logger.error(
          `${this.getLogContext()} Pedido #${order.order_number || orderId}: falha ao resolver impressora da via ${configuredVia.resolveType}:`,
          result.reason
        );
        resolverFailures.push(result.reason);
        return;
      }

      const via = result.value;
      const { printerId } = via;
      if (!printerId) {
        // Sem impressora explicita/disponivel para esta via → pula (sem fallback).
        this.emitAutoPrintTelemetry(activeTelemetry, {
          via: via.ledgerType,
          outcome: 'skipped'
        });
        logger.info(
          `${this.getLogContext()} Pedido #${order.order_number || orderId}: via ${via.resolveType} sem impressora de auto-print disponivel. Via ignorada (sem fallback).`
        );
        return;
      }
      availableVias.push(via);
    });

    if (availableVias.length === 0) {
      if (resolverFailures.length > 0) {
        throw resolverFailures[0];
      }
      return;
    }

    const renderStartedAt = this.getPrintPerformanceNow();
    let renderMs = 0;
    const renderPromise = (async () => {
      try {
        const payloads = await this.fetchRenderedPayloads(
          orderId,
          availableVias.map((via) => via.printType)
        );
        renderMs = this.getPrintPerformanceElapsed(renderStartedAt);
        return payloads;
      } catch (renderError) {
        renderMs = this.getPrintPerformanceElapsed(renderStartedAt);
        throw renderError;
      }
    })();

    // Reserva todas as filas em ordem de rota antes de aguardar o render compartilhado.
    // Assim pedidos posteriores nao ultrapassam este pedido na mesma impressora,
    // enquanto impressoras distintas aguardam o mesmo render em paralelo.
    const printTasks = availableVias.map((via) => {
      const timings = {
        claimMs: 0,
        renderMs: 0,
        queueWaitMs: 0,
        spoolMs: 0
      };
      const taskState = {
        failurePhase: null,
        telemetryEmitted: false
      };
      const enqueuedAt = this.getPrintPerformanceNow();
      let printTask;

      try {
        printTask = this.dispatchQueue.enqueue(via.printerId, async () => {
          timings.queueWaitMs = this.getPrintPerformanceElapsed(enqueuedAt);
          let payloads;

          try {
            payloads = await renderPromise;
            timings.renderMs = renderMs;
          } catch (renderError) {
            timings.renderMs = renderMs;
            taskState.failurePhase = 'render';
            taskState.telemetryEmitted = true;
            this.emitAutoPrintTelemetry(activeTelemetry, {
              via: via.ledgerType,
              printer: via.printerId,
              outcome: 'failed',
              ...timings
            });
            throw renderError;
          }

          const claimStartedAt = this.getPrintPerformanceNow();
          let claimedJob;

          try {
            claimedJob = await this.claimAutoPrintLedger(orderId, via.ledgerType);
            timings.claimMs = this.getPrintPerformanceElapsed(claimStartedAt);
          } catch (claimError) {
            timings.claimMs = this.getPrintPerformanceElapsed(claimStartedAt);
            taskState.failurePhase = 'claim';
            taskState.telemetryEmitted = true;
            this.emitAutoPrintTelemetry(activeTelemetry, {
              via: via.ledgerType,
              printer: via.printerId,
              outcome: 'failed',
              ...timings
            });
            throw claimError;
          }

          if (!claimedJob) {
            taskState.telemetryEmitted = true;
            this.emitAutoPrintTelemetry(activeTelemetry, {
              via: via.ledgerType,
              printer: via.printerId,
              outcome: 'skipped',
              ...timings
            });
            logger.info(
              `${this.getLogContext()} Pedido #${order.order_number || orderId}: via ${via.ledgerType} ja reivindicada (ledger). Via ignorada para evitar duplicidade.`
            );
            return 'skipped';
          }

          const retryStartedAt = this.getPrintPerformanceNow();
          try {
            await this.runPrintActionWithRetry(
              () => this.printRawPayload(
                via.printerId,
                payloads[via.printType],
                via.printType
              ),
              `auto print (${via.ledgerType}) do pedido #${order.order_number || orderId}`
            );
            timings.spoolMs = this.getPrintPerformanceElapsed(retryStartedAt);
            taskState.telemetryEmitted = true;
            this.emitAutoPrintTelemetry(activeTelemetry, {
              via: via.ledgerType,
              printer: via.printerId,
              outcome: 'printed',
              ...timings
            });
            return 'printed';
          } catch (printError) {
            timings.spoolMs = this.getPrintPerformanceElapsed(retryStartedAt);
            taskState.failurePhase = 'print';

            if (printError?.printOutcomeUncertain === true) {
              taskState.telemetryEmitted = true;
              this.emitAutoPrintTelemetry(activeTelemetry, {
                via: via.ledgerType,
                printer: via.printerId,
                outcome: 'failed',
                ...timings
              });
              throw printError;
            }

            let releaseError = null;
            for (let attempt = 1; attempt <= 2; attempt += 1) {
              try {
                await this.releaseAutoPrintLedger(claimedJob.id);
                releaseError = null;
                break;
              } catch (error) {
                releaseError = error;
                logger.warn(
                  `${this.getLogContext()} Pedido #${order.order_number || orderId}: tentativa ${attempt}/2 de liberar claim ${claimedJob.id} apos erro de impressao falhou:`,
                  error
                );
              }
            }

            taskState.telemetryEmitted = true;
            this.emitAutoPrintTelemetry(activeTelemetry, {
              via: via.ledgerType,
              printer: via.printerId,
              outcome: 'failed',
              ...timings
            });

            if (releaseError) {
              taskState.failurePhase = 'release';
              const combinedError = new AggregateError(
                [printError, releaseError],
                `Falha ao imprimir via ${via.ledgerType} e liberar claim ${claimedJob.id}`
              );
              combinedError.printError = printError;
              combinedError.releaseError = releaseError;

              logger.error(
                `${this.getLogContext()} Pedido #${order.order_number || orderId}: erro de impressao da via ${via.ledgerType}:`,
                printError
              );
              logger.error(
                `${this.getLogContext()} Pedido #${order.order_number || orderId}: erro final ao liberar claim ${claimedJob.id}:`,
                releaseError
              );
              throw combinedError;
            }

            throw printError;
          }
        });
      } catch (enqueueError) {
        printTask = Promise.reject(enqueueError);
      }

      return {
        via,
        timings,
        taskState,
        promise: Promise.resolve(printTask)
      };
    });
    const printResults = await Promise.allSettled(printTasks.map((entry) => entry.promise));
    const routeFailures = [];

    printResults.forEach((result, index) => {
      const { via, timings, taskState } = printTasks[index];
      if (result.status === 'fulfilled') {
        if (result.value === 'printed') {
          logger.info(
            `${this.getLogContext()} Pedido #${order.order_number || orderId}: via ${via.ledgerType} impressa em ${via.printerId}.`
          );
        }
        return;
      }

      if (!taskState.telemetryEmitted) {
        taskState.telemetryEmitted = true;
        this.emitAutoPrintTelemetry(activeTelemetry, {
          via: via.ledgerType,
          printer: via.printerId,
          outcome: 'failed',
          ...timings
        });
      }

      logger.error(
        `${this.getLogContext()} Pedido #${order.order_number || orderId}: falha na fase ${taskState.failurePhase || 'enqueue'} da via ${via.ledgerType} em ${via.printerId}:`,
        result.reason
      );
      routeFailures.push(result.reason);
    });

    if (routeFailures.length > 0) {
      throw routeFailures[0];
    }
    if (resolverFailures.length > 0) {
      throw resolverFailures[0];
    }
  }

  /**
   * Registra que um pedido foi impresso via WebSocket (browser → Hub).
   * Impede que o listener Realtime reimprima o mesmo pedido.
   */
  normalizeNotifyOrderId(firstArg, secondArg) {
    const value = secondArg || firstArg;
    return value ? String(value) : null;
  }

  notifyOrderPrintingViaWebSocket(orderIdOrAdminClientId, maybeOrderId) {
    const orderId = this.normalizeNotifyOrderId(orderIdOrAdminClientId, maybeOrderId);
    if (!orderId) return;
    const id = String(orderId);
    this.processingOrderIds.add(id);
    this.trimRuntimeCache(this.processingOrderIds);
    logger.info(`[Pairing] Pedido #${id} marcado como em impressão via WebSocket.`);
  }

  notifyOrderPrintedViaWebSocket(orderIdOrAdminClientId, maybeOrderId) {
    const orderId = this.normalizeNotifyOrderId(orderIdOrAdminClientId, maybeOrderId);
    if (!orderId) return;
    const id = String(orderId);
    this.processedOrderIds.add(id);
    this.processingOrderIds.delete(id);
    this.trimRuntimeCache(this.processedOrderIds);
    logger.info(`[Pairing] Pedido #${id} marcado como impresso via WebSocket — Realtime não vai reimprimir.`);

    const printerType = normalizeAutoPrintRoute(this.printSettings.autoPrintType) || 'attendance';
    void this.markOrderPrinted(id, printerType).catch((error) => {
      logger.warn(`[Pairing] Falha ao registrar pedido #${id} como impresso após WebSocket:`, error && error.message ? error.message : error);
    });
  }

  notifyOrderPrintFailedViaWebSocket(orderIdOrAdminClientId, maybeOrderId) {
    const orderId = this.normalizeNotifyOrderId(orderIdOrAdminClientId, maybeOrderId);
    if (!orderId) return;
    const id = String(orderId);
    this.processingOrderIds.delete(id);
    logger.info(`[Pairing] Pedido #${id} removido da fila em memória após falha no fluxo WebSocket.`);
  }

  async processPrintJob(job, source) {
    if (!this.currentPairing?.adminClientId || !this.supabase) return;
    if (!job?.id) return;

    if (source !== 'realtime_insert' && isRecoveredPrintJobTooOld(job)) {
      logger.warn(`${this.getLogContext()} Print job ${job.id} antigo ignorado na recuperação para evitar backlog de impressão.`);
      await this.updatePrintJobStatus(job.id, 'failed');
      return;
    }

    const jobId = String(job.id);
    if (this.processingJobIds.has(jobId) || this.processedJobIds.has(jobId)) {
      return;
    }

    this.processingJobIds.add(jobId);
    this.trimRuntimeCache(this.processingJobIds);

    let claimedJob = false;

    try {
      await this.refreshPrintSettings();
      if (!this.printSettings.autoPrintEnabled) {
        logger.info(`${this.getLogContext()} Auto print desativado. Print job ${jobId} ignorado enquanto a loja estiver desligada.`);
        return;
      }

      if (!job.order_id) {
        await this.updatePrintJobStatus(job.id, 'failed');
        return;
      }

      const orderId = String(job.order_id);
      if (this.processedOrderIds.has(orderId)) {
        // Pedido já foi impresso por outro fluxo desta instância — só promove o job (best-effort).
        await this.claimPrintJob(jobId).catch(() => null);
        this.processedJobIds.add(jobId);
        this.trimRuntimeCache(this.processedJobIds);
        return;
      }

      if (this.processingOrderIds.has(orderId)) {
        logger.info(`[Pairing] Print job ${jobId} ignorado por enquanto: pedido ${orderId} já está em impressão local.`);
        return;
      }

      if (await this.isOrderAlreadyPrinted(orderId)) {
        await this.claimPrintJob(jobId).catch(() => null);
        this.processedJobIds.add(jobId);
        this.trimRuntimeCache(this.processedJobIds);
        return;
      }

      // Reivindica o job atomicamente — UPDATE só vence se status ainda for 'pending'.
      // Hubs concorrentes recebem data=null e param antes de mandar papel para a impressora.
      const claim = await this.claimPrintJob(jobId);
      if (!claim) {
        logger.info(`[Pairing] Print job ${jobId} já reivindicado por outro Hub. Ignorando para evitar duplicidade.`);
        this.processedJobIds.add(jobId);
        this.trimRuntimeCache(this.processedJobIds);
        return;
      }
      claimedJob = true;

      const requestedType = job.printer_type === 'kitchen' || job.printer_type === 'both' || job.printer_type === 'bar'
        ? job.printer_type
        : 'counter';

      logger.info(`[Pairing] Processando print job ${jobId} (fonte=${source}) para pedido ${orderId}`);
      this.processingOrderIds.add(orderId);
      this.trimRuntimeCache(this.processingOrderIds);

      try {
        await this.runPrintActionWithRetry(
          () => this.printWithRouting(orderId, requestedType, job),
          `print job ${jobId}`
        );
      } catch (printError) {
        if (printError?.printOutcomeUncertain === true) {
          // O claim ja marcou o job como impresso. Como o spool pode ter aceitado
          // o papel, preserva o status e os guards de memoria para nao reprocessar.
          this.processedOrderIds.add(orderId);
          this.trimRuntimeCache(this.processedOrderIds);
          this.processedJobIds.add(jobId);
          this.trimRuntimeCache(this.processedJobIds);
          throw printError;
        }

        // Erro recuperável volta para pending: o watchdog tenta novamente dentro
        // da janela curta de recuperação. Erro definitivo vira failed.
        const nextStatus = this.isRetriablePrintError(printError) ? 'pending' : 'failed';
        try {
          await this.updatePrintJobStatus(job.id, nextStatus);
        } catch (updateError) {
          logger.error(`[Pairing] Falha ao marcar print job ${jobId} como ${nextStatus}:`, updateError);
        }
        throw printError;
      }

      this.processedOrderIds.add(orderId);
      this.trimRuntimeCache(this.processedOrderIds);
      this.processedJobIds.add(jobId);
      this.trimRuntimeCache(this.processedJobIds);
    } catch (error) {
      logger.error(`[Pairing] Falha ao processar print job ${jobId}:`, error);
      if (this.isRetriablePrintError(error)) {
        this.scheduleReconnect(error);
      }
      // Se o erro foi antes do claim ganhar, erro recuperável volta para pending
      // e erro definitivo vira failed.
      // Se foi depois, já tratamos no catch interno acima — não duplicamos o UPDATE.
      if (!claimedJob) {
        const nextStatus = this.isRetriablePrintError(error) ? 'pending' : 'failed';
        try {
          await this.updatePrintJobStatus(job.id, nextStatus);
        } catch (updateError) {
          logger.error(`[Pairing] Falha ao marcar print job ${jobId} como ${nextStatus}:`, updateError);
        }
      }
    } finally {
      if (job?.order_id) {
        this.processingOrderIds.delete(String(job.order_id));
      }
      this.processingJobIds.delete(jobId);
    }
  }

  /**
   * Indica se um pedido recebido por um canal externo (ex.: WebSocket do
   * navegador) deve ser adiado por causa da regra "imprimir somente ao aceitar".
   * Pedidos do cardapio digital que ainda estao aguardando aceite NAO devem ser
   * impressos na chegada, mesmo que o front-end dispare a impressao.
   */
  shouldDeferOrderUntilAccept(orderData) {
    return shouldDeferUntilAccept(orderData, this.printSettings);
  }
}

module.exports = PairedPrintListener;
