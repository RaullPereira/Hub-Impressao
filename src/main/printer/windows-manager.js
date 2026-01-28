const logger = require('../utils/logger');

let printer;
try {
  // `printer` is a native module; require only on Windows or if specifically built
  if (process.platform === 'win32') {
    printer = require('printer');
    // Verify it loaded correctly by checking for a method
    if (!printer.getPrinters) {
      throw new Error('Módulo printer carregado mas parece inválido (faltando getPrinters)');
    }
  }
} catch (e) {
  logger.warn('Dependência nativa `printer` não disponível ou falhou ao carregar:', e.message);
}

const escposFormatter = require('./escpos-formatter');

class WindowsPrinterManager {
  constructor() {
    this.printers = [];
    this._discoveryTimer = null;
  }

  startAutoDiscovery(intervalMs = 10000) {
    logger.info('Iniciando descoberta automática de impressoras (Windows Spooler)...');
    this.refreshPrinters();
    this._discoveryTimer = setInterval(() => this.refreshPrinters(), intervalMs);
  }

  stopAutoDiscovery() {
    if (this._discoveryTimer) {
      clearInterval(this._discoveryTimer);
      this._discoveryTimer = null;
    }
  }

  refreshPrinters() {
    try {
      if (!printer || !printer.getPrinters) {
        // Fallback or just empty if module missing
        this.printers = [];
        return;
      }

      const list = printer.getPrinters();
      // Map to our standard format
      // Windows `printer` module returns objects like { name: 'PrinterName', ... }
      this.printers = (list || []).map((p) => ({
        id: p.name,       // Use name as ID on Windows
        name: p.name,
        type: 'WINDOWS_SPOOLER', // Generic type since we go through spooler
        isDefault: p.isDefault || false,
        status: p.status, // might be available depending on OS version
        raw: p
      }));

      // Log only on change count to avoid spam
      // logger.debug(`${this.printers.length} impressora(s) detectadas no Windows`);
    } catch (err) {
      logger.error('Erro ao listar impressoras Windows (Spooler):', err);
      this.printers = [];
    }
  }

  getPrinters() {
    this.refreshPrinters();
    return this.printers;
  }

  /**
   * Sends a raw Buffer to the printer via Windows Spooler.
   * Works for USB, Network, and Bluetooth printers installed in Windows.
   */
  async testPrint(printerName) {
    try {
      logger.info(`[testPrint] Iniciando teste para: ${printerName}`);

      // Standard ESC/POS test receipt
      const data = Buffer.concat([
        Buffer.from([0x1B, 0x40]), // ESC @ (Initialize)
        Buffer.from([0x1B, 0x61, 0x01]), // Center align
        Buffer.from('Hub Impressao\n'),
        Buffer.from('--------------------------------\n'),
        Buffer.from([0x1B, 0x61, 0x00]), // Left align
        Buffer.from('Teste de Comunicacao OK\n'),
        Buffer.from('Plataforma: Windows (Spooler)\n'),
        Buffer.from(`Impressora: ${printerName}\n`),
        Buffer.from(`Data: ${new Date().toLocaleString()}\n`),
        Buffer.from('\n\n\n'),
        Buffer.from([0x1D, 0x56, 0x00]) // GS V 0 (Cut)
      ]);

      return await this._printBuffer(printerName, data);
    } catch (err) {
      logger.error(`[testPrint] Falha ao imprimir teste em ${printerName}:`, err);
      throw err;
    }
  }

  async print({ printer: printerName, rawContent, orderData }) {
    try {
      let buf;

      if (rawContent) {
        if (typeof rawContent === 'string') {
          // If it's a base64 string, decode it
          buf = Buffer.from(rawContent, 'base64');
        } else if (Buffer.isBuffer(rawContent)) {
          buf = rawContent;
        } else {
          // Last resort: string data
          buf = Buffer.from(String(rawContent));
        }
      } else if (orderData) {
        // Use the formatter to generate ESC/POS commands
        const commands = escposFormatter.generateOrderPrintData(orderData);
        buf = Buffer.from(commands);
      } else {
        throw new Error('Nenhum conteúdo para imprimir fornecido (rawContent ou orderData ausentes)');
      }

      logger.info(`[print] Enviando ${buf.length} bytes para ${printerName}`);
      return await this._printBuffer(printerName, buf);
    } catch (err) {
      logger.error(`[print] Erro ao imprimir em ${printerName}:`, err);
      throw err;
    }
  }

  _printBuffer(printerName, buffer) {
    return new Promise((resolve, reject) => {
      if (!printer || !printer.printDirect) {
        const msg = 'Módulo `printer` nativo não está disponível. Verifique se o app foi compilado corretamente para Windows.';
        logger.error('[print] ' + msg);
        return reject(new Error(msg));
      }

      printer.printDirect({
        data: buffer,
        printer: printerName,
        type: 'RAW', // Important for sending raw ESC/POS commands
        success: function (jobID) {
          logger.info(`[print] Sucesso! Job ID: ${jobID} enviado para spooler.`);
          resolve({ success: true, jobID });
        },
        error: function (err) {
          logger.error(`[print] Erro retornado pelo Spooler para ${printerName}:`, err);
          reject(err);
        }
      });
    });
  }
}

module.exports = WindowsPrinterManager;
