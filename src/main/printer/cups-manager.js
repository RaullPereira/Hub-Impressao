const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const execPromise = promisify(exec);
const logger = require('../utils/logger');

class CUPSPrinterManager {
  constructor() {
    this.printers = new Map();
    this.discoverPrinters();
    logger.info('CUPSPrinterManager inicializado');
  }

  async discoverPrinters() {
    try {
      const { stdout } = await execPromise('lpstat -p');
      const lines = stdout.split('\n').filter(l => l.includes('impressora'));
      
      this.printers.clear();
      lines.forEach((line) => {
        const match = line.match(/impressora (\S+)/);
        if (match) {
          const name = match[1];
          this.printers.set(name, {
            id: name,
            name: name,
            type: 'system',
            status: 'ready'
          });
        }
      });
      
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

  async print(printerId, orderData, printType = 'counter') {
    logger.info('=== [PRINT] INICIANDO IMPRESSÃO ===');
    logger.info('[PRINT] printerId:', printerId);
    logger.info('[PRINT] orderData:', JSON.stringify(orderData, null, 2));
    logger.info('[PRINT] printType:', printType);
    
    const printer = this.printers.get(printerId);
    if (!printer) {
      logger.warn('[PRINT] Impressora não encontrada, usando padrão');
      const printers = this.getPrinters();
      if (printers.length === 0) throw new Error('Nenhuma impressora disponível');
      return this.print(printers[0].id, orderData, printType);
    }
    
    logger.info('[PRINT] Impressora selecionada:', printer.name);
    
    // Construir comandos ESC/POS
    const orderNum = String(orderData.order_number || '0').padStart(3, '0');
    const customerName = orderData.customer_name || 'Cliente';
    const items = orderData.items || [];
    const total = (orderData.total || 0).toFixed(2);
    
    logger.info('[PRINT] Construindo buffer ESC/POS...');
    
    const parts = [];
    parts.push(Buffer.from([0x1B, 0x40]));
    parts.push(Buffer.from([0x1B, 0x61, 0x01]));
    parts.push(Buffer.from([0x1D, 0x21, 0x11]));
    parts.push(Buffer.from(`PEDIDO #${orderNum}\n`));
    parts.push(Buffer.from([0x1D, 0x21, 0x00]));
    parts.push(Buffer.from('\n'));
    parts.push(Buffer.from([0x1B, 0x61, 0x00]));
    parts.push(Buffer.from(`CLIENTE: ${customerName}\n\n`));
    parts.push(Buffer.from('ITENS:\n'));
    parts.push(Buffer.from('================================\n'));
    
    items.forEach(item => {
      const qty = item.quantity || 1;
      const name = item.product_name || item.name || 'Item';
      const price = (item.total_price || 0).toFixed(2);
      parts.push(Buffer.from(`${qty}x ${name}\n`));
      parts.push(Buffer.from(`   R$ ${price}\n`));
      parts.push(Buffer.from('--------------------------------\n'));
    });
    
    parts.push(Buffer.from('\n'));
    parts.push(Buffer.from([0x1B, 0x61, 0x01]));
    parts.push(Buffer.from([0x1D, 0x21, 0x11]));
    parts.push(Buffer.from(`TOTAL: R$ ${total}\n`));
    parts.push(Buffer.from([0x1D, 0x21, 0x00]));
    parts.push(Buffer.from([0x0A, 0x0A, 0x0A]));
    parts.push(Buffer.from([0x1D, 0x56, 0x00]));
    
    const escposBuffer = Buffer.concat(parts);
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

  addNetworkPrinter() {}
  removePrinter() {}
}

module.exports = CUPSPrinterManager;
