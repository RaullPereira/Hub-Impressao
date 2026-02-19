const { app, BrowserWindow, ipcMain, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const TrayManager = require('./tray');
const Server = require('./server');
let PrinterManager;
if (process.platform === 'win32') {
  PrinterManager = require('./printer/windows-manager');
} else {
  // On non-windows, use hybrid manager which handles USB/CUPS
  PrinterManager = require('./printer/hybrid-manager');
}
const SecureWebSocketServer = require('./websocket/secure-server');
const logger = require('./utils/logger');

// Verificar se foi iniciado com --hidden (auto-start)
const startHidden = process.argv.includes('--hidden');

function getAppIconPath() {
  const base = path.join(__dirname, '../../assets/icons');
  const trayPng = path.join(base, 'trayTemplate.png');
  if (fs.existsSync(trayPng)) return trayPng;
  if (process.platform === 'win32') {
    const ico = path.join(base, 'app.ico');
    if (fs.existsSync(ico)) return ico;
  }
  const png = path.join(base, 'app.png');
  if (fs.existsSync(png)) return png;
  return null;
}

// Configurar auto-start no login (cross-platform)
function setupAutoStart() {
  try {
    const appPath = process.execPath;
    const appName = 'Hub Impressao';
    
    if (process.platform === 'darwin') {
      // macOS: usar Login Items (via apple script ou plist)
      app.setLoginItemSettings({
        openAtLogin: true,
        openAsHidden: true,
        path: appPath,
        args: ['--hidden']
      });
    } else if (process.platform === 'win32') {
      // Windows: configurado via NSIS no instalador
      app.setLoginItemSettings({
        openAtLogin: true,
        openAsHidden: true,
        args: ['--hidden']
      });
    }
    logger.info('Auto-start configurado com sucesso');
  } catch (e) {
    logger.warn('Falha ao configurar auto-start:', e.message);
  }
}

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
      // Intervalo de 30 segundos para melhor performance (era 10000ms)
      this.printerManager.startAutoDiscovery(30000);
      logger.info('Descoberta automática de impressoras iniciada (intervalo: 30s)');

      this.server = new Server(this.printerManager);
      this.server.start();

      // Iniciar servidor WebSocket seguro e injetar PrinterManager
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
    const iconPath = getAppIconPath();
    this.mainWindow = new BrowserWindow({
      width: 900,
      height: 700,
      icon: iconPath,
      webPreferences: {
        preload: path.join(__dirname, '../../preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      },
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

// Otimização: desabilitar aceleração de hardware se não necessário
app.disableHardwareAcceleration();

app.whenReady().then(() => {
  thermalApp.initialize();

  // Ícone no dock (macOS) — evita logo do Electron/React
  const iconPath = getAppIconPath();
  if (iconPath && process.platform === 'darwin' && app.dock) {
    try {
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    } catch (e) {
      logger.warn('Falha ao definir ícone do dock:', e.message);
    }
  }

  // Configurar auto-start
  setupAutoStart();

  // Se iniciado com --hidden, não mostrar a janela
  if (!startHidden) {
    thermalApp.createConfigWindow();
  } else {
    logger.info('Iniciado em modo oculto (--hidden)');
  }
});

// Menu da aplicação (macOS: atalhos Cmd+C, Cmd+V, etc. funcionam com submenu Edit)
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
  } catch (e) {
    logger.error('Failed to set application menu', e);
  }
});

app.on('window-all-closed', () => {});

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
