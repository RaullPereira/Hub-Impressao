const logger = require('../utils/logger');
const winSpool = require('./win-spool');
const escposFormatter = require('./escpos-formatter');
const os = require('os');
const path = require('path');
const fs = require('fs');

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

  async refreshPrinters() {
    try {
      const list = await winSpool.listPrinters();
      this.printers = (list || []).map((name) => ({
        id: name,
        name,
        type: 'WINDOWS_SPOOLER',
        isDefault: false,
        status: 'ready'
      }));
      const def = await winSpool.getDefaultPrinter();
      if (def) {
        const p = this.printers.find(p => p.name === def);
        if (p) p.isDefault = true;
      }
    } catch (err) {
      logger.error('Erro ao listar impressoras via win-spool:', err);
      this.printers = [];
    }
  }

  getPrinters() {
    // return latest (async not required by caller so refresh synchronously in background)
    this.refreshPrinters();
    return this.printers;
  }

  async testPrint(printerName) {
    try {
      logger.info(`[testPrint] Iniciando teste para: ${printerName}`);
      const data = Buffer.concat([
        Buffer.from([0x1B, 0x40]),
        Buffer.from([0x1B, 0x61, 0x01]),
        Buffer.from('Hub Impressao\n'),
        Buffer.from('--------------------------------\n'),
        Buffer.from([0x1B, 0x61, 0x00]),
        Buffer.from('Teste de Comunicacao OK\n'),
        Buffer.from(`Impressora: ${printerName}\n`),
        Buffer.from(`Data: ${new Date().toLocaleString()}\n`),
        Buffer.from('\n\n\n'),
        Buffer.from([0x1D, 0x56, 0x00])
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
          try {
            buf = Buffer.from(rawContent, 'base64');
          } catch (_) {
            buf = Buffer.from(String(rawContent));
          }
        } else if (Buffer.isBuffer(rawContent)) {
          buf = rawContent;
        } else {
          buf = Buffer.from(String(rawContent));
        }
      } else if (orderData) {
        const commands = escposFormatter.generateOrderPrintData(orderData);
        const commandString = Array.isArray(commands) ? commands.join('') : String(commands);
        buf = Buffer.from(commandString, 'binary');
      } else {
        throw new Error('Nenhum conteúdo para imprimir fornecido');
      }
      return await this._printBuffer(printerName, buf);
    } catch (err) {
      logger.error('[print] Erro ao imprimir via win-spool:', err);
      throw err;
    }
  }

  async _printBuffer(printerName, buffer) {
    // Preferir enviar RAW via winSpool.printRaw (usa WinAPI via PowerShell)
    try {
      await winSpool.printRaw(printerName, buffer);
      logger.info(`[print] Impressão RAW via win-spool enviada para ${printerName}`);
      return { success: true };
    } catch (err) {
      logger.warn('[print] printRaw falhou, tentando printFile fallback:', err.message || err);
      // fallback: write temp file and call printFile
      try {
        const tmpFile = path.join(os.tmpdir(), `hubimpressao_print_${Date.now()}.bin`);
        fs.writeFileSync(tmpFile, buffer);
        await winSpool.printFile(printerName, tmpFile);
        try { fs.unlinkSync(tmpFile); } catch (e) {}
        logger.info('[print] Impressão via printFile enviada com sucesso');
        return { success: true };
      } catch (e) {
        logger.error('[print] Falha no fallback printFile:', e);
        throw e;
      }
    }
  }
}

module.exports = WindowsPrinterManager;
