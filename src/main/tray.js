// src/main/tray.js
const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');
const fs = require('fs');
const logger = require('./utils/logger');

class TrayManager {
  constructor(mainApp) {
    this.mainApp = mainApp;
    this.tray = null;
    this.createTray();
  }

  loadIcon(iconPath) {
    const ext = path.extname(iconPath).toLowerCase();
    if (ext === '.svg') {
      try {
        return nativeImage.createFromBuffer(fs.readFileSync(iconPath));
      } catch (error) {
        logger.warn('Tray SVG icon load failed', error && error.message ? error.message : error);
      }
    }

    let icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty() && fs.existsSync(iconPath)) {
      try {
        icon = nativeImage.createFromBuffer(fs.readFileSync(iconPath));
      } catch (error) {
        logger.warn('Tray icon createFromBuffer failed', error && error.message ? error.message : error);
      }
    }

    return icon;
  }

  createTray() {
    // Select platform-appropriate icon paths.
    const candidates = [];
    const basePath = app.isPackaged ? path.join(process.resourcesPath, 'assets', 'icons') : path.join(__dirname, '../../assets/icons');

    if (process.platform === 'darwin') {
      // Prefer a monochrome PNG template for the menu bar
      candidates.push(path.join(basePath, 'trayTemplate.png'));
      candidates.push(path.join(basePath, 'trayTemplate@2x.png'));
      candidates.push(path.join(basePath, 'app.icns'));
      candidates.push(path.join(basePath, 'printer-svgrepo-com.svg'));
    } else if (process.platform === 'win32') {
      candidates.push(path.join(basePath, 'app.png'));
      candidates.push(path.join(basePath, 'tray.png'));
      candidates.push(path.join(basePath, 'app.ico'));
      candidates.push(path.join(basePath, 'tray-win.svg'));
      candidates.push(path.join(basePath, 'printer-svgrepo-com.svg'));
    } else {
      // linux / others
      candidates.push(path.join(basePath, 'tray.png'));
      candidates.push(path.join(basePath, 'printer-svgrepo-com.svg'));
    }

    let iconPath = candidates.find(p => fs.existsSync(p));
    if (!iconPath) {
      // last resort: try the original svg in repo
      iconPath = path.join(__dirname, '../../assets/icons/printer-svgrepo-com.svg');
    }

    let trayIcon = this.loadIcon(iconPath);

    if (trayIcon.isEmpty()) {
      logger.warn('Tray icon is empty for path: ' + String(iconPath));
    }

    // Resize tray icon; on Windows prefer PNG sources for better compatibility with older shells.
    if (process.platform === 'darwin') {
      try {
        trayIcon = trayIcon.resize({ width: 22, height: 22 });
        trayIcon.setTemplateImage(false);
      } catch (e) {
        logger.warn('Failed to resize tray icon', e && e.message ? e.message : e);
      }
    } else if (process.platform === 'win32') {
      try {
        trayIcon = trayIcon.resize({ width: 20, height: 20 });
      } catch (e) {
        logger.warn('Failed to resize tray icon', e && e.message ? e.message : e);
      }
    } else {
      try {
        trayIcon = trayIcon.resize({ width: 24, height: 24 });
      } catch (e) {
        logger.warn('Failed to resize tray icon', e && e.message ? e.message : e);
      }
    }

    this.tray = new Tray(trayIcon);
    this.tray.setToolTip('Hub Impressao');
    this.tray.setContextMenu(this.buildMenu());

    logger.info(`Tray created using icon: ${iconPath} (isPackaged=${app.isPackaged})`);

    this.tray.on('click', () => {
      logger.info('Tray clicked - showing main window');
      this.mainApp.createConfigWindow();
    });
  }

  refreshMenu() {
    if (this.tray) this.tray.setContextMenu(this.buildMenu());
  }

  buildMenu() {
    // Verificar se auto-start está ativado
    const loginSettings = app.getLoginItemSettings();
    const autoStartEnabled = loginSettings.openAtLogin;
    const updateStatus = this.mainApp.getUpdateStatus ? this.mainApp.getUpdateStatus() : { state: 'idle' };
    const updateReady = updateStatus.state === 'ready';
    
    return Menu.buildFromTemplate([
      {
        label: 'Abrir Painel',
        click: () => this.mainApp.createConfigWindow()
      },
      { type: 'separator' },
      {
        label: 'Iniciar com o Sistema',
        type: 'checkbox',
        checked: autoStartEnabled,
        click: (menuItem) => {
          const enable = menuItem.checked;
          logger.info(`Auto-start ${enable ? 'habilitado' : 'desabilitado'}`);
          
          if (process.platform === 'darwin') {
            app.setLoginItemSettings({
              openAtLogin: enable,
              openAsHidden: true,
              args: ['--hidden']
            });
          } else {
            app.setLoginItemSettings({
              openAtLogin: enable,
              args: ['--hidden']
            });
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Reiniciar Serviço',
        click: () => app.relaunch() && app.exit(0)
      },
      ...(updateReady ? [{
        label: 'Reiniciar e atualizar agora',
        click: () => this.mainApp.installUpdateNow()
      }] : []),
      {
        label: 'Sair',
        click: () => {
          logger.info('Tray menu -> Sair clicked, quitting app (attempt)');
          try {
            app.isQuiting = true;
            app.quit();
            // fallback: force exit after short delay if quit doesn't terminate
            setTimeout(() => {
              logger.info('Force exiting app after timeout');
              try { app.exit(0); } catch (e) { logger.error('Force exit failed', e); }
            }, 2000);
          } catch (e) {
            logger.error('Error while quitting app from tray', e);
            try { app.exit(1); } catch (ee) { /* ignore */ }
          }
        }
      }
    ]);
  }
}

module.exports = TrayManager;
