// Removido método duplicado fora da classe
const os = require('os');
const USBManager = require('./manager');
const CUPSManager = require('./cups-manager');
const logger = require('../utils/logger');

class HybridPrinterManager {
  constructor() {
    this.usbManager = new USBManager({ includeSystem: false });
    this.cupsManager = new CUPSManager();
    this.printers = new Map();
    this.lastDiscoveryTime = 0;
    this.discoveryInterval = null;
    this.cacheTimeout = 10000; // Cache maior para aliviar notebooks menos potentes
    this.isDiscovering = false;
    
    // Descoberta inicial
    this.discoverPrinters();
  }

  startAutoDiscovery(interval = 30000) {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
    }
    
    logger.info(`[HybridManager] Auto-discovery iniciado com intervalo de ${interval}ms`);
    
    this.discoveryInterval = setInterval(() => {
      this.discoverPrinters(true); // silent mode
    }, interval);
  }

  stopAutoDiscovery() {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
      logger.info('[HybridManager] Auto-discovery parado');
    }
  }

  async discoverPrinters(silent = false) {
    const now = Date.now();
    if (this.isDiscovering || (now - this.lastDiscoveryTime < this.cacheTimeout && this.printers.size > 0)) {
      if (!silent) {
        logger.debug('[HybridManager] Usando cache de impressoras');
      }
      return;
    }
    
    this.isDiscovering = true;
    const nextPrinters = new Map();

    try {
      await this.usbManager.discoverPrinters();
      for (const p of this.usbManager.getPrinters()) {
        if (p.id.startsWith('usb-') || p.id.startsWith('cups-') || p.id.startsWith('network-')) {
          nextPrinters.set(p.id, { ...p });
        } else if (p.type === 'usb') {
          nextPrinters.set('usb-' + p.id, { ...p, id: 'usb-' + p.id });
        } else if (p.type === 'cups' || p.type === 'system') {
          nextPrinters.set('cups-' + p.id, { ...p, id: 'cups-' + p.id });
        } else {
          nextPrinters.set(p.id, { ...p });
        }
      }

      if (os.platform() !== 'win32') {
        try {
          await this.cupsManager.discoverPrinters();
          for (const p of this.cupsManager.getPrinters()) {
            const cupId = p.id.startsWith('cups-') ? p.id : 'cups-' + p.id;
            if (!nextPrinters.has(cupId)) {
              nextPrinters.set(cupId, { ...p, id: cupId, type: 'cups' });
            }
          }
        } catch (err) {}
      }

      this.printers = nextPrinters;
      this.lastDiscoveryTime = Date.now();

      if (!silent) {
        logger.info(`[HybridManager] Total de impressoras: ${this.printers.size}`);
      }
    } finally {
      this.isDiscovering = false;
    }
  }

  getPrinters() {
    return Array.from(this.printers.values());
  }

  async testPrint(printerId) {
    logger.info(`[HybridManager] testPrint chamado com printerId: ${printerId}`);
    logger.info(`[HybridManager] Impressoras disponíveis: ${JSON.stringify(Array.from(this.printers.keys()))}`);
    
    // Primeiro, tenta com prefixos explícitos
    if (printerId.startsWith('usb-')) {
      logger.info(`[HybridManager] Usando USB manager para: ${printerId}`);
      return this.usbManager.testPrint(printerId.replace('usb-', ''));
    } else if (printerId.startsWith('cups-')) {
      logger.info(`[HybridManager] Usando CUPS manager para: ${printerId}`);
      return this.cupsManager.testPrint(printerId.replace('cups-', ''));
    }
    
    // Se não tem prefixo, procura a impressora pelo ID no Map
    const printer = this.printers.get(printerId);
    if (printer) {
      logger.info(`[HybridManager] Impressora encontrada no Map: ${JSON.stringify(printer)}`);
      if (printer.id.startsWith('usb-')) {
        return this.usbManager.testPrint(printer.id.replace('usb-', ''));
      } else if (printer.id.startsWith('cups-')) {
        return this.cupsManager.testPrint(printer.id.replace('cups-', ''));
      }
    }
    
    // Fallback: tenta encontrar por nome/id parcial
    for (const [key, p] of this.printers) {
      if (key.includes(printerId) || p.name === printerId) {
        logger.info(`[HybridManager] Encontrado por busca parcial: ${key}`);
        if (key.startsWith('usb-')) {
          return this.usbManager.testPrint(key.replace('usb-', ''));
        } else if (key.startsWith('cups-')) {
          return this.cupsManager.testPrint(key.replace('cups-', ''));
        }
      }
    }
    
    // Último recurso no macOS: tenta via CUPS diretamente
    if (process.platform === 'darwin') {
      logger.info(`[HybridManager] Tentando CUPS direto para: ${printerId}`);
      return this.cupsManager.testPrint(printerId);
    }
    
    throw new Error('Tipo de impressora desconhecido');
  }

  async print(printerIdOrOptions, orderData, printType) {
    // Aceita tanto print(printerId, orderData, printType) quanto print({ printer, orderData, rawContent, printType, useRawContent })
    let printerId, rawContent, useRawContent, resolvedPrintSettings;
    
    if (typeof printerIdOrOptions === 'object' && printerIdOrOptions !== null) {
      // Formato objeto: { printer, orderData, rawContent, printType, useRawContent }
      printerId = printerIdOrOptions.printer;
      orderData = printerIdOrOptions.orderData;
      rawContent = printerIdOrOptions.rawContent;
      printType = printerIdOrOptions.printType;
      useRawContent = printerIdOrOptions.useRawContent;
      resolvedPrintSettings = printerIdOrOptions.printSettings;
    } else {
      // Formato antigo: print(printerId, orderData, printType)
      printerId = printerIdOrOptions;
    }
    
    logger.info(`[HybridManager] print chamado com printerId: ${printerId}`);
    logger.info(`[HybridManager] useRawContent: ${useRawContent}, rawContent presente: ${!!rawContent}`);
    
    // Helper para chamar o manager correto
    const callPrint = async (manager, id) => {
      if (typeof manager.print === 'function') {
        // Sempre passa o objeto completo para manter useRawContent
        return manager.print({ 
          printer: id, 
          orderData, 
          rawContent, 
          printType,
          useRawContent,
          printSettings: resolvedPrintSettings
        });
      }
      throw new Error('Manager não tem método print');
    };
    
    // Tenta com prefixos explícitos
    if (printerId.startsWith('usb-')) {
      return callPrint(this.usbManager, printerId.replace('usb-', ''));
    } else if (printerId.startsWith('cups-')) {
      return callPrint(this.cupsManager, printerId.replace('cups-', ''));
    }
    
    // Busca a impressora pelo ID no Map
    const printer = this.printers.get(printerId);
    if (printer) {
      if (printer.id.startsWith('usb-')) {
        return callPrint(this.usbManager, printer.id.replace('usb-', ''));
      } else if (printer.id.startsWith('cups-')) {
        return callPrint(this.cupsManager, printer.id.replace('cups-', ''));
      }
    }
    
    // Fallback: busca por nome/id parcial
    for (const [key, p] of this.printers) {
      if (key.includes(printerId) || p.name === printerId) {
        if (key.startsWith('usb-')) {
          return callPrint(this.usbManager, key.replace('usb-', ''));
        } else if (key.startsWith('cups-')) {
          return callPrint(this.cupsManager, key.replace('cups-', ''));
        }
      }
    }
    
    // Último recurso no macOS
    if (process.platform === 'darwin') {
      return callPrint(this.cupsManager, printerId);
    }
    
    throw new Error('Impressora não encontrada para impressão');
  }

  async refreshPrinters() {
    await this.discoverPrinters();
    return this.getPrinters();
  }

  // Adicione outros métodos conforme necessário, delegando para usbManager ou cupsManager
}

module.exports = HybridPrinterManager;
