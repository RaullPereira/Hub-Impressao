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

  createTray() {
    // Resolve o caminho do ícone dependendo se o app está empacotado.
    let iconPath;
    if (app.isPackaged) {
      const icnsPath = path.join(process.resourcesPath, 'assets', 'icons', 'app.icns');
      const icoPath = path.join(process.resourcesPath, 'assets', 'icons', 'app.ico');
      const svgPath = path.join(process.resourcesPath, 'assets', 'icons', 'printer-svgrepo-com.svg');
      if (fs.existsSync(icnsPath)) iconPath = icnsPath; // Prefer .icns on Mac if available
      else if (fs.existsSync(svgPath)) iconPath = svgPath;
      else if (fs.existsSync(icoPath)) iconPath = icoPath;
      else iconPath = svgPath;
    } else {
      iconPath = path.join(__dirname, '../../assets/icons/printer-svgrepo-com.svg');
    }

    let trayIcon = nativeImage.createFromPath(iconPath);

    // Resize for macOS menu bar (standard is usually 16x16 or 22x22)
    // If it's too big, it might not show or look weird
    if (process.platform === 'darwin') {
      trayIcon = trayIcon.resize({ width: 22, height: 22 });
      trayIcon.setTemplateImage(true); // Allows macOS to color it white/black automatically
    } else {
      trayIcon = trayIcon.resize({ width: 32, height: 32 });
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

  buildMenu() {
    return Menu.buildFromTemplate([
      {
        label: 'Abrir Painel',
        click: () => this.mainApp.createConfigWindow()
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
