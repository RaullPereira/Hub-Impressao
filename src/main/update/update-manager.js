'use strict';

const packageJson = require('../../../package.json');

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 15 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 30 * 1000;

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeErrorCode(error) {
  const candidate = typeof error?.code === 'string' ? error.code.trim() : '';
  if (/^[A-Z0-9_-]{2,80}$/i.test(candidate)) return candidate;
  return 'update_check_failed';
}

class UpdateManager {
  constructor(options = {}) {
    if (!options.autoUpdater) throw new Error('autoUpdater is required');

    this.autoUpdater = options.autoUpdater;
    this.logger = options.logger || console;
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
    this.isPackaged = options.isPackaged === true;
    this.platform = options.platform || process.platform;
    this.initialDelayMs = finiteNumber(options.initialDelayMs, DEFAULT_INITIAL_DELAY_MS);
    this.intervalMs = finiteNumber(options.intervalMs, DEFAULT_INTERVAL_MS);
    this.retryDelayMs = finiteNumber(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
    this.setTimeoutImpl = options.setTimeoutImpl || setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
    this.timer = null;
    this.checkPromise = null;
    this.started = false;
    this.disposed = false;
    this.installTriggered = false;
    this.boundEvents = [];
    this.status = {
      state: 'idle',
      currentVersion: options.currentVersion || packageJson.version,
      availableVersion: null,
      readyVersion: null,
      progressPercent: null,
      transferredBytes: null,
      totalBytes: null,
      lastCheckedAt: null,
      errorCode: null
    };

    this.autoUpdater.autoDownload = true;
    this.autoUpdater.autoInstallOnAppQuit = true;
    this.bindUpdaterEvents();
  }

  bind(event, handler) {
    this.autoUpdater.on(event, handler);
    this.boundEvents.push({ event, handler });
  }

  bindUpdaterEvents() {
    this.bind('checking-for-update', () => {
      this.setStatus({ state: 'checking', errorCode: null });
    });
    this.bind('update-available', (info = {}) => {
      this.setStatus({
        state: 'available',
        availableVersion: info.version || null,
        errorCode: null
      });
    });
    this.bind('update-not-available', () => {
      this.setStatus({
        state: 'idle',
        availableVersion: null,
        readyVersion: null,
        progressPercent: null,
        transferredBytes: null,
        totalBytes: null,
        errorCode: null
      });
    });
    this.bind('download-progress', (progress = {}) => {
      this.setStatus({
        state: 'downloading',
        progressPercent: finiteNumber(progress.percent, 0),
        transferredBytes: finiteNumber(progress.transferred, 0),
        totalBytes: finiteNumber(progress.total, 0),
        errorCode: null
      });
    });
    this.bind('update-downloaded', (info = {}) => {
      const version = info.version || this.status.availableVersion || null;
      this.setStatus({
        state: 'ready',
        availableVersion: version,
        readyVersion: version,
        progressPercent: 100,
        errorCode: null
      });
      this.logger.info(`[Updater] Versao ${version || 'nova'} pronta para instalar no fechamento.`);
    });
    this.bind('error', (error) => {
      this.handleError(error);
    });
  }

  setStatus(patch) {
    this.status = Object.assign({}, this.status, patch);
    try {
      this.onStatus(this.getStatus());
    } catch (error) {
      this.logger.warn('[Updater] Falha ao publicar estado:', sanitizeErrorCode(error));
    }
    return this.getStatus();
  }

  getStatus() {
    return Object.assign({}, this.status);
  }

  isSupportedRuntime() {
    return this.isPackaged && this.platform === 'win32';
  }

  start() {
    if (this.started || this.disposed) return this.getStatus();
    this.started = true;

    if (!this.isSupportedRuntime()) {
      this.logger.info('[Updater] Verificacao automatica desativada fora do Windows empacotado.');
      return this.getStatus();
    }

    this.schedule(this.initialDelayMs);
    return this.getStatus();
  }

  schedule(delayMs) {
    if (this.disposed || !this.isSupportedRuntime()) return;
    if (this.timer) this.clearTimeoutImpl(this.timer);
    this.timer = this.setTimeoutImpl(() => {
      this.timer = null;
      void this.checkNow();
    }, Math.max(0, finiteNumber(delayMs, this.intervalMs)));
  }

  async checkNow() {
    if (this.disposed || !this.isSupportedRuntime()) return this.getStatus();
    if (this.checkPromise) return this.checkPromise;

    this.setStatus({
      state: 'checking',
      lastCheckedAt: new Date().toISOString(),
      errorCode: null
    });

    this.checkPromise = (async () => {
      try {
        await this.autoUpdater.checkForUpdates();
        if (this.status.state === 'checking') {
          this.setStatus({ state: 'idle' });
        }
        this.schedule(this.intervalMs);
      } catch (error) {
        this.handleError(error);
        this.schedule(this.retryDelayMs);
      } finally {
        this.checkPromise = null;
      }
      return this.getStatus();
    })();

    return this.checkPromise;
  }

  handleError(error) {
    const errorCode = sanitizeErrorCode(error);
    this.setStatus({ state: 'error', errorCode });
    this.logger.warn(`[Updater] Falha nao bloqueante (${errorCode}).`);
  }

  installNow() {
    if (this.disposed || this.installTriggered || this.status.state !== 'ready') return false;
    this.installTriggered = true;
    this.logger.info(`[Updater] Reinicio e instalacao explicitos para ${this.status.readyVersion || 'nova versao'}.`);
    this.autoUpdater.quitAndInstall(false, true);
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
    for (const { event, handler } of this.boundEvents) {
      if (typeof this.autoUpdater.off === 'function') {
        this.autoUpdater.off(event, handler);
      } else if (typeof this.autoUpdater.removeListener === 'function') {
        this.autoUpdater.removeListener(event, handler);
      }
    }
    this.boundEvents = [];
  }
}

module.exports = UpdateManager;
module.exports.sanitizeErrorCode = sanitizeErrorCode;
