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

    // Log all requests
    this.app.use((req, res, next) => {
      logger.info(`[HTTP] ${req.method} ${req.url} - IP: ${req.ip}`);
      next();
    });
  }

  setupRoutes() {
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Listar impressoras
    this.app.get('/api/printers', (req, res) => {
      try {
        const printers = this.printerManager.getPrinters();
        res.json({ success: true, printers });
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

    // Dispatch de impressão (respeita configuração printChannel)
    this.app.post('/api/print/dispatch', async (req, res) => {
      try {
        const { printerId, orderData, printType } = req.body;
        const settings = Settings.getAll();

        logger.info(`Dispatch print - channel=${settings.printChannel}`);

        if (!settings.printChannel || settings.printChannel === 'local') {
          // Imprime localmente
          await this.printerManager.print(printerId, orderData, printType);
          return res.json({ success: true, message: 'Impressão local enviada' });
        }

        if (settings.printChannel === 'qz') {
          if (!settings.qzEndpoint) {
            return res.status(400).json({ success: false, error: 'qzEndpoint não configurado' });
          }

          // Forward to QZ Tray / external endpoint
          try {
            const response = await fetch(settings.qzEndpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ printerId, orderData, printType })
            });

            const body = await response.json().catch(() => null);
            if (!response.ok) {
              throw new Error(body?.error || `Falha ao encaminhar para QZ (${response.status})`);
            }

            return res.json({ success: true, message: 'Encaminhado para QZ', response: body });
          } catch (err) {
            logger.error('Erro ao encaminhar para QZ:', err);
            return res.status(500).json({ success: false, error: err.message });
          }
        }

        return res.status(400).json({ success: false, error: 'printChannel inválido' });
      } catch (error) {
        logger.error('Erro no dispatch de impressão:', error);
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

    // Atualizar configurações (patch parcial)
    this.app.post('/api/settings', (req, res) => {
      try {
        const incoming = req.body || {};
        const current = Settings.getAll();

        const merged = Object.assign({}, current, incoming);
        // Merge printers separately to avoid overwriting unintentionally
        if (incoming.printers) {
          merged.printers = Object.assign({}, current.printers || {}, incoming.printers);
        }

        const ok = Settings.save(merged);
        if (ok) return res.json({ success: true, settings: merged });
        return res.status(500).json({ success: false, error: 'Falha ao salvar configurações' });
      } catch (error) {
        logger.error('Erro ao salvar configurações:', error);
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
