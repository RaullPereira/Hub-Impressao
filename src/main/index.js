const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const TrayManager = require('./tray');
const Server = require('./server');
let PrinterManager;
if (process.platform === 'win32') {
  PrinterManager = require('./printer/windows-manager');
} else {
  PrinterManager = require('./printer/cups-manager');
}
const SecureWebSocketServer = require('./websocket/secure-server');
const logger = require('./utils/logger');

class ThermalPrintApp {
  constructor() {
    this.mainWindow = null;
    this.tray = null;
    this.server = null;
    this.printerManager = null;
    this.wss = null;
  }

  async initialize() {
    try {
      logger.info('Inicializando aplicação (initialize)');
      this.printerManager = new PrinterManager();
      this.printerManager.startAutoDiscovery(10000);
      logger.info('Descoberta automática de impressoras iniciada');

      this.server = new Server(this.printerManager);
      this.server.start();

      // Iniciar servidor WebSocket seguro
      this.wss = SecureWebSocketServer;
      this.wss.start(3002, this.printerManager);
      logger.info(`Token WebSocket: ${this.wss.getToken()}`);

      this.tray = new TrayManager(this);
      logger.info('TrayManager criado');
      logger.info('Aplicação iniciada com sucesso');
    } catch (error) {
      logger.error('Erro ao inicializar:', error);
      app.quit();
    }
  }

  createConfigWindow() {
    if (this.mainWindow) {
      this.mainWindow.show();
      this.mainWindow.focus();
      return;
    }
    this.mainWindow = new BrowserWindow({
      width: 900,
      height: 700,
      webPreferences: {
        preload: path.join(__dirname, '../preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      },
      // show window on startup
      show: true
    });
    this.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    // Show the window when it's ready to avoid white/blank flashes
    this.mainWindow.once('ready-to-show', () => {
      if (this.mainWindow) this.mainWindow.show();
      logger.info('Main window ready-to-show -> show() called');
    });

    // When user attempts to close window, hide to tray instead of quitting
    this.mainWindow.on('close', (e) => {
      if (!app.isQuiting) {
        e.preventDefault();
        this.mainWindow.hide();
        logger.info('Main window close intercepted -> hide() called');
      }
    });

    // Hide on minimize to tray
    this.mainWindow.on('minimize', (e) => {
      e.preventDefault();
      this.mainWindow.hide();
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
      logger.info('Main window closed (closed event)');
    });
  }
}

const thermalApp = new ThermalPrintApp();
// default flag for close-to-tray behavior
app.isQuiting = false;

app.whenReady().then(() => {
  thermalApp.initialize();
  thermalApp.createConfigWindow();
});

// Create a proper application menu for macOS to include Quit
app.whenReady().then(() => {
  try {
    const template = [
      {
        label: app.name || 'Hub Impressao',
        submenu: [
          {
            label: `Quit ${app.name || 'Hub Impressao'}`,
            accelerator: 'CmdOrCtrl+Q',
            click: () => {
              logger.info('Application menu -> Quit clicked');
              app.isQuiting = true;
              app.quit();
            }
          }
        ]
      }
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
    logger.info('Application menu set');
  } catch (e) {
    logger.error('Failed to set application menu', e);
  }
});

app.on('window-all-closed', () => { });

app.on('before-quit', () => {
  logger.info('app.before-quit event fired');
});

app.on('will-quit', () => {
  logger.info('app.will-quit event fired');
});

app.on('activate', () => {
  logger.info('app.activate event fired');
  if (!thermalApp.mainWindow) thermalApp.createConfigWindow();
});

ipcMain.handle('get-printers', async () => {
  return thermalApp.printerManager.getPrinters();
});

ipcMain.handle('test-printer', async (event, printerId) => {
  return thermalApp.printerManager.testPrint(printerId);
});

ipcMain.handle('get-wss-token', async () => {
  return thermalApp.wss.getToken();
});
