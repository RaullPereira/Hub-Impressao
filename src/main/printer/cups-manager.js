const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const execPromise = promisify(exec);
const logger = require('../utils/logger');
const pedidosHubFormatter = require('./pedidoshub-formatter');
const { formatManualTextPrint } = require('./manual-text-formatter');

class CUPSPrinterManager {
  constructor() {
    this.printers = new Map();
    this.discoverPrinters();
    logger.info('CUPSPrinterManager inicializado');
  }

  async discoverPrinters() {
    try {
      // Get all printers
      const { stdout } = await execPromise('lpstat -p');
      const lines = stdout.split('\n');

      this.printers.clear();

      lines.forEach((line) => {
        // Match "printer <name>" or "impressora <name>"
        // Regex handles both types of start characters
        const match = line.match(/^(?:printer|impressora)\s+(\S+)/i);
        if (match) {
          const name = match[1];
          // Strip colons or trailing punctuation if any (rare in lpstat -p names but possible in other formats)
          const cleanName = name.replace(/[:;]$/, '');

          this.printers.set(cleanName, {
            id: cleanName,
            name: cleanName,
            type: 'system', // CUPS
            status: line.includes('enabled') || line.includes('idle') || line.includes('pronta') ? 'ready' : 'offline',
            isDefault: false // We'll update this if we check default later
          });
        }
      });

      // Optional: Check default printer
      try {
        const { stdout: defaultOut } = await execPromise('lpstat -d');
        // Output: "system default destination: <name>" or "destino padrão do sistema: <name>"
        const defaultMatch = defaultOut.match(/:\s+(\S+)/);
        if (defaultMatch) {
          const defaultName = defaultMatch[1];
          if (this.printers.has(defaultName)) {
            this.printers.get(defaultName).isDefault = true;
          }
        }
      } catch (e) {
        // ignore default check error
      }

      logger.info(`${this.printers.size} impressora(s) detectadas via CUPS`);
    } catch (error) {
      logger.error('Erro ao descobrir impressoras:', error);
    }
  }

  getPrinters() {
    return Array.from(this.printers.values());
  }

  async testPrint(printerId) {
    logger.info(`[testPrint] Iniciando teste para: ${printerId}`);
    const printer = this.printers.get(printerId);
    if (!printer) throw new Error('Impressora não encontrada');

    const escposCommands = Buffer.from([
      0x1B, 0x40,
      0x1B, 0x61, 0x01,
      0x1D, 0x21, 0x11,
      ...Buffer.from('TESTE DE IMPRESSAO\n'),
      0x1D, 0x21, 0x00,
      0x1B, 0x61, 0x00,
      ...Buffer.from('========================\n'),
      ...Buffer.from('Sistema: OK\n'),
      ...Buffer.from('Data: ' + new Date().toLocaleString('pt-BR') + '\n'),
      ...Buffer.from('========================\n'),
      0x0A, 0x0A, 0x0A,
      0x1D, 0x56, 0x00
    ]);

    const tmpFile = '/tmp/thermal-test.prn';
    fs.writeFileSync(tmpFile, escposCommands);
    logger.info(`[testPrint] Arquivo salvo: ${tmpFile}`);

    try {
      const cmd = `lp -d "${printer.name}" -o raw ${tmpFile}`;
      logger.info(`[testPrint] Executando: ${cmd}`);
      const result = await execPromise(cmd);
      logger.info(`[testPrint] Resultado:`, result);
      logger.info(`[testPrint] Teste enviado para ${printer.name}`);
    } catch (error) {
      logger.error('[testPrint] Erro ao imprimir:', error);
      throw error;
    }
  }

