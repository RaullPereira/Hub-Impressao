const { app, BrowserWindow, ipcMain, Menu, nativeImage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const TrayManager = require('./tray');
const Server = require('./server');
let PrinterManager;
if (process.platform === 'win32') {
  PrinterManager = require('./printer/windows-manager');
} else {
  PrinterManager = require('./printer/hybrid-manager');
}
const SecureWebSocketServer = require('./websocket/secure-server');
const Settings = require('./config/settings');
const logger = require('./utils/logger');
const MultiPairedPrintListener = require('./supabase/multi-paired-print-listener');

const startHidden = process.argv.includes('--hidden');
const localHttpPort = getEnvPort('HUB_HTTP_PORT', 3001);
const localWebSocketPort = getEnvPort('HUB_WS_PORT', 3002);
const pairingDisabled = isEnvEnabled('HUB_DISABLE_PAIRING');

function getEnvPort(name, fallback) {
  const port = Number(process.env[name]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

function isEnvEnabled(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function getAppIconPath() {
  const base = path.join(__dirname, '../../assets/icons');
  if (process.platform === 'win32') {
    const ico = path.join(base, 'app.ico');
    if (fs.existsSync(ico)) return ico;
  }
  const trayPng = path.join(base, 'trayTemplate.png');
  if (fs.existsSync(trayPng)) return trayPng;
  const png = path.join(base, 'app.png');
  if (fs.existsSync(png)) return png;
  return null;
}

function setupAutoStart() {
  try {
    const appPath = process.execPath;

    if (process.platform === 'darwin') {
      app.setLoginItemSettings({
        openAtLogin: true,
        openAsHidden: true,
        path: appPath,
        args: ['--hidden']
      });
    } else if (process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: true,
        openAsHidden: true,
        args: ['--hidden']
      });
    }

    logger.info('Auto-start configurado com sucesso');
  } catch (error) {
    logger.warn('Falha ao configurar auto-start:', error.message);
  }
}

class ThermalPrintApp {
  constructor() {
    this.mainWindow = null;
    this.tray = null;
    this.server = null;
    this.printerManager = null;
    this.wss = null;
    this.pairedPrintListener = null;
    this.hasShutdown = false;
    this.lastResumeRecoveryAt = 0;
    this.serviceWatchdogTimer = null;
    this.startupIssues = [];
  }

  async initialize() {
    this.startupIssues = [];
    logger.info('Inicializando aplicação (initialize)');

    try {
      this.printerManager = new PrinterManager();
      this.printerManager.startAutoDiscovery(30000);
      logger.info('Descoberta automática de impressoras iniciada (intervalo: 30s)');
    } catch (error) {
      logger.error('Erro ao inicializar gerenciador de impressoras:', error);
      this.startupIssues.push(`Gerenciador de impressoras: ${error.message}`);
    }

    if (pairingDisabled) {
      logger.info('Listener de impressão pareada desabilitado para esta variante');
    } else {
      try {
        this.pairedPrintListener = new MultiPairedPrintListener(this.printerManager);
        await this.pairedPrintListener.startFromSettings();
        logger.info('Listener de impressão pareada inicializado');
      } catch (error) {
        logger.error('Erro ao inicializar listener de impressão pareada:', error);
        this.startupIssues.push(`Listener pareado: ${error.message}`);
      }
    }

    try {
      this.server = new Server(this.printerManager, this.pairedPrintListener, { port: localHttpPort });
      await this.server.start();
    } catch (error) {
      logger.error('Erro ao iniciar servidor HTTP local:', error);
      this.server = null;
      this.startupIssues.push(`Servidor HTTP local: ${error.message}`);
    }

    try {
      this.wss = SecureWebSocketServer;
      await this.wss.start(localWebSocketPort, this.printerManager, this.pairedPrintListener);
      logger.info(`Token WebSocket: ${this.wss.getToken()}`);
    } catch (error) {
      logger.error('Erro ao iniciar servidor WebSocket local:', error);
      try {
        if (this.wss && typeof this.wss.stop === 'function') {
          this.wss.stop();
        }
      } catch (stopError) {
        logger.warn('Falha ao limpar WebSocket após erro de inicialização:', stopError && stopError.message ? stopError.message : stopError);
      }
      this.wss = null;
      this.startupIssues.push(`Servidor WebSocket local: ${error.message}`);
    }

    try {
      this.tray = new TrayManager(this);
      logger.info('TrayManager criado');
    } catch (error) {
      logger.error('Erro ao inicializar tray:', error);
      this.startupIssues.push(`Tray do sistema: ${error.message}`);
    }

    if (this.printerManager) {
      this.startServiceWatchdog();
    }

    if (this.startupIssues.length === 0) {
      logger.info('Aplicação iniciada com sucesso');
    } else {
      logger.warn(`Aplicação iniciada com pendências: ${this.startupIssues.join(' | ')}`);
    }

    return {
      success: this.startupIssues.length === 0,
      issues: [...this.startupIssues]
    };
  }

  createConfigWindow() {
    if (this.mainWindow) {
      this.mainWindow.show();
      this.mainWindow.focus();
      return;
    }

    const iconPath = getAppIconPath();
    this.mainWindow = new BrowserWindow({
      width: 900,
      height: 700,
      icon: iconPath,
      webPreferences: {
        preload: path.join(__dirname, '../preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      },
      show: false
    });

    this.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    this.mainWindow.once('ready-to-show', () => {
      if (this.mainWindow) this.mainWindow.show();
      logger.info('Main window ready-to-show -> show() called');
    });

    this.mainWindow.on('close', (event) => {
      if (!app.isQuiting) {
        event.preventDefault();
        this.mainWindow.hide();
        logger.info('Main window close intercepted -> hide() called');
      }
    });

    this.mainWindow.on('minimize', (event) => {
      event.preventDefault();
      this.mainWindow.hide();
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
      logger.info('Main window closed (closed event)');
    });
  }

  async shutdown() {
    if (this.hasShutdown) return;
    this.hasShutdown = true;

    if (this.serviceWatchdogTimer) {
      clearInterval(this.serviceWatchdogTimer);
      this.serviceWatchdogTimer = null;
    }

    try {
      if (this.pairedPrintListener) {
        await this.pairedPrintListener.stop();
      }
    } catch (error) {
      logger.error('Erro ao parar listener pareado:', error);
    }

    try {
      if (this.wss) {
        this.wss.stop();
      }
    } catch (error) {
      logger.error('Erro ao parar WebSocket seguro:', error);
    }

    try {
      if (this.server) {
        this.server.stop();
      }
    } catch (error) {
      logger.error('Erro ao parar servidor HTTP:', error);
    }

    try {
      if (this.printerManager && typeof this.printerManager.stopAutoDiscovery === 'function') {
        this.printerManager.stopAutoDiscovery();
      }
    } catch (error) {
      logger.error('Erro ao parar auto-discovery:', error);
    }
  }

  async handleSystemResume(source = 'resume') {
    const now = Date.now();
    if ((now - this.lastResumeRecoveryAt) < 5000) {
      return;
    }

    this.lastResumeRecoveryAt = now;
    logger.info(`Recuperação pós-${source} iniciada`);

    try {
      if (this.printerManager && typeof this.printerManager.refreshPrinters === 'function') {
        await this.printerManager.refreshPrinters();
      }
    } catch (error) {
      logger.warn(`Falha ao atualizar impressoras após ${source}:`, error && error.message ? error.message : error);
    }

    try {
      if (this.pairedPrintListener && typeof this.pairedPrintListener.recoverAllNow === 'function') {
        await this.pairedPrintListener.recoverAllNow(source);
      }
    } catch (error) {
      logger.error(`Falha ao recuperar listeners pareados após ${source}:`, error);
    }
  }

  startServiceWatchdog() {
    if (this.serviceWatchdogTimer) {
      clearInterval(this.serviceWatchdogTimer);
    }

    this.serviceWatchdogTimer = setInterval(() => {
      if (this.hasShutdown) return;

      void (async () => {
        try {
          if (this.printerManager && typeof this.printerManager.refreshPrinters === 'function') {
            await this.printerManager.refreshPrinters();
          }

          if (this.pairedPrintListener && typeof this.pairedPrintListener.recoverAllNow === 'function') {
            await this.pairedPrintListener.recoverAllNow('service-watchdog');
          }
        } catch (error) {
          logger.warn('Service watchdog detectou falha:', error && error.message ? error.message : error);
        }
      })();
    }, 60000);
  }
}

const thermalApp = new ThermalPrintApp();
app.isQuiting = false;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.isQuiting = true;
  app.quit();
}

app.disableHardwareAcceleration();

app.on('second-instance', () => {
  logger.info('Segunda instância detectada; trazendo janela existente para frente');
  thermalApp.createConfigWindow();
});

app.whenReady().then(async () => {
  const startupResult = await thermalApp.initialize();

  const iconPath = getAppIconPath();
  if (iconPath && process.platform === 'darwin' && app.dock) {
    try {
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    } catch (error) {
      logger.warn('Falha ao definir ícone do dock:', error.message);
    }
  }

  setupAutoStart();

  if (!startHidden || startupResult.success === false) {
    thermalApp.createConfigWindow();
  } else {
    logger.info('Iniciado em modo oculto (--hidden)');
  }

  powerMonitor.on('suspend', () => {
    logger.info('Sistema entrou em suspensão');
  });

  powerMonitor.on('resume', () => {
    void thermalApp.handleSystemResume('resume');
  });

  powerMonitor.on('unlock-screen', () => {
    void thermalApp.handleSystemResume('unlock-screen');
  });

  powerMonitor.on('user-did-become-active', () => {
    void thermalApp.handleSystemResume('user-did-become-active');
  });
});

app.whenReady().then(() => {
  try {
    const appName = app.name || 'Hub Impressao';
    const template = [
      {
        label: appName,
        submenu: [
          { role: 'about', label: `Sobre ${appName}` },
          { type: 'separator' },
          { role: 'services', label: 'Serviços' },
          { type: 'separator' },
          { role: 'hide', label: `Ocultar ${appName}` },
          { role: 'hideOthers', label: 'Ocultar Outros' },
          { role: 'unhide', label: 'Mostrar Todos' },
          { type: 'separator' },
          {
            label: `Sair de ${appName}`,
            accelerator: 'CmdOrCtrl+Q',
            click: () => {
              app.isQuiting = true;
              app.quit();
            }
          }
        ]
      },
      {
        label: 'Editar',
        submenu: [
          { role: 'undo', label: 'Desfazer' },
          { role: 'redo', label: 'Refazer' },
          { type: 'separator' },
          { role: 'cut', label: 'Recortar' },
          { role: 'copy', label: 'Copiar' },
          { role: 'paste', label: 'Colar' },
          { role: 'selectAll', label: 'Selecionar Tudo' }
        ]
      },
      {
        label: 'Janela',
        submenu: [
          { role: 'minimize', label: 'Minimizar' },
          { role: 'zoom', label: 'Aumentar' },
          { type: 'separator' },
          { role: 'front', label: 'Trazer Tudo para a Frente' }
        ]
      }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
    logger.info('Application menu set');
  } catch (error) {
    logger.error('Failed to set application menu', error);
  }
});

app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  logger.info('app.before-quit event fired');
  thermalApp.shutdown();
});

app.on('will-quit', () => {
  logger.info('app.will-quit event fired');
  thermalApp.shutdown();
});

app.on('activate', () => {
  logger.info('app.activate event fired');
  if (!thermalApp.mainWindow) thermalApp.createConfigWindow();
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection no processo principal:', reason);
  if (!thermalApp.hasShutdown) {
    void thermalApp.handleSystemResume('unhandled-rejection');
  }
});

process.on('uncaughtException', (error) => {
  logger.error('uncaughtException no processo principal:', error);
  if (!thermalApp.hasShutdown) {
    void thermalApp.handleSystemResume('uncaught-exception');
  }
});

ipcMain.handle('get-printers', async () => {
  if (!thermalApp.printerManager) return [];

  const isWindows = process.platform === 'win32';

  if (typeof thermalApp.printerManager.refreshPrinters === 'function') {
    try {
      await Promise.race([
        thermalApp.printerManager.refreshPrinters(isWindows),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Timeout ao atualizar impressoras')), 8000);
        })
      ]);
    } catch (error) {
      logger.warn('Falha ao atualizar impressoras via IPC:', error && error.message ? error.message : error);
    }
  }

  const discovered = thermalApp.printerManager.getPrinters() || [];
  const discoveredNames = new Set(discovered.map((printer) => String(printer.name || printer.id || '').trim().toLowerCase()));
  const manual = (Settings.getManualPrinters() || []).map((name) => ({
    id: name,
    name,
    type: 'manual',
    isDefault: false,
    status: 'ready'
  })).filter((printer) => !isWindows || discoveredNames.has(String(printer.name || '').trim().toLowerCase()));

  const seen = new Set();
  return [...discovered, ...manual].filter((printer) => {
    const key = String(printer.id || printer.name || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});

ipcMain.handle('test-printer', async (event, printerId) => {
  if (!thermalApp.printerManager) throw new Error('Serviço de impressoras ainda não iniciou');
  return thermalApp.printerManager.testPrint(printerId);
});

ipcMain.handle('get-logs', async (event, options = {}) => {
  const type = ['app', 'error', 'print'].includes(options?.type)
    ? options.type
    : 'print';
  const limit = Math.min(Math.max(Number(options?.limit || 200), 1), 1000);

  return {
    success: true,
    type,
    entries: logger.getRecentLogs({ type, limit }),
    files: {
      app: logger.getLogFilePath('app'),
      error: logger.getLogFilePath('error'),
      print: logger.getLogFilePath('print')
    }
  };
});

ipcMain.handle('get-pairing-status', async () => {
  if (!thermalApp.pairedPrintListener || typeof thermalApp.pairedPrintListener.getStatus !== 'function') {
    return {
      paired: false,
      active: false,
      controlsAutoPrint: false,
      status: 'unavailable',
      adminClientId: null,
      storeName: null,
      lastSeenAt: null,
      autoPrintEnabled: false,
      autoPrintType: 'counter',
      autoPrintOnAcceptEnabled: false,
      kdsReadyPrintEnabled: false,
      kdsReadyPrintRoutes: [],
      lastError: 'Listener de pareamento indisponível'
    };
  }

  return thermalApp.pairedPrintListener.getStatus();
});

ipcMain.handle('get-settings', async () => {
  const settings = Settings.getAll();
  const pairings = Object.values(settings.pairings || {}).map((pairing) => ({
    enabled: pairing.enabled !== false,
    adminClientId: pairing.adminClientId || null,
    appBaseUrl: pairing.appBaseUrl || null,
    storeName: pairing.storeName || null,
    userEmail: pairing.userEmail || null,
    pairedAt: pairing.pairedAt || null,
    lastSeenAt: pairing.lastSeenAt || null
  }));

  return {
    printers: settings.printers || {},
    storePrinters: settings.storePrinters || {},
    printChannel: settings.printChannel || 'local',
    pairings
  };
});

ipcMain.handle('manual-print', async (event, payload = {}) => {
  if (!thermalApp.printerManager) throw new Error('Serviço de impressoras ainda não iniciou');

  const printerId = typeof payload?.printerId === 'string' ? payload.printerId.trim() : '';
  const text = typeof payload?.text === 'string' ? payload.text : '';

  if (!printerId) {
    throw new Error('Impressora não informada');
  }

  if (!text.trim()) {
    throw new Error('Texto vazio para impressão');
  }

  await thermalApp.printerManager.print({
    printer: printerId,
    orderData: { text },
    printType: 'text',
    printSettings: {
      paperWidth: 32,
      lineSpacing: 'compact',
      feedLines: 2
    }
  });

  return { success: true };
});

ipcMain.handle('add-manual-printer', async (event, payload = {}) => {
  const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
  if (!name) {
    throw new Error('Nome da impressora é obrigatório');
  }

  Settings.addManualPrinter(name);
  return { success: true };
});

ipcMain.handle('get-wss-token', async () => thermalApp.wss.getToken());
