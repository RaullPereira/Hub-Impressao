const logger = require('../utils/logger');
const winSpool = require('./win-spool');
const escposFormatter = require('./escpos-formatter');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const escpos = require('escpos');
const USB = require('escpos-usb');

class WindowsPrinterManager {
  constructor() {
    this.printers = [];
    this._discoveryTimer = null;
  }

  startAutoDiscovery(intervalMs = 10000) {
    logger.info('Iniciando descoberta automática de impressoras (Windows + USB)...');
    this.refreshPrinters();
    this._discoveryTimer = setInterval(() => this.refreshPrinters(), intervalMs);
  }

  stopAutoDiscovery() {
    if (this._discoveryTimer) {
      clearInterval(this._discoveryTimer);
      this._discoveryTimer = null;
    }
  }

  _generateId(name) {
    // REVERTED: Use name as ID to maintain compatibility with saved settings/external systems
    return name;
  }

  async refreshPrinters() {
    try {
      const allPrinters = [];

      // 1. Windows Spooler Printers
      try {
        const list = await winSpool.listPrinters();
        const def = await winSpool.getDefaultPrinter();

        list.forEach(name => {
          allPrinters.push({
            id: name, // ID is the name for Windows Spooler
            name: name,
            type: 'window',
            isDefault: name === def,
            status: 'ready',
            connection: 'system'
          });
        });
      } catch (err) {
        logger.error('Erro ao listar impressoras do Spooler:', err);
      }

      // 2. Raw USB Printers
      try {
        const usbDevices = USB.findPrinter();
        usbDevices.forEach((device, index) => {
          const desc = device.deviceDescriptor;
          const vendor = desc.idVendor.toString(16).padStart(4, '0');
          const product = desc.idProduct.toString(16).padStart(4, '0');

          // Use a special prefix for raw USB to avoid collision with installed printers
          // But keep it deterministic
          allPrinters.push({
            id: `usb-${vendor}-${product}-${index}`,
            name: `USB Device ${index} (${vendor}:${product})`,
            type: 'usb',
            isDefault: false,
            status: 'ready',
            connection: 'usb',
            usbIndex: index,
            vendorId: desc.idVendor,
            productId: desc.idProduct
          });
        });
      } catch (err) {
        logger.error('Erro ao listar impressoras USB:', err);
      }

      this.printers = allPrinters;
    } catch (err) {
      logger.error('Erro fatal no refreshPrinters:', err);
      this.printers = [];
    }
  }

  getPrinters() {
    this.refreshPrinters();
    return this.printers;
  }

  getPrinterById(id) {
    return this.printers.find(p => p.id === id);
  }

  // Unified print method matching Server.js signature
  async print(printerId, orderData, printType = 'counter', rawContent = null) {
    const printer = this.getPrinterById(printerId);
    if (!printer) throw new Error(`Impressora não encontrada (ID: ${printerId})`);

    logger.info(`[print] Iniciando impressão em: ${printer.name} (Tipo: ${printer.type})`);

    // Prepare buffer
    let buffer;
    if (rawContent) {
      if (Buffer.isBuffer(rawContent)) {
        buffer = rawContent;
      } else if (typeof rawContent === 'string') {
        try {
          buffer = Buffer.from(rawContent, 'base64');
        } catch (_) {
          buffer = Buffer.from(rawContent);
        }
      }
    } else if (orderData) {
      const commands = escposFormatter.generateOrderPrintData(orderData, printType);
      const commandString = Array.isArray(commands) ? commands.join('') : String(commands);
      buffer = Buffer.from(commandString, 'binary');
    } else {
      throw new Error('Nenhum dado fornecido para impressão');
    }

    if (printer.type === 'window' || printer.type === 'WINDOWS_SPOOLER') {
      return await this._printWindowsSpooler(printer.name, buffer);
    } else if (printer.type === 'usb') {
      return await this._printUsb(printer, buffer);
    } else {
      throw new Error(`Tipo de impressora não suportado: ${printer.type}`);
    }
  }

  async testPrint(printerId) {
    const printer = this.getPrinterById(printerId);
    if (!printer) throw new Error(`Impressora não encontrada para teste (ID: ${printerId})`);

    logger.info(`[testPrint] Enviando teste para: ${printer.name}`);

    const buffer = Buffer.concat([
      Buffer.from([0x1B, 0x40]), // Init
      Buffer.from([0x1B, 0x61, 0x01]), // Center
      Buffer.from('Hub Impressao (Windows)\n'),
      Buffer.from('--------------------------------\n'),
      Buffer.from([0x1B, 0x61, 0x00]), // Left
      Buffer.from('Teste de Comunicacao OK\n'),
      Buffer.from(`Printer: ${printer.name}\n`),
      Buffer.from(`Type: ${printer.type}\n`),
      Buffer.from(`ID: ${printerId}\n`),
      Buffer.from(`Data: ${new Date().toLocaleString()}\n`),
      Buffer.from('\n\n\n'),
      Buffer.from([0x1D, 0x56, 0x00]) // Cut
    ]);

    if (printer.type === 'window' || printer.type === 'WINDOWS_SPOOLER') {
      return await this._printWindowsSpooler(printer.name, buffer);
    } else if (printer.type === 'usb') {
      return await this._printUsb(printer, buffer);
    }
  }

  async _printWindowsSpooler(printerName, buffer) {
    try {
      await winSpool.printRaw(printerName, buffer);
      logger.info(`[printWindowsSpooler] RAW enviado com sucesso para ${printerName}`);
      return { success: true };
    } catch (err) {
      // Log full error for debugging
      logger.error('[printWindowsSpooler] Falha no printRaw:', err);

      logger.warn('[printWindowsSpooler] Tentando fallback para printFile...');
      try {
        const tmpFile = path.join(os.tmpdir(), `hub_print_${Date.now()}.bin`);
        fs.writeFileSync(tmpFile, buffer);
        await winSpool.printFile(printerName, tmpFile);
        try { fs.unlinkSync(tmpFile); } catch (_) { }
        logger.info('[printWindowsSpooler] Fallback arquivo enviado com sucesso');
        return { success: true };
      } catch (e) {
        logger.error('[printWindowsSpooler] Erro final no fallback:', e);
        throw e;
      }
    }
  }

  async _printUsb(printer, buffer) {
    return new Promise((resolve, reject) => {
      try {
        const usbDevices = USB.findPrinter();
        const device = usbDevices[printer.usbIndex];

        if (!device) {
          return reject(new Error('Dispositivo USB desconectado ou não encontrado no índice.'));
        }

        device.open((err) => {
          if (err) {
            return reject(new Error('Erro ao abrir porta USB: ' + err.message));
          }

          const printerObj = new escpos.Printer(device);
          printerObj.raw(buffer).close((err) => {
            if (err) return reject(err);
            logger.info('[printUsb] Enviado com sucesso via escpos-usb');
            resolve({ success: true });
          });
        });
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = WindowsPrinterManager;
