// src/main/printer/detector.js
// Auto-detecção de impressoras de rede e Bluetooth
const dgram = require('dgram');
const os = require('os');
const logger = require('../utils/logger');

class PrinterDetector {
  constructor() {
    this.foundPrinters = [];
  }

  // Descobre impressoras de rede via broadcast (porta padrão 9100)
  async discoverNetworkPrinters(timeout = 2000) {
    return new Promise((resolve) => {
      const printers = [];
      const socket = dgram.createSocket('udp4');
      const message = Buffer.from('PRINTER_DISCOVERY');
      const interfaces = os.networkInterfaces();
      const broadcastAddresses = [];

      // Descobre endereços de broadcast
      for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
          if (iface.family === 'IPv4' && !iface.internal) {
            const parts = iface.address.split('.');
            parts[3] = '255';
            broadcastAddresses.push(parts.join('.'));
          }
        }
      }

      socket.on('message', (msg, rinfo) => {
        if (!printers.find(p => p.address === rinfo.address)) {
          printers.push({
            name: msg.toString() || 'Impressora de Rede',
            address: rinfo.address,
            port: 9100,
            type: 'network'
          });
        }
      });

      socket.bind(() => {
        socket.setBroadcast(true);
        broadcastAddresses.forEach(addr => {
          socket.send(message, 9100, addr);
        });
      });

      setTimeout(() => {
        socket.close();
        logger.info(`Detectadas ${printers.length} impressoras de rede.`);
        resolve(printers);
      }, timeout);
    });
  }

  // Bluetooth: placeholder (depende de plataforma e libs externas)
  async discoverBluetoothPrinters() {
    // Sugestão: usar 'node-bluetooth' ou 'noble' para escanear dispositivos
    // Aqui apenas retorna vazio
    return [];
  }
}

module.exports = PrinterDetector;
