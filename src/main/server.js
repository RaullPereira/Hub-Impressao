const express = require('express');
const cors = require('cors');
const logger = require('./utils/logger');
const http = require('http');
const WebSocket = require('ws');
const Settings = require('./config/settings');

class Server {
  constructor(printerManager) {
    this.printerManager = printerManager;
    this.app = express();
    this.server = null;
    this.wss = null;
    this.port = 3001;
  }

  setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json());
  }

  setupRoutes() {
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Listar impressoras
    this.app.get('/api/printers', (req, res) => {
      try {
        const printers = this.printerManager.getPrinters();
        // Anexa mapeamento Windows (se existir) para cada impressora USB
        const Settings = require('./config/settings');
        const enriched = printers.map(p => {
          const mapping = Settings.getUsbMapping(p.id);
          return Object.assign({}, p, { windowsMapping: mapping || null });
        });
        res.json({ success: true, printers: enriched });
      } catch (error) {
        logger.error('Erro ao listar impressoras:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Testar impressora
    this.app.post('/api/printers/:id/test', async (req, res) => {
      try {
        logger.info(`Testando impressora: ${req.params.id}`);
        await this.printerManager.testPrint(req.params.id);
        res.json({ success: true, message: 'Teste enviado!' });
      } catch (error) {
        logger.error('Erro ao testar impressora:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Listar impressoras do Windows (para mapeamento)
    this.app.get('/api/windows-printers', async (req, res) => {
      try {
        const winSpool = require('./printer/win-spool');
        const printers = await winSpool.listPrinters();
        res.json({ success: true, printers });
      } catch (error) {
        logger.error('Erro ao listar impressoras do Windows:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Sugestões de mapeamento: correlaciona dispositivos USB detectados com PnP da máquina
    this.app.get('/api/printers/suggestions', async (req, res) => {
      try {
        const winSpool = require('./printer/win-spool');
        const pnp = await winSpool.listPnpDevices();
        const printers = this.printerManager.getPrinters();
        const usbPrinters = printers.filter(p => p.type === 'usb');
        const suggestions = usbPrinters.map(up => {
          const vid = up.vendorId ? up.vendorId.toString(16).padStart(4, '0').toUpperCase() : null;
          const pid = up.productId ? up.productId.toString(16).padStart(4, '0').toUpperCase() : null;
          const search = vid && pid ? `VID_${vid}&PID_${pid}` : null;
          const matches = [];
          if (search) {
            for (const d of pnp) {
              try {
                const iid = (d.InstanceId || d.instanceId || '').toUpperCase();
                const fname = (d.FriendlyName || d.friendlyName || '').toString();
                if (iid.includes(search)) matches.push({ instanceId: iid, friendlyName: fname });
              } catch (e) {}
            }
          }
          return {
            usbId: up.id,
            vendorId: up.vendorId,
            productId: up.productId,
            vidPidSearch: search,
            matches
          };
        });
        res.json({ success: true, suggestions });
      } catch (error) {
        logger.error('Erro ao gerar sugestões de mapeamento:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Mapear impressora USB detectada para uma fila do Windows
    this.app.post('/api/printers/:id/map', (req, res) => {
      try {
        const usbId = req.params.id;
        const { windowsPrinter } = req.body;
        if (!windowsPrinter) return res.status(400).json({ success: false, error: 'windowsPrinter é obrigatório' });
        Settings.setUsbMapping(usbId, windowsPrinter);
        logger.info(`Mapeamento salvo: ${usbId} -> ${windowsPrinter}`);
        res.json({ success: true });
      } catch (error) {
        logger.error('Erro ao salvar mapeamento:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Imprimir pedido
    this.app.post('/api/print', async (req, res) => {
      try {
        logger.info('=== RECEBENDO PEDIDO DE IMPRESSÃO ===');
        
        const { printerId, orderData, printType } = req.body;
        
        logger.info(`printerId: ${printerId}`);
        logger.info(`printType: ${printType}`);
        
        await this.printerManager.print(printerId, orderData, printType);
        
        res.json({ success: true, message: 'Pedido impresso!' });
      } catch (error) {
        logger.error('Erro ao imprimir:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Obter configurações
    this.app.get('/api/settings', (req, res) => {
      try {
        const settings = Settings.getAll();
        res.json({ success: true, settings });
      } catch (error) {
        logger.error('Erro ao obter configurações:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Salvar configuração de impressora
    this.app.post('/api/settings/printer', (req, res) => {
      try {
        const { type, printerId } = req.body;
        
        if (!type) {
          return res.status(400).json({ success: false, error: 'Tipo obrigatório (default, kitchen, counter, delivery)' });
        }
        
        Settings.setPrinterForType(type, printerId);
        logger.info(`Impressora configurada: ${type} -> ${printerId}`);
        res.json({ success: true, message: 'Configuração salva' });
      } catch (error) {
        logger.error('Erro ao salvar configuração:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Obter impressora configurada para um tipo
    this.app.get('/api/settings/printer/:type', (req, res) => {
      try {
        const printerId = Settings.getPrinterForType(req.params.type);
        res.json({ success: true, printerId });
      } catch (error) {
        logger.error('Erro ao obter configuração:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
  }

  setupWebSocket() {
    this.wss.on('connection', (ws) => {
      logger.info('Nova conexão WebSocket');
      
      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message.toString());
          
          if (data.type === 'PRINT_ORDER') {
            await this.printerManager.print(data.printerId, data.orderData, data.printType);
            ws.send(JSON.stringify({ type: 'SUCCESS', message: 'Pedido impresso!' }));
          }
        } catch (error) {
          logger.error('Erro WebSocket:', error);
          ws.send(JSON.stringify({ type: 'ERROR', message: error.message }));
        }
      });
    });
  }

  start() {
    this.setupMiddleware();
    this.setupRoutes();
    this.server = http.createServer(this.app);
    this.wss = new WebSocket.Server({ server: this.server });
    this.setupWebSocket();
    
    this.server.listen(this.port, () => {
      logger.info(`Servidor rodando na porta ${this.port}`);
      logger.info(`REST API: http://localhost:${this.port}/api`);
      logger.info(`WebSocket: ws://localhost:${this.port}`);
    });
  }

  stop() {
    if (this.wss) {
      this.wss.clients.forEach(client => client.close());
      this.wss.close();
    }
    if (this.server) {
      this.server.close(() => {
        logger.info('Servidor encerrado');
      });
    }
  }
}

module.exports = Server;