  async print(printerIdOrOptions, orderData, printType = 'counter') {
    // Aceita tanto print(printerId, orderData, printType) quanto print({ printer, orderData, rawContent, printType, useRawContent })
    let printerId, rawContent, useRawContent, printSettings;
    
    if (typeof printerIdOrOptions === 'object' && printerIdOrOptions !== null) {
      printerId = printerIdOrOptions.printer;
      orderData = printerIdOrOptions.orderData;
      rawContent = printerIdOrOptions.rawContent;
      printType = printerIdOrOptions.printType || 'counter';
      useRawContent = printerIdOrOptions.useRawContent;
      printSettings = printerIdOrOptions.printSettings;
    } else {
      printerId = printerIdOrOptions;
    }
    
    logger.info('=== [PRINT] INICIANDO IMPRESSÃO ===');
    logger.info('[PRINT] printerId:', printerId);
    logger.info('[PRINT] printType:', printType);
    logger.info('[PRINT] useRawContent:', useRawContent);
    logger.info('[PRINT] rawContent presente:', !!rawContent);
    if (rawContent) {
      logger.info('[PRINT] rawContent tamanho:', rawContent.length);
    }

    const printer = this.printers.get(printerId);
    if (!printer) {
      logger.warn('[PRINT] Impressora não encontrada, tentando buscar por nome...');
      // Tenta encontrar por nome
      let found = null;
      for (const [id, p] of this.printers) {
        if (p.name === printerId || id === printerId) {
          found = p;
          break;
        }
      }
      if (!found) {
        logger.warn('[PRINT] Impressora não encontrada, usando padrão');
        const printers = this.getPrinters();
        if (printers.length === 0) throw new Error('Nenhuma impressora disponível');
        return this.print({ ...printerIdOrOptions, printer: printers[0].id });
      }
      // Usa a impressora encontrada
      return this._executePrint(found, orderData, rawContent, useRawContent, printType, printSettings);
    }

    return this._executePrint(printer, orderData, rawContent, useRawContent, printType, printSettings);
  }

  async _executePrint(printer, orderData, rawContent, useRawContent, printType, printSettings) {
    logger.info('[PRINT] Impressora selecionada:', printer.name);

    let escposBuffer;
    if (orderData && typeof orderData.text === 'string') {
      logger.info('[PRINT] Imprimindo texto manual em formato compacto 58mm');
      escposBuffer = formatManualTextPrint(orderData.text, printSettings);
    } else if (useRawContent && rawContent) {
      logger.info('[PRINT] ⚡ Usando rawContent DIRETAMENTE (useRawContent=true)');
      if (typeof rawContent === 'string') {
        // Decodifica Base64
        try {
          escposBuffer = Buffer.from(rawContent, 'base64');
          logger.info('[PRINT] rawContent decodificado de Base64, tamanho:', escposBuffer.length, 'bytes');
        } catch (e) {
          logger.warn('[PRINT] Falha ao decodificar Base64, tentando binary');
          escposBuffer = Buffer.from(rawContent, 'binary');
        }
      } else if (Buffer.isBuffer(rawContent)) {
        escposBuffer = rawContent;
      } else {
        escposBuffer = Buffer.from(String(rawContent));
      }
    } else if (rawContent && !orderData) {
      // rawContent presente mas sem orderData - usa raw
      logger.info('[PRINT] Usando rawContent (sem orderData)');
      if (typeof rawContent === 'string') {
        try {
          escposBuffer = Buffer.from(rawContent, 'base64');
        } catch (e) {
          escposBuffer = Buffer.from(rawContent, 'binary');
        }
      } else if (Buffer.isBuffer(rawContent)) {
        escposBuffer = rawContent;
      } else {
        escposBuffer = Buffer.from(String(rawContent));
      }
    } else {
      logger.info('[PRINT] Construindo buffer ESC/POS via formatter PedidosHub...');
      const commands = pedidosHubFormatter.generateOrderPrintData(orderData, printType, printSettings);
      const commandString = Array.isArray(commands) ? commands.join('') : String(commands);
      escposBuffer = Buffer.from(commandString, 'binary');
    }
    
    logger.info(`[PRINT] Buffer criado: ${escposBuffer.length} bytes`);

    const tmpFile = '/tmp/thermal-order.prn';
    fs.writeFileSync(tmpFile, escposBuffer);
    logger.info(`[PRINT] Arquivo salvo: ${tmpFile}`);

    try {
      const cmd = `lp -d "${printer.name}" -o raw ${tmpFile}`;
      logger.info(`[PRINT] Executando comando: ${cmd}`);

      const { stdout, stderr } = await execPromise(cmd);

      logger.info(`[PRINT] STDOUT: ${stdout}`);
      if (stderr) logger.warn(`[PRINT] STDERR: ${stderr}`);

      logger.info(`[PRINT] ✅ Pedido impresso em ${printer.name}`);
    } catch (error) {
      logger.error('[PRINT] ❌ Erro ao imprimir:', error.message);
      logger.error('[PRINT] Stack:', error.stack);
      throw error;
    }
  }

  startAutoDiscovery(interval = 10000) {
    setInterval(() => {
      this.discoverPrinters();
    }, interval);
  }

  addNetworkPrinter() { }
  removePrinter() { }
}

module.exports = CUPSPrinterManager;
