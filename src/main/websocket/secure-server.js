
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const logger = require('../utils/logger');

class SecureWebSocketServer {
  constructor() {
    this.wss = null;
    this.server = null;
    this.clients = new Set();
    this.token = this.generateToken();
  }

  /**
   * Gera um token de segurança único
   */
  generateToken() {
    // Token fixo para facilitar o desenvolvimento
    return '123456';
  }

  /**
   * Inicia o servidor WebSocket seguro (WSS)
   */
  /**
   * Inicia o servidor WebSocket seguro (WSS)
   */
  start(port = 3002, printerManager) {
    try {
      this.printerManager = printerManager;
      // Criar WebSocket Server simples (sem SSL)
      this.wss = new WebSocketServer({ port });

      this.wss.on('connection', (ws, req) => {
        logger.info(`Nova conexão WebSocket de ${req.socket.remoteAddress}`);
        this.clients.add(ws);

        ws.on('message', (message) => {
          this.handleMessage(ws, message);
        });

        ws.on('close', () => {
          logger.info('Cliente WebSocket desconectado');
          this.clients.delete(ws);
        });

        ws.on('error', (error) => {
          logger.error('Erro no WebSocket:', error);
          this.clients.delete(ws);
        });

        // Enviar token ao conectar (handshake)
        ws.send(JSON.stringify({
          type: 'connected',
          message: 'Conectado ao serviço de impressão',
          version: '1.0.0'
        }));
      });

      logger.info(`Servidor WebSocket rodando em ws://localhost:${port}`);
      logger.info(`Token de segurança: ${this.token}`);

    } catch (error) {
      logger.error('Erro ao iniciar servidor WebSocket:', error);
      throw error;
    }
  }

  /**
   * Processa mensagens recebidas do cliente
   */
  async handleMessage(ws, message) {
    try {
      const data = JSON.parse(message.toString());
      logger.info('Mensagem recebida via WebSocket:', { raw: message.toString(), json: data });
      logger.info(`Tipo de mensagem recebida: ${data.type}`);

      // Novo: Listar impressoras (garante refresh antes de responder)
      if (data.type === 'list-printers') {
        try {
          // Use the injected manager
          let printers = [];
          if (this.printerManager) {
            try { await this.printerManager.refreshPrinters(); } catch (e) { logger.warn('refreshPrinters falhou no WS:', e && e.message ? e.message : e); }
            printers = this.printerManager.getPrinters();
          } else {
            // Fallback minimal
            logger.warn('PrinterManager não injetado no WebSocketServer');
          }
          ws.send(JSON.stringify({ type: 'printers-list', printers }));
        } catch (err) {
          logger.error('Erro ao listar impressoras:', err);
          ws.send(JSON.stringify({ type: 'printers-list', error: err.message }));
        }
        return;
      }

      // Validar token de segurança
      if (data.token !== this.token) {
        logger.warn('Tentativa de acesso com token inválido');
        ws.send(JSON.stringify({
          success: false,
          error: 'Token de segurança inválido'
        }));
        return;
      }

      // Processar comando
      switch (data.type) {
        case 'print':
          await this.handlePrint(ws, data);
          break;
        case 'test':
          await this.handleTest(ws, data);
          break;
        case 'list-printers':
          await this.handleListPrinters(ws);
          break;
        default:
          ws.send(JSON.stringify({
            success: false,
            error: 'Tipo de comando desconhecido'
          }));
      }
    } catch (error) {
      logger.error('Erro ao processar mensagem:', error);
      ws.send(JSON.stringify({
        success: false,
        error: error.message
      }));
    }
  }

  /**
   * Processa comando de impressão
   */
  async handlePrint(ws, data) {
    const { orderData, printer, printType, rawContent } = data;
    if (!printer || typeof printer !== 'string' || printer.trim() === '') {
      ws.send(JSON.stringify({
        success: false,
        error: "Campo 'printer' não informado ou vazio. Informe o nome exato da impressora."
      }));
      logger.error("Campo 'printer' não informado ou vazio no comando de impressão.");
      return;
    }

    try {
      if (!this.printerManager) throw new Error('PrinterManager não disponível');

      const manager = this.printerManager;

      if (printer) {
        await manager.print({ printer, orderData, rawContent, printType });
      } else {
        // Usar primeira impressora disponível
        const printers = manager.getPrinters();
        if (printers.length === 0) {
          throw new Error('Nenhuma impressora disponível');
        }
        await manager.print({ printer: printers[0].id, orderData, printType });
      }

      ws.send(JSON.stringify({
        success: true,
        message: 'Pedido impresso com sucesso!'
      }));
    } catch (error) {
      logger.error('Erro ao imprimir:', error);
      ws.send(JSON.stringify({
        success: false,
        error: error.message
      }));
    }
  }

  /**
   * Processa comando de teste
   */
  async handleTest(ws, data) {
    const { printer } = data;

    try {
      if (!this.printerManager) throw new Error('PrinterManager não disponível');

      await this.printerManager.testPrint(printer);

      ws.send(JSON.stringify({
        success: true,
        message: 'Teste enviado!'
      }));
    } catch (error) {
      logger.error('Erro no teste:', error);
      ws.send(JSON.stringify({
        success: false,
        error: error.message
      }));
    }
  }

  /**
   * Lista impressoras disponíveis
   */
  async handleListPrinters(ws) {
    try {
      if (!this.printerManager) throw new Error('PrinterManager não disponível');

      const printers = this.printerManager.getPrinters();

      ws.send(JSON.stringify({
        success: true,
        printers
      }));
    } catch (error) {
      logger.error('Erro ao listar impressoras:', error);
      ws.send(JSON.stringify({
        success: false,
        error: error.message
      }));
    }
  }

  /**
   * Retorna o token de segurança
   */
  getToken() {
    return this.token;
  }

  /**
   * Para o servidor
   */
  stop() {
    if (this.wss) {
      this.wss.close();
      logger.info('Servidor WebSocket parado');
    }
    if (this.server) {
      this.server.close();
    }
  }
}

module.exports = new SecureWebSocketServer();
