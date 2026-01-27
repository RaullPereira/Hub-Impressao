// Removido método duplicado fora da classe
const os = require('os');
const USBManager = require('./manager');
const CUPSManager = require('./cups-manager');

class HybridPrinterManager {
    startAutoDiscovery(interval = 10000) {
      if (typeof this.usbManager.startAutoDiscovery === 'function') {
        this.usbManager.startAutoDiscovery(interval);
      }
      if (os.platform() !== 'win32' && typeof this.cupsManager.startAutoDiscovery === 'function') {
        this.cupsManager.startAutoDiscovery(interval);
      }
    }
  constructor() {
    this.usbManager = new USBManager();
    this.cupsManager = new CUPSManager();
    this.printers = new Map();
    this.discoverPrinters();
  }

  async discoverPrinters() {
    this.printers.clear();
    // USB printers (always)
    await this.usbManager.discoverPrinters();
    for (const p of this.usbManager.getPrinters()) {
      this.printers.set('usb-' + p.id, { ...p, id: 'usb-' + p.id });
    }
    // CUPS printers (only if not Windows)
    if (os.platform() !== 'win32') {
      try {
        await this.cupsManager.discoverPrinters();
        for (const p of this.cupsManager.getPrinters()) {
          this.printers.set('cups-' + p.id, { ...p, id: 'cups-' + p.id });
        }
      } catch (err) {
        // Suprime erros do CUPS em sistemas não suportados
      }
    }
  }

  getPrinters() {
    return Array.from(this.printers.values());
  }

  async testPrint(printerId) {
    if (printerId.startsWith('usb-')) {
      return this.usbManager.testPrint(printerId.replace('usb-', ''));
    } else if (printerId.startsWith('cups-')) {
      return this.cupsManager.testPrint(printerId.replace('cups-', ''));
    }
    throw new Error('Tipo de impressora desconhecido');
  }

  // Adicione outros métodos conforme necessário, delegando para usbManager ou cupsManager
}

module.exports = HybridPrinterManager;
