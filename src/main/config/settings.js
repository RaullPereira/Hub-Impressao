const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const logger = require('../utils/logger');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

class Settings {
  static getAll() {
    try {
      if (!fs.existsSync(SETTINGS_FILE)) {
        return {
          printers: {
            default: null,
            kitchen: null,
            counter: null,
            delivery: null
          },
          // printChannel: 'local' | 'qz' — controls whether to use local printing or forward to QZ Tray
          printChannel: 'local',
          // Optional QZ endpoint to forward print requests when printChannel === 'qz'
          qzEndpoint: null
        };
      }
      const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      logger.error('Erro ao ler configurações:', e);
      return { printers: {} };
    }
  }

  static save(newSettings) {
    try {
      const dir = path.dirname(SETTINGS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 2));
      logger.info('Configurações salvas');
      return true;
    } catch (e) {
      logger.error('Erro ao salvar configurações:', e);
      return false;
    }
  }

  static getPrinterForType(type) {
    const settings = this.getAll();
    return settings.printers?.[type] || settings.printers?.default || null;
  }

  static setPrinterForType(type, printerId) {
    const settings = this.getAll();
    if (!settings.printers) settings.printers = {};
    settings.printers[type] = printerId;
    return this.save(settings);
  }

  static getUsbMapping(usbId) {
    const settings = this.getAll();
    return settings.usbMappings?.[usbId] || null;
  }

  static setUsbMapping(usbId, windowsPrinterName) {
    const settings = this.getAll();
    if (!settings.usbMappings) settings.usbMappings = {};
    settings.usbMappings[usbId] = windowsPrinterName;
    return this.save(settings);
  }
}

module.exports = Settings;
