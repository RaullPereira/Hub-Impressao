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
    if (!this.tray) return;
    try {
      this.tray.setContextMenu(this.buildMenu());
    } catch (error) {
      logger.warn('Falha ao atualizar menu da bandeja', error && error.message ? error.message : error);
    }
  }

  notifyUpdateReady(version) {
    if (!this.tray || process.platform !== 'win32' || typeof this.tray.displayBalloon !== 'function') return;
    try {
      this.tray.displayBalloon({
        title: 'Atualização do Hub Impressão pronta',
        content: `A versão ${version || 'nova'} já foi baixada. Abra o Hub e clique em "Atualizar agora".`
      });
    } catch (error) {
      logger.warn('Falha ao mostrar aviso de atualização', error && error.message ? error.message : error);
    }
  }

  buildUpdateMenuItems() {
    const state = this.mainApp.updater && typeof this.mainApp.updater.getState === 'function'
      ? this.mainApp.updater.getState()
      : null;
    if (!state || state.status !== 'ready') return [];
    return [
      {
        label: `Atualizar agora para ${state.version || 'nova versão'}`,
        click: () => {
          void this.mainApp.installUpdate().then((result) => {
            if (!result || !result.success) {
              logger.warn(`Atualização pela bandeja não iniciada: ${result && result.error}`);
              this.mainApp.createConfigWindow();
            }
          });
        }
      },
      { type: 'separator' }
    ];
  }

  buildMenu() {
    // Verificar se auto-start está ativado
    const loginSettings = app.getLoginItemSettings();
    const autoStartEnabled = loginSettings.openAtLogin;
    
    return Menu.buildFromTemplate([
      ...this.buildUpdateMenuItems(),
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
