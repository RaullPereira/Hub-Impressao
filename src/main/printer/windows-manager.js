const logger = require('../utils/logger');
const winSpool = require('./win-spool');
const pedidosHubFormatter = require('./pedidoshub-formatter');
const { formatManualTextPrint } = require('./manual-text-formatter');
const Settings = require('../config/settings');
const os = require('os');
const path = require('path');
const fs = require('fs');

const VIRTUAL_PRINTER_PATTERNS = [
  /microsoft print to pdf/i,
  /onenote/i,
  /xps/i,
  /fax/i
];

function normalizePrinterName(name) {
  return String(name || '').trim().toLowerCase();
}

function isVirtualPrinterName(name) {
  const normalized = normalizePrinterName(name);
  return VIRTUAL_PRINTER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isLegacyWindowsPrintMode() {
  return process.env.HUB_FORCE_LEGACY_TEXT_PRINT === '1';
}

class WindowsPrinterManager {
  constructor() {
    this.printers = Settings.getCachedWindowsPrinters();
    this._discoveryTimer = null;
    this._refreshPromise = null;
    this._lastRefreshAt = 0;
    this._refreshCacheMs = 15000;
  }

  startAutoDiscovery(intervalMs = 10000) {
    logger.info('Iniciando descoberta automática de impressoras (Windows Spooler)...');
    this.refreshPrinters(true);
    if (this._discoveryTimer) {
      clearInterval(this._discoveryTimer);
    }
    this._discoveryTimer = setInterval(() => this.refreshPrinters(), intervalMs);
  }

  stopAutoDiscovery() {
    if (this._discoveryTimer) {
      clearInterval(this._discoveryTimer);
      this._discoveryTimer = null;
    }
    if (typeof winSpool.stopPersistentWorker === 'function') {
      void winSpool.stopPersistentWorker().catch((error) => {
        logger.warn('[win-spool] Falha ao encerrar worker persistente:', error.message || error);
      });
    }
  }

  async refreshPrinters(force = false) {
    const now = Date.now();
    if (!force && this._refreshPromise) {
      return this._refreshPromise;
    }

    if (!force && this.printers.length > 0 && (now - this._lastRefreshAt) < this._refreshCacheMs) {
      return this.printers;
    }

    this._refreshPromise = (async () => {
      try {
        const list = await winSpool.listPrinters();
        const physicalPrinterNames = (list || [])
          .map((name) => String(name || '').trim())
          .filter(Boolean)
          .filter((name) => !isVirtualPrinterName(name));

        this.printers = physicalPrinterNames.map((name) => ({
          id: name,
          name,
          type: 'WINDOWS_SPOOLER',
          isDefault: false,
          status: 'ready'
        }));
        const def = await winSpool.getDefaultPrinter();
        if (def) {
          const p = this.printers.find(p => normalizePrinterName(p.name) === normalizePrinterName(def));
          if (p) p.isDefault = true;
        }
        Settings.setCachedWindowsPrinters(this.printers);
        this._lastRefreshAt = Date.now();
        logger.info(`[win-spool] Impressoras fisicas atuais: ${this.printers.map((p) => p.name).join(', ') || 'nenhuma'}`);
        return this.printers;
      } catch (err) {
        logger.error('Erro ao listar impressoras via win-spool:', err);
        this._lastRefreshAt = Date.now();
        return this.printers;
      } finally {
        this._refreshPromise = null;
      }
    })();

    try {
      return await this._refreshPromise;
    } catch (err) {
      return this.printers;
    }
  }

  getPrinters() {
    if (!this.printers.length && !this._refreshPromise) {
      void this.refreshPrinters();
    }
    return this.printers;
  }

  async resolveAvailablePrinterName(printerName, { allowDefault = true, forceRefresh = false } = {}) {
    const requested = normalizePrinterName(printerName);
    // O auto-discovery mantém esta lista atualizada em background. No caminho
    // normal de impressão, usar o cache evita executar Get-Printer/PowerShell
    // duas vezes antes de cada pedido. Só bloqueamos numa redescoberta quando o
    // cache está vazio, o chamador pediu forceRefresh ou a impressora não foi
    // encontrada — casos em que uma conexão/troca recente pode ter ocorrido.
    let printers = this.printers;
    if (forceRefresh || printers.length === 0) {
      printers = await this.refreshPrinters(forceRefresh);
    }

    if (!requested) {
      if (!allowDefault) return null;
      return printers.find((printer) => printer.isDefault)?.name || printers[0]?.name || null;
    }

    let matched = printers.find((printer) => normalizePrinterName(printer.name) === requested);
    if (!matched && !forceRefresh) {
      printers = await this.refreshPrinters(true);
      matched = printers.find((printer) => normalizePrinterName(printer.name) === requested);
    }
    return matched?.name || null;
  }

  async ensurePrinterAvailable(printerName) {
    const selectedPrinter = await this.resolveAvailablePrinterName(printerName, { allowDefault: false });
    if (!selectedPrinter) {
      const available = this.printers.map((printer) => printer.name).join(', ') || 'nenhuma';
      throw new Error(`Impressora "${printerName || 'não informada'}" não está disponível no Windows. Impressoras permitidas: ${available}`);
    }

    return selectedPrinter;
  }

  async testPrint(printerName) {
    try {
      const selectedPrinter = await this.ensurePrinterAvailable(printerName);
      logger.info(`[testPrint] Iniciando teste para: ${selectedPrinter}`);
      const data = Buffer.concat([
        Buffer.from([0x1B, 0x40]),
        Buffer.from([0x1B, 0x61, 0x01]),
        Buffer.from('Hub Impressao\n'),
        Buffer.from('--------------------------------\n'),
        Buffer.from([0x1B, 0x61, 0x00]),
        Buffer.from('Teste de Comunicacao OK\n'),
        Buffer.from(`Impressora: ${selectedPrinter}\n`),
        Buffer.from(`Data: ${new Date().toLocaleString()}\n`),
        Buffer.from('\n\n\n'),
        Buffer.from([0x1D, 0x56, 0x00])
      ]);
      return await this._printBuffer(selectedPrinter, data);
    } catch (err) {
      logger.error(`[testPrint] Falha ao imprimir teste em ${printerName}:`, err);
      throw err;
    }
  }

  async print({ printer: printerName, rawContent, orderData, printType = 'counter', printSettings }) {
    try {
      const selectedPrinter = await this.ensurePrinterAvailable(printerName);
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
      } else if (orderData && typeof orderData.text === 'string') {
        buf = formatManualTextPrint(orderData.text, printSettings);
      } else if (orderData) {
        const commands = pedidosHubFormatter.generateOrderPrintData(orderData, printType, printSettings);
        const commandString = Array.isArray(commands) ? commands.join('') : String(commands);
        buf = Buffer.from(commandString, 'binary');
      } else {
        throw new Error('Nenhum conteúdo para imprimir fornecido');
      }
      return await this._printBuffer(selectedPrinter, buf, {
        preserveRaw: Boolean(rawContent)
      });
    } catch (err) {
      logger.error('[print] Erro ao imprimir via win-spool:', err);
      throw err;
    }
  }

  async _printBuffer(printerName, buffer, { preserveRaw = false } = {}) {
    if (!preserveRaw && isLegacyWindowsPrintMode() && typeof winSpool.printText === 'function') {
      try {
        const printableText = typeof winSpool.bufferToPrintableText === 'function'
          ? winSpool.bufferToPrintableText(buffer)
          : String(buffer || '');
        await winSpool.printText(printerName, printableText);
        logger.info(`[print] Impressão texto legado via driver enviada para ${printerName}`);
        return { success: true, mode: 'legacy-text' };
      } catch (legacyErr) {
        if (legacyErr && legacyErr.printOutcomeUncertain === true) throw legacyErr;
        logger.warn('[print] Impressão texto legado falhou, tentando RAW:', legacyErr.message || legacyErr);
      }
    }

    // Preferir enviar RAW via winSpool.printRaw (usa WinAPI via PowerShell)
    try {
      await winSpool.printRaw(printerName, buffer);
      logger.info(`[print] Impressão RAW via win-spool enviada para ${printerName}`);
      return { success: true, mode: 'raw' };
    } catch (err) {
      if (err && err.printOutcomeUncertain === true) throw err;
      logger.warn('[print] printRaw falhou, tentando fallback de texto/arquivo:', err.message || err);

      if (!preserveRaw && typeof winSpool.printText === 'function') {
        try {
          const printableText = typeof winSpool.bufferToPrintableText === 'function'
            ? winSpool.bufferToPrintableText(buffer)
            : String(buffer || '');
          await winSpool.printText(printerName, printableText);
          logger.info(`[print] Impressão texto fallback via driver enviada para ${printerName}`);
          return { success: true, mode: 'text-fallback' };
        } catch (textErr) {
          if (textErr && textErr.printOutcomeUncertain === true) throw textErr;
          logger.warn('[print] Fallback texto falhou, tentando printFile:', textErr.message || textErr);
        }
      }

      // fallback: write temp file and call printFile
      try {
        const tmpFile = path.join(os.tmpdir(), `hubimpressao_print_${Date.now()}.bin`);
        fs.writeFileSync(tmpFile, buffer);
        await winSpool.printFile(printerName, tmpFile);
        try { fs.unlinkSync(tmpFile); } catch (e) {}
        logger.info('[print] Impressão via printFile enviada com sucesso');
        return { success: true, mode: 'print-file' };
      } catch (e) {
        logger.error('[print] Falha no fallback printFile:', e);
        throw e;
      }
    }
  }
}

module.exports = WindowsPrinterManager;
module.exports.__private = {
  isLegacyWindowsPrintMode
};
