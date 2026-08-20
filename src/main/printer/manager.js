const { EventEmitter } = require('events');
const escpos = require('escpos');
let USB = null;
try {
  USB = require('escpos-usb');
} catch (e) {
  // escpos-usb não disponível nesta plataforma
}
const Network = require('escpos-network');
const logger = require('../utils/logger');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const winSpool = require('./win-spool');
const Settings = require('../config/settings');
const { formatManualTextPrint } = require('./manual-text-formatter');

class PrinterManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.printers = new Map();
    this.includeSystemPrinters = options.includeSystem !== false;
    this._discoveryTimer = null;
    this._discoveryPromise = null;
    this._lastDiscoveryAt = 0;
    this._discoveryCacheMs = 15000;
    this.discoverPrinters(true);
  }

  async discoverPrinters(force = false) {
    const now = Date.now();
    if (!force && this._discoveryPromise) {
      return this._discoveryPromise;
    }

    if (!force && this.printers.size > 0 && (now - this._lastDiscoveryAt) < this._discoveryCacheMs) {
      return this.getPrinters();
    }

    this._discoveryPromise = (async () => {
      const nextPrinters = new Map();

    try {
      const usbDevices = USB ? USB.findPrinter() : [];
      usbDevices.forEach((device, index) => {
        const desc = device.deviceDescriptor;
        let name = `USB_${desc.idVendor.toString(16)}_${desc.idProduct.toString(16)}`;
        const id = `usb-${index}`;
        nextPrinters.set(id, {
          id,
          name,
          type: 'usb',
          index: index,
          vendorId: desc.idVendor,
          productId: desc.idProduct,
          status: 'ready'
        });
      });
      logger.info(`${usbDevices.length} impressora(s) USB detectadas`);

      if (os.platform() === 'win32') {
        try {
          const pnp = await winSpool.listPnpDevices();
          const winPrinters = await winSpool.listPrinters();
          const winPrintersLower = winPrinters.map(p => p.toLowerCase());

          for (const [id, p] of nextPrinters) {
            if (p.type !== 'usb') continue;
            const vid = p.vendorId ? p.vendorId.toString(16).padStart(4, '0').toUpperCase() : null;
            const pid = p.productId ? p.productId.toString(16).padStart(4, '0').toUpperCase() : null;
            if (!vid || !pid) continue;
            const search = `VID_${vid}&PID_${pid}`.toUpperCase();
            const matches = (pnp || []).filter(d => {
              const iid = (d.InstanceId || d.instanceId || '').toString().toUpperCase();
              return iid.includes(search);
            });
            if (matches.length === 0) continue;
            let chosenPrinter = null;
            for (const m of matches) {
              const friendly = (m.FriendlyName || m.friendlyName || '').toString().trim();
              if (!friendly) continue;
              const fl = friendly.toLowerCase();
              for (let i = 0; i < winPrintersLower.length; i++) {
                if (winPrintersLower[i].includes(fl) || fl.includes(winPrintersLower[i])) {
                  chosenPrinter = winPrinters[i];
                  break;
                }
              }
              if (chosenPrinter) break;
              const tokens = fl.split(/\s+/).filter(Boolean);
              for (let i = 0; i < winPrintersLower.length; i++) {
                for (const t of tokens) {
                  if (t.length < 3) continue;
                  if (winPrintersLower[i].includes(t)) {
                    chosenPrinter = winPrinters[i];
                    break;
                  }
                }
                if (chosenPrinter) break;
              }
              if (chosenPrinter) break;
            }
            if (chosenPrinter) {
              const friendlyName = matches[0].FriendlyName || matches[0].friendlyName || null;
              nextPrinters.set(id, Object.assign({}, p, {
                name: friendlyName || chosenPrinter,
                queueName: chosenPrinter,
                type: 'usb',
                status: 'ready'
              }));
              logger.info(`Auto-mapped USB printer ${id} -> Windows queue: ${chosenPrinter}`);
            }
          }
        } catch (e) {
          logger.warn('Auto-mapping USB->Windows printers falhou:', e.message || e);
        }
      }

      if (this.includeSystemPrinters) {
        let cupsPrinters = [];
        let descriptions = {};
        try {
          const descOut = execSync('lpstat -l -p', { encoding: 'utf-8' });
          let current = null;
          descOut.split('\n').forEach(line => {
            const printerMatch = line.match(/^printer ([^ ]+)/);
            if (printerMatch) {
              current = printerMatch[1];
            }
            const descMatch = line.match(/Description:\s*(.*)/);
            if (current && descMatch) {
              descriptions[current] = descMatch[1];
            }
          });
        } catch (err) {
          logger.error('Erro ao buscar descrições detalhadas das impressoras:', err);
        }
        try {
          const stdout = execSync('lpstat -v', { encoding: 'utf-8' });
          cupsPrinters = stdout.split('\n')
            .map(line => {
              const match = line.match(/^(?:device for|dispositivo para) ([^:]+):/);
              return match ? match[1] : null;
            })
            .filter(Boolean);
        } catch (err) {
          logger.error('Erro ao listar impressoras CUPS:', err);
        }
        cupsPrinters.forEach((name) => {
          const id = `cups-${name}`;
          const friendlyName = descriptions[name] || name;
          if (!nextPrinters.has(id)) {
            nextPrinters.set(id, {
              id,
              name: friendlyName,
              queueName: name,
              type: 'cups',
              status: 'ready'
            });
          }
        });
        logger.info(`${cupsPrinters.length} impressora(s) detectadas via CUPS: [${cupsPrinters.join(', ')}]`);
      }

      this.printers = nextPrinters;
      this._lastDiscoveryAt = Date.now();
      return this.getPrinters();
    } catch (error) {
      logger.error('Erro ao descobrir impressoras:', error);
      return this.getPrinters();
    } finally {
      this._discoveryPromise = null;
    }
    })();

    return this._discoveryPromise;
  }

  startAutoDiscovery(interval = 10000) {
    if (this._discoveryTimer) {
      clearInterval(this._discoveryTimer);
    }

    this._discoveryTimer = setInterval(() => {
      void this.discoverPrinters();
    }, interval);
  }

  stopAutoDiscovery() {
    if (this._discoveryTimer) {
      clearInterval(this._discoveryTimer);
      this._discoveryTimer = null;
    }
  }

  getPrinters() {
    return Array.from(this.printers.values()).map(p => ({
      id: p.id,
      name: p.name,
      queueName: p.queueName,
      type: p.type,
      vendorId: p.vendorId,
      productId: p.productId,
      status: p.status
    }));
  }

  addNetworkPrinter(name, address, port = 9100) {
    const id = `network-${Date.now()}`;
    this.printers.set(id, {
      id,
      name,
      type: 'network',
      address,
      port,
      status: 'ready'
    });
    logger.info(`Impressora de rede adicionada: ${name}`);
    return id;
  }

  removePrinter(printerId) {
    const removed = this.printers.delete(printerId);
    if (removed) {
      logger.info(`Impressora removida: ${printerId}`);
    }
    return removed;
  }

  async testPrint(printerId) {
    let printer = this.printers.get(printerId);
    if (!printer) {
      // Buscar por nome se não encontrar por ID
      for (const p of this.printers.values()) {
        if (p.name === printerId || p.queueName === printerId) {
          printer = p;
          break;
        }
      }
    }
    if (!printer) throw new Error('Impressora não encontrada');

    let device;
    if (printer.type === 'usb') {
      // Buscar o device novamente
      if (!USB) {
        throw new Error('Módulo escpos-usb não disponível nesta plataforma');
      }
      const usbDevices = USB.findPrinter();
      if (!usbDevices[printer.index]) {
        throw new Error('Impressora USB não encontrada');
      }
      device = usbDevices[printer.index];
    } else if (printer.type === 'network') {
      device = new Network(printer.address, printer.port);
    }

    return new Promise((resolve, reject) => {
      try {
        device.open((err) => {
          if (err) {
            logger.error('Erro ao abrir impressora:', err);
            // Fallback: tentar enviar via spooler do Windows se estiver no Windows
            if (os.platform() === 'win32') {
              (async () => {
                try {
                          const mapping = Settings.getUsbMapping(printer.id);
                          const defaultPrinter = mapping || (await winSpool.getDefaultPrinter()) || (await winSpool.getPreferredPrinter()) || (await winSpool.listPrinters())[0];
                          if (!defaultPrinter) throw new Error('Nenhuma impressora do Windows encontrada para fallback');
                          const content = `TESTE DE IMPRESSAO\r\nSistema Funcionando!\r\n${new Date().toLocaleString('pt-BR')}`;
                          // Preferir envio RAW via WinAPI para manter bytes ESC/POS
                          try {
                            await winSpool.printRaw(defaultPrinter, Buffer.from(content, 'utf8'));
                            logger.info('[TEST-FALLBACK] Impressão via spooler RAW enviada com sucesso para: ' + defaultPrinter);
                          } catch (e) {
                            // fallback para printFile se RAW falhar
                            const tmpFile = path.join(os.tmpdir(), `hubimpressao_test_${Date.now()}.txt`);
                            fs.writeFileSync(tmpFile, content, { encoding: 'utf8' });
                            await winSpool.printFile(defaultPrinter, tmpFile);
                            try { fs.unlinkSync(tmpFile); } catch (e) {}
                            logger.info('[TEST-FALLBACK] Impressão via spooler (print) enviada com sucesso para: ' + defaultPrinter);
                          }
                  resolve();
                } catch (e) {
                  logger.error('[TEST-FALLBACK] Falha no fallback para spooler Windows:', e);
                  return reject(new Error('Erro ao abrir impressora: ' + err.message));
                }
              })();
              return;
            }
            return reject(new Error('Erro ao abrir impressora: ' + err.message));
          }

          const printerObj = new escpos.Printer(device, {
            encoding: 'GB18030'
          });

          printerObj
            .font('a')
            .align('ct')
            .style('bu')
            .size(2, 2)
            .text('TESTE DE IMPRESSAO')
            .size(1, 1)
            .text('------------------')
            .text('Sistema Funcionando!')
            .text(new Date().toLocaleString('pt-BR'))
            .feed(3)
            .cut()
            .close(() => {
              logger.info('Teste de impressão concluído');
              resolve();
            });
        });
      } catch (syncErr) {
        logger.error('Erro síncrono ao abrir device:', syncErr);
        if (os.platform() === 'win32') {
          (async () => {
            try {
              const mapping = Settings.getUsbMapping(printer.id);
              const defaultPrinter = mapping || (await winSpool.getDefaultPrinter()) || (await winSpool.getPreferredPrinter()) || (await winSpool.listPrinters())[0];
              if (!defaultPrinter) throw new Error('Nenhuma impressora do Windows encontrada para fallback');
              const tmpFile = path.join(os.tmpdir(), `hubimpressao_test_${Date.now()}.txt`);
              const content = `TESTE DE IMPRESSAO\r\nSistema Funcionando!\r\n${new Date().toLocaleString('pt-BR')}`;
              fs.writeFileSync(tmpFile, content, { encoding: 'utf8' });
              await winSpool.printFile(defaultPrinter, tmpFile);
              try { fs.unlinkSync(tmpFile); } catch (e) {}
              logger.info('[TEST-FALLBACK] Impressão via spooler do Windows enviada com sucesso para: ' + defaultPrinter);
              resolve();
            } catch (e) {
              logger.error('[TEST-FALLBACK] Falha no fallback síncrono para spooler Windows:', e);
              return reject(syncErr);
            }
          })();
        } else {
          return reject(syncErr);
        }
      }
    });
  }

  async print(printerIdOrOptions, orderDataArg, printTypeArg = 'counter', rawContentArg = null) {
    let printerId = printerIdOrOptions;
    let orderData = orderDataArg;
    let printType = printTypeArg;
    let rawContent = rawContentArg;
    let printSettings = null;

    if (typeof printerIdOrOptions === 'object' && printerIdOrOptions !== null) {
      printerId = printerIdOrOptions.printer;
      orderData = printerIdOrOptions.orderData;
      printType = printerIdOrOptions.printType || 'counter';
      rawContent = printerIdOrOptions.rawContent || null;
      printSettings = printerIdOrOptions.printSettings || null;
    }

    // localizar impressora por id ou por nome/queueName
    let printer = this.printers.get(printerId);
    if (!printer) {
      for (const p of this.printers.values()) {
        if (p.name === printerId || p.queueName === printerId) {
          printer = p;
          break;
        }
      }
    }
    if (!printer) throw new Error('Impressora não encontrada');

    // Preparar buffer de impressão: rawContent (possivelmente base64) ou formatador interno
    let printBuffer = null;
    if (rawContent) {
      try {
        if (typeof rawContent === 'string') {
          // tentar decodificar base64 — se falhar, usar como texto
          try { printBuffer = Buffer.from(rawContent, 'base64'); }
          catch (_) { printBuffer = Buffer.from(String(rawContent), 'binary'); }
        } else if (Buffer.isBuffer(rawContent)) {
          printBuffer = rawContent;
        } else {
          printBuffer = Buffer.from(String(rawContent), 'binary');
        }
        logger.info('[PRINT] Usando rawContent recebido (tamanho ' + printBuffer.length + ' bytes)');
      } catch (e) {
        logger.warn('[PRINT] Falha ao processar rawContent, fallback para formatador interno:', e.message);
        printBuffer = null;
      }
    }

    if (!printBuffer && orderData && typeof orderData.text === 'string') {
      printBuffer = formatManualTextPrint(orderData.text, printSettings);
      logger.info(`[PRINT] Texto manual formatado em 58mm compacto (tamanho): ${printBuffer.length} bytes`);
    }

    if (!printBuffer) {
      const { generateOrderPrintData } = require('./escpos-formatter');
      const rawCommands = generateOrderPrintData(orderData, printType);
      const commandString = rawCommands.join('');
      printBuffer = Buffer.from(commandString, 'binary');
      logger.info(`[PRINT] Comando gerado internamente (tamanho): ${printBuffer.length} bytes`);
    }

    // Envio via CUPS (se aplicável)
    if (printer.type === 'cups') {
      return new Promise((resolve, reject) => {
        try {
          const tempFile = path.join(os.tmpdir(), `print-${Date.now()}.bin`);
          fs.writeFileSync(tempFile, printBuffer);
          const cmd = `lp -d "${printer.queueName}" -o raw "${tempFile}"`;
          logger.info(`[CUPS] Executando: ${cmd}`);
          execSync(cmd);
          try { fs.unlinkSync(tempFile); } catch (e) { }
          logger.info('Impressão CUPS enviada com sucesso');
          resolve();
        } catch (err) {
          logger.error('Erro no CUPS:', err);
          reject(new Error('Erro na impressão CUPS: ' + err.message));
        }
      });
    }

    // USB / Network via escpos
    let device;
    if (printer.type === 'usb') {
      if (!USB) {
        throw new Error('Módulo escpos-usb não disponível nesta plataforma');
      }
      const usbDevices = USB.findPrinter();
      if (!usbDevices[printer.index]) {
        logger.error(`[PRINT] Impressora USB '${printer.name}' não encontrada pelo índice: ${printer.index}`);
        throw new Error(`Impressora USB '${printer.name}' não encontrada ou desconectada.`);
      }
      device = usbDevices[printer.index];
    } else if (printer.type === 'network') {
      device = new Network(printer.address, printer.port);
    } else {
      throw new Error(`Tipo de impressora não suportado: ${printer.type}`);
    }

    if (!device) {
      throw new Error(`Device para impressora '${printer.name || printer.id}' não encontrado.`);
    }

    return new Promise((resolve, reject) => {
      device.open((err) => {
        if (err) {
          logger.error('[PRINT] Erro ao abrir impressora:', err);
          // Tentar fallback via spooler do Windows
          if (os.platform() === 'win32') {
            (async () => {
              try {
                    const mapping = Settings.getUsbMapping(printer.id);
                    const defaultPrinter = mapping || (await winSpool.getDefaultPrinter()) || (await winSpool.getPreferredPrinter()) || (await winSpool.listPrinters())[0];
                    if (!defaultPrinter) throw new Error('Nenhuma impressora do Windows encontrada para fallback');
                    // Enviar RAW (recomendado para ESC/POS)
                    try {
                      await winSpool.printRaw(defaultPrinter, printBuffer);
                      logger.info('[PRINT-FALLBACK] Impressão RAW via spooler do Windows enviada com sucesso para: ' + defaultPrinter);
                    } catch (e) {
                      // fallback para printFile se RAW falhar
                      const tmpFile = path.join(os.tmpdir(), `hubimpressao_print_${Date.now()}.bin`);
                      fs.writeFileSync(tmpFile, printBuffer);
                      await winSpool.printFile(defaultPrinter, tmpFile);
                      try { fs.unlinkSync(tmpFile); } catch (e) {}
                      logger.info('[PRINT-FALLBACK] Impressão via spooler (print) enviada com sucesso para: ' + defaultPrinter);
                    }
                resolve();
              } catch (e) {
                logger.error('[PRINT-FALLBACK] Falha no fallback para spooler Windows:', e);
                return reject(new Error('Erro ao abrir impressora: ' + err.message));
              }
            })();
            return;
          }
          return reject(new Error('Erro ao abrir impressora: ' + err.message));
        }

        try {
          logger.info('[PRINT] Dispositivo aberto, enviando buffer para a impressora...');
          const printerObj = new escpos.Printer(device, { encoding: 'GB18030' });
          printerObj.raw(printBuffer).close(() => {
            logger.info('[PRINT] Impressão concluída com sucesso!');
            resolve();
          });
        } catch (e) {
          logger.error('[PRINT] Erro durante o envio do comando para a impressora:', e);
          reject(e);
        }
      });
    });
  }
}

module.exports = PrinterManager;
