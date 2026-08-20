
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const Settings = require('../config/settings');
const logger = require('../utils/logger');
const {
  getAutoPrintPrinterForRoute,
  getPrintTypeForRoute,
  normalizeAutoPrintMap,
  normalizeAutoPrintRoute,
  normalizeLegacyPrinterType
} = require('../print-routes');

function getFirstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function getObjectValue(...values) {
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
  }

  return null;
}

function buildPlainTextRawContent(text) {
  const safeText = String(text || '').replace(/\r\n/g, '\n');
  const buffer = Buffer.concat([
    Buffer.from([0x1B, 0x40]),
    Buffer.from(`${safeText}\n\n\n`, 'latin1'),
    Buffer.from([0x1D, 0x56, 0x00])
  ]);

  return buffer.toString('base64');
}

function normalizePrintPayload(data) {
  const orderData = getObjectValue(data.orderData, data.order, data.payload);
  const directText = getFirstString(
    data.text,
    data.rawText,
    data.senha,
    data.password,
    data.ticket,
    data.ticketText,
    orderData && orderData.text
  );
  const hasRawContent = typeof data.rawContent === 'string' && data.rawContent.trim();
  const rawContent = hasRawContent ? data.rawContent.trim() : (directText ? buildPlainTextRawContent(directText) : data.rawContent);
  const normalizedOrderData = orderData || (directText ? { text: directText } : null);

  return {
    orderData: normalizedOrderData,
    printer: getFirstString(data.printer, data.printerId, data.printerName, data.impressora, data.impressoraId),
    printType: getFirstString(data.printType, data.typePrint, data.tipo) || 'counter',
    rawContent,
    useRawContent: data.useRawContent === true || data.type === 'print-raw' || Boolean(hasRawContent) || Boolean(directText),
    isAutoPrint: data.isAutoPrint === true
  };
}

function getOrderAdminClientId(orderData) {
  return typeof orderData?.admin_client_id === 'string' && orderData.admin_client_id.trim()
    ? orderData.admin_client_id.trim()
    : (typeof orderData?.adminClientId === 'string' && orderData.adminClientId.trim()
      ? orderData.adminClientId.trim()
      : null);
}

function normalizePrinterType(printType) {
  return printType === 'default'
    ? 'default'
    : normalizeLegacyPrinterType(printType);
}

function hasExplicitPrinterId(printerId) {
  return typeof printerId === 'string' && printerId.trim().length > 0;
}

function resolveConfiguredPrinterId(printerId, orderData, printType) {
  if (hasExplicitPrinterId(printerId)) {
    return printerId.trim();
  }

  const adminClientId = getOrderAdminClientId(orderData);
  const resolvedType = normalizePrinterType(printType);

  if (adminClientId) {
    const storePrinters = Settings.getStorePrinters(adminClientId);
    return storePrinters?.[resolvedType] || storePrinters?.default || null;
  }

  return Settings.getPrinterForType(resolvedType);
}

/**
 * Resolve o destino de impressão AUTOMÁTICA para a via solicitada.
 *
 * Lê exclusivamente o sub-mapa `autoPrint` da loja ({ kitchen, counter, delivery }),
 * sem fallback para `storePrinters.default` nem para a primeira impressora disponível.
 *
 * Retorna:
 *  - autoConfigured: true quando a loja tem o sub-mapa `autoPrint` (modo por-impressora);
 *    nesse caso `printer` é a impressora explícita da via ou null (via deve ser pulada).
 *  - autoConfigured: false quando não há sub-mapa `autoPrint` (modo legado) — o chamador
 *    deve manter o comportamento atual (`storePrinters[type] || storePrinters.default`).
 */
function resolveAutoPrintTarget(orderData, printType) {
  const adminClientId = getOrderAdminClientId(orderData);

  if (!adminClientId) {
    return { autoConfigured: false, route: normalizeAutoPrintRoute(printType), printer: null };
  }

  const storePrinters = Settings.getStorePrinters(adminClientId);
  const autoMap = normalizeAutoPrintMap(storePrinters && storePrinters.autoPrint ? storePrinters.autoPrint : null);

  if (!autoMap) {
    return { autoConfigured: false, route: normalizeAutoPrintRoute(printType), printer: null };
  }

  const route = normalizeAutoPrintRoute(printType);
  return {
    autoConfigured: true,
    route,
    printer: route ? getAutoPrintPrinterForRoute(autoMap, route) : null
  };
}

