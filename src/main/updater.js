// Atualizacao automatica do Hub (so Windows, instalador principal).
//
// O Hub baixa a versao nova sozinho em segundo plano (feed `latest.yml` no
// storage publico, configurado em `build.publish` do package.json). A troca de
// versao NAO acontece sozinha: o instalador e perMachine (Program Files), entao
// o Windows pede confirmacao de administrador (UAC). Se isso rodasse sem
// ninguem na frente do computador e o UAC fosse recusado, o Hub ficaria
// fechado e a loja sem impressao. Por isso a instalacao so roda quando alguem
// clica em "Atualizar agora" (janela do Hub ou icone da bandeja), e espera a
// impressao em andamento terminar.
//
// Fora do Windows (Mac sem assinatura Apple), na variante Senhas e no build
// legado do Windows 7 (Electron 22) o atualizador fica desligado: o feed e do
// Hub principal e trocaria esses apps por uma versao incompativel.
const { EventEmitter } = require('events');
const logger = require('./utils/logger');

const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const IDLE_WAIT_TIMEOUT_MS = 60 * 1000;
const IDLE_POLL_MS = 500;
const MIN_ELECTRON_MAJOR = 28;

function isAutoUpdateSupported({ platform, isPackaged, variantName, electronVersion } = {}) {
  if (platform !== 'win32') return false;
  if (!isPackaged) return false;
  if (String(variantName || '').trim()) return false;
  const major = Number(String(electronVersion || '').split('.')[0]);
  return Number.isFinite(major) && major >= MIN_ELECTRON_MAJOR;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HubUpdater extends EventEmitter {
  constructor({ isBusy = () => false, loadAutoUpdater, environment, timers } = {}) {
    super();
    this.isBusy = isBusy;
    this.loadAutoUpdater = loadAutoUpdater || (() => require('electron-updater').autoUpdater);
    this.environment = environment || {};
    this.timers = timers || { setTimeout, setInterval, clearTimeout, clearInterval };
    this.autoUpdater = null;
    this.firstCheckTimer = null;
    this.intervalTimer = null;
    this.checking = false;
    this.state = {
      status: 'disabled',
      currentVersion: this.environment.currentVersion || null,
      version: null,
      percent: null,
      error: null,
      checkedAt: null
    };
  }

  getState() {
    return { ...this.state };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.getState());
  }

  start() {
    if (!isAutoUpdateSupported(this.environment)) {
      logger.info('[Updater] Atualizacao automatica desligada neste build/plataforma.');
      return false;
    }

    try {
      this.autoUpdater = this.loadAutoUpdater();
    } catch (error) {
      logger.warn('[Updater] Nao foi possivel carregar o atualizador:', error && error.message ? error.message : error);
      return false;
    }

    const updater = this.autoUpdater;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.logger = {
      info: (message) => logger.info(`[Updater] ${message}`),
      warn: (message) => logger.warn(`[Updater] ${message}`),
      error: (message) => logger.warn(`[Updater] ${message}`),
      debug: () => {}
    };

    updater.on('update-available', (info) => {
      logger.info(`[Updater] Versao ${info && info.version} disponivel; baixando em segundo plano.`);
      this.setState({ status: 'downloading', version: (info && info.version) || null, percent: 0, error: null });
    });
    updater.on('update-not-available', () => {
      if (this.state.status !== 'ready') this.setState({ status: 'idle', version: null, percent: null, error: null });
    });
    updater.on('download-progress', (progress) => {
      const percent = Math.round(Number(progress && progress.percent) || 0);
      if (percent !== this.state.percent) this.setState({ status: 'downloading', percent });
    });
    updater.on('update-downloaded', (info) => {
      logger.info(`[Updater] Versao ${info && info.version} baixada e pronta para instalar.`);
      this.setState({ status: 'ready', version: (info && info.version) || this.state.version, percent: 100, error: null });
    });
    updater.on('error', (error) => {
      const message = error && error.message ? error.message : String(error);
      logger.warn(`[Updater] Falha: ${message.split('\n')[0]}`);
      if (this.state.status === 'ready') return;
      this.setState({ status: 'idle', percent: null, error: message.split('\n')[0] });
    });

    this.setState({ status: 'idle' });
    this.firstCheckTimer = this.timers.setTimeout(() => { void this.checkNow(); }, FIRST_CHECK_DELAY_MS);
    this.intervalTimer = this.timers.setInterval(() => { void this.checkNow(); }, CHECK_INTERVAL_MS);
    logger.info('[Updater] Atualizacao automatica ativa (verifica a cada 6h).');
    return true;
  }

  stop() {
    if (this.firstCheckTimer) this.timers.clearTimeout(this.firstCheckTimer);
    if (this.intervalTimer) this.timers.clearInterval(this.intervalTimer);
    this.firstCheckTimer = null;
    this.intervalTimer = null;
  }

  async checkNow() {
    if (!this.autoUpdater) return this.getState();
    if (this.checking || ['downloading', 'ready', 'installing'].includes(this.state.status)) {
      return this.getState();
    }
    this.checking = true;
    try {
      await this.autoUpdater.checkForUpdates();
    } catch (error) {
      // O evento 'error' ja registra; aqui so evita rejeicao solta.
    } finally {
      this.checking = false;
      this.setState({ checkedAt: new Date().toISOString() });
    }
    return this.getState();
  }

  async waitUntilIdle(timeoutMs = IDLE_WAIT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (this.isBusy()) {
      if (Date.now() >= deadline) return false;
      await wait(IDLE_POLL_MS);
    }
    return true;
  }

  async installNow() {
    if (!this.autoUpdater || this.state.status !== 'ready') {
      return { success: false, error: 'Nenhuma atualização pronta para instalar.' };
    }
    this.setState({ status: 'installing' });
    const idle = await this.waitUntilIdle();
    if (!idle) {
      this.setState({ status: 'ready' });
      return { success: false, error: 'Há impressão em andamento. Tente de novo em alguns instantes.' };
    }
    logger.info(`[Updater] Instalando versao ${this.state.version} (pedido do usuario).`);
    // isSilent=true: sem telas do instalador; isForceRunAfter=true: reabre o Hub.
    this.autoUpdater.quitAndInstall(true, true);
    return { success: true };
  }
}

module.exports = {
  HubUpdater,
  isAutoUpdateSupported,
  FIRST_CHECK_DELAY_MS,
  CHECK_INTERVAL_MS
};