function isStorePrintEnabled(pairedPrintListener, adminClientId) {
  if (!pairedPrintListener || !adminClientId || typeof pairedPrintListener.isStoreAutoPrintEnabled !== 'function') {
    return true;
  }

  return pairedPrintListener.isStoreAutoPrintEnabled(adminClientId);
}

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
  start(port = 3002, printerManager, pairedPrintListener) {
    return new Promise((resolve, reject) => {
      try {
        this.printerManager = printerManager;
        this.pairedPrintListener = pairedPrintListener || null;
        // Criar WebSocket Server simples (sem SSL)
        this.wss = new WebSocketServer({ port });

        const handleStartupError = (error) => {
          this.wss.off('listening', handleListening);
          logger.error(`Erro ao iniciar servidor WebSocket na porta ${port}:`, error);
          reject(error);
        };

        const handleListening = () => {
          this.wss.off('error', handleStartupError);
          this.wss.on('error', (error) => {
            logger.error(`Erro no servidor WebSocket da porta ${port}:`, error);
          });
          logger.info(`Servidor WebSocket rodando em ws://localhost:${port}`);
          logger.info(`Token de segurança: ${this.token}`);
          resolve();
        };

        this.wss.once('error', handleStartupError);
        this.wss.once('listening', handleListening);

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
            version: '1.9.4'
          }));
        });
      } catch (error) {
        logger.error('Erro ao iniciar servidor WebSocket:', error);
        reject(error);
      }
    });
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
            try { await this.printerManager.refreshPrinters(process.platform === 'win32'); } catch (e) { logger.warn('refreshPrinters falhou no WS:', e && e.message ? e.message : e); }
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
        case 'PRINT':
        case 'print-raw':
        case 'print_order':
        case 'PRINT_ORDER':
        case 'printOrder':
        case 'local-print':
        case 'localPrint':
        case 'print-password':
        case 'printPassword':
        case 'print-senha':
        case 'printSenha':
        case 'PRINT_SENHA':
          await this.handlePrint(ws, data);
          break;
        case 'test':
        case 'test-print':
        case 'testPrint':
          await this.handleTest(ws, data);
          break;
        case 'list-printers':
        case 'listPrinters':
        case 'get-printers':
        case 'getPrinters':
          await this.handleListPrinters(ws);
          break;
        case 'sync-printers':
        case 'syncPrinters':
          await this.handleSyncPrinters(ws, data);
          break;
        case 'ping':
        case 'heartbeat':
          ws.send(JSON.stringify({ type: 'pong', success: true }));
          break;
        default:
          logger.warn(`Tipo de comando desconhecido recebido: ${data.type}`);
          logger.warn(`Dados completos: ${JSON.stringify(data)}`);
          ws.send(JSON.stringify({
            success: false,
            error: `Tipo de comando desconhecido: ${data.type}. Tipos suportados: print, print-raw, test, list-printers, sync-printers, ping`
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
    const { orderData, printer, printType, rawContent, useRawContent, isAutoPrint } = normalizePrintPayload(data);
    
    // Determina se deve usar rawContent diretamente
    const shouldUseRaw = useRawContent === true;
    
    logger.info(`[handlePrint] useRawContent: ${useRawContent}, type: ${data.type}, shouldUseRaw: ${shouldUseRaw}`);
    logger.info(`[handlePrint] rawContent presente: ${!!rawContent}, tamanho: ${rawContent ? rawContent.length : 0}`);

    try {
      if (!this.printerManager) throw new Error('PrinterManager não disponível');

      const manager = this.printerManager;
      const adminClientId = getOrderAdminClientId(orderData);
      const orderId = orderData?.id || orderData?.orderId || null;

      // Resolução de impressora: AUTO por-impressora (sem fallback) vs manual/legado.
      let selectedPrinter;
      let isPerPrinterAuto = false;
      let autoTarget = null;

      if (isAutoPrint && !hasExplicitPrinterId(printer)) {
        autoTarget = resolveAutoPrintTarget(orderData, printType);
        if (autoTarget.autoConfigured) {
          // AUTO por-impressora: resolve SOMENTE a partir do sub-mapa autoPrint da via,
          // sem cair em storePrinters.default nem na primeira impressora disponível.
          isPerPrinterAuto = true;
          selectedPrinter = autoTarget.printer;
        } else {
          // AUTO legado (sem sub-mapa autoPrint): mantém comportamento atual.
          selectedPrinter = resolveConfiguredPrinterId(printer, orderData, printType);
        }
      } else {
        // Impressão MANUAL: comportamento inalterado (default + primeira disponível).
        selectedPrinter = resolveConfiguredPrinterId(printer, orderData, printType);
      }

      if (!isStorePrintEnabled(this.pairedPrintListener, adminClientId)) {
        logger.info(`[handlePrint] Impressão desativada para loja ${adminClientId}. Pedido ignorado.`);
        ws.send(JSON.stringify({
          success: false,
          error: 'Impressão desativada para esta loja'
        }));
        return;
      }

      // Regra "imprimir somente ao aceitar": pedidos do cardápio digital que ainda
      // estão aguardando aceite NÃO devem ser impressos na chegada, mesmo quando o
      // PedidosHub dispara a impressão automática via WebSocket. A impressão só
      // ocorre quando o lojista aceita (transição de status tratada pelo Realtime).
      if (
        isAutoPrint &&
        this.pairedPrintListener &&
        adminClientId &&
        orderData &&
        typeof this.pairedPrintListener.shouldDeferOrderUntilAccept === 'function' &&
        this.pairedPrintListener.shouldDeferOrderUntilAccept(adminClientId, orderData)
      ) {
        logger.info(`[handlePrint] Pedido #${orderData.order_number || orderId} do cardápio digital aguardando aceite. Impressão adiada até o aceite.`);
        ws.send(JSON.stringify({
          success: false,
          deferred: true,
          error: 'Pedido do cardápio digital aguardando aceite. Impressão adiada até o aceite.'
        }));
        return;
      }

      // AUTO por-impressora: se não há impressora explícita para esta via, PULAR.
      // Não cair em storePrinters.default nem na primeira impressora disponível.
      if (isPerPrinterAuto && !selectedPrinter) {
        logger.info(`[handlePrint] Sem impressora auto configurada para a rota "${autoTarget?.route || printType}" (loja ${adminClientId}). Via ignorada.`);
        ws.send(JSON.stringify({
          success: false,
          skipped: true,
          message: 'Sem impressora auto configurada para a via'
        }));
        return;
      }

      if (this.pairedPrintListener && adminClientId && orderId) {
        this.pairedPrintListener.notifyOrderPrintingViaWebSocket(adminClientId, orderId);
      }

      if (!selectedPrinter) {
        // Fallback "primeira impressora disponível": somente impressão manual ou AUTO legado.
        // Nunca alcançado em AUTO por-impressora (a via já foi pulada acima).
        if (typeof manager.refreshPrinters === 'function') {
          try {
            await manager.refreshPrinters(process.platform === 'win32');
          } catch (error) {
            logger.warn('refreshPrinters falhou antes de imprimir via WS:', error && error.message ? error.message : error);
          }
        }

        // Usar primeira impressora disponível
        const printers = manager.getPrinters();
        if (printers.length === 0) {
          throw new Error('Nenhuma impressora disponível');
        }
        selectedPrinter = printers[0].id || printers[0].name;
      }

      if (!orderData && !rawContent) {
        throw new Error('Nenhum conteúdo para imprimir fornecido');
      }

      await manager.print({
        printer: selectedPrinter,
        orderData,
        rawContent,
        printType: isPerPrinterAuto && autoTarget?.route ? getPrintTypeForRoute(autoTarget.route) : printType,
        useRawContent: shouldUseRaw
      });

      // Notificar PairedPrintListener para que o Realtime não reimprima o mesmo pedido
      if (this.pairedPrintListener && orderData) {
        const adminClientId = orderData.admin_client_id || orderData.adminClientId;
        const orderId = orderData.id || orderData.orderId;
        if (adminClientId && orderId) {
          this.pairedPrintListener.notifyOrderPrintedViaWebSocket(adminClientId, orderId);
        }
      }

      ws.send(JSON.stringify({
        success: true,
        message: 'Pedido impresso com sucesso!'
      }));
    } catch (error) {
      const adminClientId = getOrderAdminClientId(orderData);
      const orderId = orderData?.id || orderData?.orderId || null;
      if (this.pairedPrintListener && adminClientId && orderId) {
        this.pairedPrintListener.notifyOrderPrintFailedViaWebSocket(adminClientId, orderId);
      }
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
    const printer = getFirstString(data.printer, data.printerId, data.printerName, data.impressora, data.impressoraId);

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

      if (typeof this.printerManager.refreshPrinters === 'function') {
        try {
          await this.printerManager.refreshPrinters(process.platform === 'win32');
        } catch (error) {
          logger.warn('refreshPrinters falhou ao listar impressoras via WS:', error && error.message ? error.message : error);
        }
      }

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
   * Sincroniza as impressoras configuradas pelo app PedidosHub
   * Payload: { type: 'sync-printers', token, storeId, printers: { default, counter, kitchen, delivery } }
   */
  async handleSyncPrinters(ws, data) {
    try {
      const { printers } = data;
      const storeId = getFirstString(data.storeId, data.store_id, data.adminClientId, data.admin_client_id);

      if (storeId && printers && typeof printers === 'object') {
        Settings.setStorePrinters(storeId, printers, { replace: true });
        logger.info(`[sync-printers] Impressoras da loja ${storeId} atualizadas:`, printers);
      } else if (printers && typeof printers === 'object') {
        // Fallback: salva como impressoras globais
        const types = ['default', 'counter', 'kitchen', 'delivery'];
        for (const t of types) {
          Settings.setPrinterForType(
            t,
            Object.prototype.hasOwnProperty.call(printers, t) ? printers[t] : null
          );
        }
        logger.info('[sync-printers] Impressoras globais atualizadas:', printers);
      } else {
        ws.send(JSON.stringify({ success: false, error: 'Payload inválido: printers ausente' }));
        return;
      }

      ws.send(JSON.stringify({ success: true, message: 'Impressoras sincronizadas' }));
    } catch (error) {
      logger.error('[sync-printers] Erro ao sincronizar impressoras:', error);
      ws.send(JSON.stringify({ success: false, error: error.message }));
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
