const express = require('express');
const cors = require('cors');
const logger = require('./utils/logger');
const http = require('http');
const WebSocket = require('ws');
const Settings = require('./config/settings');
const fetchCompat = require('./utils/fetch');
const {
  getAutoPrintPrinterForRoute,
  getPrintTypeForRoute,
  normalizeAutoPrintMap,
  normalizeAutoPrintRoute,
  normalizeLegacyPrinterType
} = require('./print-routes');

function normalizePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
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

function resolveAutoPrintTarget(orderData, printType) {
  const adminClientId = getOrderAdminClientId(orderData);
  if (!adminClientId) {
    return { routedMode: false, route: normalizeAutoPrintRoute(printType), printer: null };
  }

  const storePrinters = Settings.getStorePrinters(adminClientId);
  const autoPrintMap = normalizeAutoPrintMap(storePrinters?.autoPrint || null);
  if (!autoPrintMap) {
    return { routedMode: false, route: normalizeAutoPrintRoute(printType), printer: null };
  }

  const route = normalizeAutoPrintRoute(printType);
  return {
    routedMode: true,
    route,
    printer: route ? getAutoPrintPrinterForRoute(autoPrintMap, route) : null
  };
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

function isStorePrintEnabled(pairedPrintListener, adminClientId, isAutoPrint) {
  if (!pairedPrintListener || !adminClientId || typeof pairedPrintListener.isStoreAutoPrintEnabled !== 'function') {
    return true;
  }

  // O botão manual depende do pareamento da loja, não da opção de autoimpressão.
  if (isAutoPrint !== true) {
    return typeof pairedPrintListener.isStoreManualPrintEnabled !== 'function'
      || pairedPrintListener.isStoreManualPrintEnabled(adminClientId);
  }

  return pairedPrintListener.isStoreAutoPrintEnabled(adminClientId);
}

class Server {
  constructor(printerManager, pairedPrintListener = null, options = {}) {
    this.printerManager = printerManager;
    this.pairedPrintListener = pairedPrintListener;
    this.app = express();
    this.server = null;
    this.wss = null;
    this.port = normalizePort(options.port ?? process.env.HUB_HTTP_PORT, 3001);
  }

  setupMiddleware() {
    this.app.use(cors({
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      optionsSuccessStatus: 204,
    }));
    this.app.use((req, res, next) => {
      const origin = req.headers.origin;
      const requestedHeaders = req.headers['access-control-request-headers'];
      const privateNetworkRequest = String(req.headers['access-control-request-private-network'] || '').toLowerCase() === 'true';

      res.setHeader('Access-Control-Allow-Origin', origin || '*');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        requestedHeaders || 'Content-Type, Authorization, X-Requested-With'
      );
      res.setHeader('Access-Control-Max-Age', '86400');

      if (privateNetworkRequest) {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }

      if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
      }

      next();
    });
    this.app.use(express.json());

    this.app.use((req, res, next) => {
      logger.info(`[HTTP] ${req.method} ${req.url} - IP: ${req.ip}`);
      next();
    });
  }

  setupRoutes() {
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    this.app.get('/api/printers', async (req, res) => {
      try {
        const isWindows = process.platform === 'win32';
        if (this.printerManager && this.printerManager.refreshPrinters) {
          try {
            await this.printerManager.refreshPrinters(isWindows);
          } catch (error) {
            logger.warn('refreshPrinters falhou ao listar impressoras:', error && error.message ? error.message : error);
          }
        }

        const printers = this.printerManager.getPrinters();
        const discoveredNames = new Set((printers || []).map((printer) => String(printer.name || printer.id || '').trim().toLowerCase()));
        const enriched = (printers || []).map((printer) => {
          const mapping = Settings.getUsbMapping(printer.id);
          return Object.assign({}, printer, { windowsMapping: mapping || null });
        });

        const manual = (Settings.getManualPrinters() || []).map((name) => ({
          id: name,
          name,
          type: 'manual',
          isDefault: false
        })).filter((printer) => !isWindows || discoveredNames.has(String(printer.name || '').trim().toLowerCase()));

        res.json({ success: true, printers: enriched.concat(manual) });
      } catch (error) {
        logger.error('Erro ao listar impressoras:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/printers/manual', (req, res) => {
      try {
        const { name } = req.body || {};
        if (!name || typeof name !== 'string' || name.trim() === '') {
          return res.status(400).json({ success: false, error: 'name é obrigatório' });
        }

        Settings.addManualPrinter(name.trim());
        res.json({ success: true });
      } catch (error) {
        logger.error('Erro ao adicionar impressora manual:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/printers/:id/test', async (req, res) => {
      const startedAt = Date.now();
      try {
        logger.info(`[PRINT] Teste iniciado printer=${req.params.id}`);
        await this.printerManager.testPrint(req.params.id);
        logger.info(`[PRINT] Teste concluído printer=${req.params.id} durationMs=${Date.now() - startedAt}`);
        res.json({ success: true, message: 'Teste enviado!' });
      } catch (error) {
        logger.error(`[PRINT] Teste falhou printer=${req.params.id} error=${error.message}`);
        res.status(500).json({ success: false, error: error.message });
      }
    });

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

    this.app.get('/api/printers/suggestions', async (req, res) => {
      try {
        const winSpool = require('./printer/win-spool');
        const pnp = await winSpool.listPnpDevices();
        const printers = this.printerManager.getPrinters();
        const usbPrinters = printers.filter((printer) => printer.type === 'usb');
        const suggestions = usbPrinters.map((printer) => {
          const vid = printer.vendorId ? printer.vendorId.toString(16).padStart(4, '0').toUpperCase() : null;
          const pid = printer.productId ? printer.productId.toString(16).padStart(4, '0').toUpperCase() : null;
          const search = vid && pid ? `VID_${vid}&PID_${pid}` : null;
          const matches = [];

          if (search) {
            for (const device of pnp) {
              try {
                const instanceId = (device.InstanceId || device.instanceId || '').toUpperCase();
                const friendlyName = (device.FriendlyName || device.friendlyName || '').toString();
                if (instanceId.includes(search)) {
                  matches.push({ instanceId, friendlyName });
                }
              } catch (error) {}
            }
          }

          return {
            usbId: printer.id,
            vendorId: printer.vendorId,
            productId: printer.productId,
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

    this.app.post('/api/printers/:id/map', (req, res) => {
      try {
        const usbId = req.params.id;
        const { windowsPrinter } = req.body;
        if (!windowsPrinter) {
          return res.status(400).json({ success: false, error: 'windowsPrinter é obrigatório' });
        }

        Settings.setUsbMapping(usbId, windowsPrinter);
        logger.info(`Mapeamento salvo: ${usbId} -> ${windowsPrinter}`);
        res.json({ success: true });
      } catch (error) {
        logger.error('Erro ao salvar mapeamento:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/print', async (req, res) => {
      const startedAt = Date.now();
      try {
        const { printerId, orderData, printType, rawContent, useRawContent, rawText, encoding, isAutoPrint } = req.body;
        const requestId = req.body?.requestId || `local-${Date.now()}`;
        const textLength = typeof orderData?.text === 'string' ? orderData.text.length : 0;
        const autoTarget = isAutoPrint === true && !hasExplicitPrinterId(printerId)
          ? resolveAutoPrintTarget(orderData, printType)
          : { routedMode: false, route: normalizeAutoPrintRoute(printType), printer: null };
        const resolvedPrinterId = autoTarget.routedMode
          ? autoTarget.printer
          : resolveConfiguredPrinterId(printerId, orderData, printType);
        const effectivePrintType = autoTarget.routedMode && autoTarget.route
          ? getPrintTypeForRoute(autoTarget.route)
          : printType;
        const adminClientId = getOrderAdminClientId(orderData);
        const orderId = orderData?.id || orderData?.orderId || null;

        logger.info(
          `[PRINT] Job recebido requestId=${requestId} printer=${resolvedPrinterId || printerId || 'auto'} type=${printType || 'default'} textLength=${textLength}`
        );

        if (!isStorePrintEnabled(this.pairedPrintListener, adminClientId, isAutoPrint)) {
          logger.info(`[PRINT] Job ignorado requestId=${requestId}: impressão desativada para loja ${adminClientId}`);
          return res.status(409).json({ success: false, error: 'Impressão desativada para esta loja' });
        }

        if (autoTarget.routedMode && !resolvedPrinterId) {
          logger.info(
            `[PRINT] Job ignorado requestId=${requestId}: sem impressora de auto-print para rota ${autoTarget.route || printType}`
          );
          return res.status(409).json({
            success: false,
            skipped: true,
            error: 'Sem impressora de auto-print configurada para esta rota'
          });
        }

        // Regra "imprimir somente ao aceitar": pedidos do cardápio digital que ainda
        // estão aguardando aceite não devem ser impressos na chegada.
        if (
          isAutoPrint === true &&
          this.pairedPrintListener &&
          adminClientId &&
          orderData &&
          typeof this.pairedPrintListener.shouldDeferOrderUntilAccept === 'function' &&
          this.pairedPrintListener.shouldDeferOrderUntilAccept(adminClientId, orderData)
        ) {
          logger.info(`[PRINT] Job adiado requestId=${requestId}: pedido #${orderData.order_number || orderId} do cardápio digital aguardando aceite.`);
          return res.status(409).json({
            success: false,
            deferred: true,
            error: 'Pedido do cardápio digital aguardando aceite. Impressão adiada até o aceite.'
          });
        }

        if (this.pairedPrintListener && adminClientId && orderId) {
          this.pairedPrintListener.notifyOrderPrintingViaWebSocket(adminClientId, orderId);
        }

        await this.printerManager.print({
          printer: resolvedPrinterId || printerId,
          orderData,
          printType: effectivePrintType,
          rawContent,
          rawText,
          encoding,
          useRawContent: useRawContent === true || Boolean(rawContent)
        });

        logger.info(
          `[PRINT] Job concluído requestId=${requestId} printer=${resolvedPrinterId || printerId || 'auto'} type=${printType || 'default'} durationMs=${Date.now() - startedAt}`
        );

        // Notificar PairedPrintListener para que o Realtime não reimprima o mesmo pedido
        if (this.pairedPrintListener && orderData) {
          if (adminClientId && orderId) {
            this.pairedPrintListener.notifyOrderPrintedViaWebSocket(adminClientId, orderId);
          }
        }

        res.json({ success: true, message: 'Pedido impresso!' });
      } catch (error) {
        if (this.pairedPrintListener) {
          const adminClientId = getOrderAdminClientId(req.body?.orderData);
          const orderId = req.body?.orderData?.id || req.body?.orderData?.orderId || null;
          if (adminClientId && orderId) {
            this.pairedPrintListener.notifyOrderPrintFailedViaWebSocket(adminClientId, orderId);
          }
        }
        logger.error(`[PRINT] Job falhou printer=${req.body?.printerId || 'auto'} error=${error.message}`);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/print/dispatch', async (req, res) => {
      try {
        const { printerId, orderData, printType, isAutoPrint } = req.body;
        const resolvedPrinterId = resolveConfiguredPrinterId(printerId, orderData, printType);
        const settings = Settings.getAll();
        const adminClientId = getOrderAdminClientId(orderData);
        const orderId = orderData?.id || orderData?.orderId || null;

        logger.info(`Dispatch print - channel=${settings.printChannel}`);

        if (!isStorePrintEnabled(this.pairedPrintListener, adminClientId, isAutoPrint)) {
          logger.info(`[PRINT] Dispatch ignorado: impressão desativada para loja ${adminClientId}`);
          return res.status(409).json({ success: false, error: 'Impressão desativada para esta loja' });
        }

        if (!settings.printChannel || settings.printChannel === 'local') {
          if (this.pairedPrintListener && adminClientId && orderId) {
            this.pairedPrintListener.notifyOrderPrintingViaWebSocket(adminClientId, orderId);
          }
          logger.info(`[PRINT] Dispatch local printer=${resolvedPrinterId || printerId || 'auto'} type=${printType || 'default'}`);
          await this.printerManager.print({ printer: resolvedPrinterId || printerId, orderData, printType });
          if (this.pairedPrintListener && adminClientId && orderId) {
            this.pairedPrintListener.notifyOrderPrintedViaWebSocket(adminClientId, orderId);
          }
          return res.json({ success: true, message: 'Impressão local enviada' });
        }

        if (settings.printChannel === 'qz') {
          if (!settings.qzEndpoint) {
            return res.status(400).json({ success: false, error: 'qzEndpoint não configurado' });
          }

          try {
            if (this.pairedPrintListener && adminClientId && orderId) {
              this.pairedPrintListener.notifyOrderPrintingViaWebSocket(adminClientId, orderId);
            }
            const response = await fetchCompat(settings.qzEndpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ printerId: resolvedPrinterId || printerId, orderData, printType })
            });

            const body = await response.json().catch(() => null);
            if (!response.ok) {
              throw new Error(body?.error || `Falha ao encaminhar para QZ (${response.status})`);
            }

            if (this.pairedPrintListener && adminClientId && orderId) {
              this.pairedPrintListener.notifyOrderPrintedViaWebSocket(adminClientId, orderId);
            }
            logger.info(`[PRINT] Dispatch QZ printer=${resolvedPrinterId || printerId || 'auto'} type=${printType || 'default'}`);
            return res.json({ success: true, message: 'Encaminhado para QZ', response: body });
          } catch (error) {
            if (this.pairedPrintListener && adminClientId && orderId) {
              this.pairedPrintListener.notifyOrderPrintFailedViaWebSocket(adminClientId, orderId);
            }
            logger.error('Erro ao encaminhar para QZ:', error);
            return res.status(500).json({ success: false, error: error.message });
          }
        }

        return res.status(400).json({ success: false, error: 'printChannel inválido' });
      } catch (error) {
        logger.error('Erro no dispatch de impressão:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/settings', (req, res) => {
      try {
        const settings = Settings.getAll();
        res.json({ success: true, settings });
      } catch (error) {
        logger.error('Erro ao obter configurações:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/logs', (req, res) => {
      try {
        const type = ['app', 'error', 'print'].includes(req.query.type)
          ? req.query.type
          : 'print';
        const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 1000);

        res.json({
          success: true,
          type,
          entries: logger.getRecentLogs({ type, limit }),
          files: {
            app: logger.getLogFilePath('app'),
            error: logger.getLogFilePath('error'),
            print: logger.getLogFilePath('print')
          }
        });
      } catch (error) {
        logger.error('Erro ao obter logs:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/pairing', (req, res) => {
      try {
        const adminClientId = typeof req.query.adminClientId === 'string' && req.query.adminClientId.trim()
          ? req.query.adminClientId.trim()
          : null;
        const pairing = this.pairedPrintListener
          ? this.pairedPrintListener.getStatus(adminClientId)
          : {
            paired: false,
            active: false,
            controlsAutoPrint: false,
            status: 'unavailable',
            adminClientId: null,
            userEmail: null,
            pairedAt: null,
            lastSeenAt: null,
            autoPrintEnabled: false,
            autoPrintType: 'counter',
            autoPrintOnAcceptEnabled: false,
            kdsReadyPrintEnabled: false,
            kdsReadyPrintRoutes: [],
            barPrintEnabled: false,
            lastError: 'Listener de pareamento indisponível'
          };

        res.json({
          success: true,
          pairing,
          pairings: Array.isArray(pairing?.pairings) ? pairing.pairings : undefined
        });
      } catch (error) {
        logger.error('Erro ao obter status de pareamento:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/pair', async (req, res) => {
      try {
        if (!this.pairedPrintListener) {
          return res.status(503).json({ success: false, error: 'Listener de pareamento indisponível' });
        }

        const body = Object.assign({}, req.body || {});
        const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';

        if (!body.appBaseUrl && requestOrigin && requestOrigin !== 'null') {
          body.appBaseUrl = requestOrigin;
        }

        const pairing = await this.pairedPrintListener.pair(body);
        logger.info(`[PAIRING] Serviço pareado com admin_client_id=${body.adminClientId || pairing.adminClientId || 'n/a'}`);
        res.json({ success: true, pairing });
      } catch (error) {
        logger.error('Erro ao parear serviço local:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/unpair', async (req, res) => {
      try {
        if (!this.pairedPrintListener) {
          return res.status(503).json({ success: false, error: 'Listener de pareamento indisponível' });
        }

        const adminClientId = typeof req.body?.adminClientId === 'string' && req.body.adminClientId.trim()
          ? req.body.adminClientId.trim()
          : null;
        const pairing = await this.pairedPrintListener.unpair(adminClientId);
        logger.info(
          adminClientId
            ? `[PAIRING] Loja ${adminClientId} desemparelhada por requisição local`
            : '[PAIRING] Todas as lojas foram desemparelhadas por requisição local'
        );
        res.json({ success: true, pairing });
      } catch (error) {
        logger.error('Erro ao desemparelhar serviço local:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/pairing/recover', async (req, res) => {
      try {
        if (!this.pairedPrintListener) {
          return res.status(503).json({ success: false, error: 'Listener de pareamento indisponível' });
        }

        const adminClientId = typeof req.body?.adminClientId === 'string' && req.body.adminClientId.trim()
          ? req.body.adminClientId.trim()
          : null;

        const pairing = await this.pairedPrintListener.recover(adminClientId, 'http-recover');
        logger.info(
          adminClientId
            ? `[PAIRING] Recuperação manual solicitada para a loja ${adminClientId}`
            : '[PAIRING] Recuperação manual solicitada para todas as lojas'
        );
        res.json({ success: true, pairing });
      } catch (error) {
        logger.error('Erro ao recuperar listeners de pareamento:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/settings', (req, res) => {
      try {
        const incoming = req.body || {};
        const current = Settings.getAll();
        const merged = Object.assign({}, current, incoming);

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

    this.app.post('/api/settings/printer', (req, res) => {
      try {
        const adminClientId = typeof req.body?.adminClientId === 'string' && req.body.adminClientId.trim()
          ? req.body.adminClientId.trim()
          : null;
        const hasPrintersPayload = req.body?.printers && typeof req.body.printers === 'object';

        if (adminClientId && hasPrintersPayload) {
          const printers = Settings.setStorePrinters(adminClientId, req.body.printers, { replace: true })
            ? Settings.getStorePrinters(adminClientId)
            : null;

          if (!printers) {
            return res.status(500).json({ success: false, error: 'Falha ao salvar impressoras da loja' });
          }

          logger.info(`[PAIRING] Impressoras sincronizadas para a loja ${adminClientId}`);
          return res.json({ success: true, message: 'Configuração por loja salva', adminClientId, printers });
        }

        if (!adminClientId && hasPrintersPayload) {
          const types = ['default', 'counter', 'kitchen', 'delivery', 'bar'];
          for (const printerType of types) {
            Settings.setPrinterForType(
              printerType,
              Object.prototype.hasOwnProperty.call(req.body.printers, printerType)
                ? req.body.printers[printerType]
                : null
            );
          }

          logger.info('Impressoras globais sincronizadas via payload completo');
          return res.json({ success: true, message: 'Configuração global salva', printers: Settings.getAll().printers });
        }

        const { type, printerId } = req.body;
        if (!type) {
          return res.status(400).json({
            success: false,
            error: 'Envie { adminClientId, printers } ou { type, printerId }'
          });
        }

        if (adminClientId) {
          const currentStorePrinters = Settings.getStorePrinters(adminClientId);
          currentStorePrinters[type] = typeof printerId === 'string' && printerId.trim()
            ? printerId.trim()
            : null;
          Settings.setStorePrinters(adminClientId, currentStorePrinters);
          logger.info(`Impressora da loja ${adminClientId} configurada: ${type} -> ${printerId}`);
          return res.json({
            success: true,
            message: 'Configuração por loja salva',
            adminClientId,
            printers: Settings.getStorePrinters(adminClientId)
          });
        }

        Settings.setPrinterForType(type, printerId);
        logger.info(`Impressora configurada: ${type} -> ${printerId}`);
        res.json({ success: true, message: 'Configuração global salva' });
      } catch (error) {
        logger.error('Erro ao salvar configuração:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/settings/printer/:type', (req, res) => {
      try {
        const adminClientId = typeof req.query.adminClientId === 'string' && req.query.adminClientId.trim()
          ? req.query.adminClientId.trim()
          : null;
        const printerId = adminClientId
          ? (Settings.getStorePrinters(adminClientId)?.[req.params.type] || Settings.getPrinterForType(req.params.type))
          : Settings.getPrinterForType(req.params.type);
        res.json({ success: true, printerId, adminClientId });
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
            const adminClientId = getOrderAdminClientId(data.orderData);
            const orderId = data.orderData?.id || data.orderData?.orderId || null;
            const autoTarget = data.isAutoPrint === true && !hasExplicitPrinterId(data.printerId)
              ? resolveAutoPrintTarget(data.orderData, data.printType)
              : { routedMode: false, route: normalizeAutoPrintRoute(data.printType), printer: null };
            const resolvedPrinterId = autoTarget.routedMode
              ? autoTarget.printer
              : resolveConfiguredPrinterId(data.printerId, data.orderData, data.printType);
            const effectivePrintType = autoTarget.routedMode && autoTarget.route
              ? getPrintTypeForRoute(autoTarget.route)
              : data.printType;

            logger.info(`[PRINT] WebSocket request printer=${resolvedPrinterId || data.printerId || 'auto'} type=${data.printType || 'default'}`);
            if (!isStorePrintEnabled(this.pairedPrintListener, adminClientId, data.isAutoPrint)) {
              logger.info(`[PRINT] WebSocket ignorado: impressão desativada para loja ${adminClientId}`);
              ws.send(JSON.stringify({ type: 'ERROR', message: 'Impressão desativada para esta loja' }));
              return;
            }

            if (autoTarget.routedMode && !resolvedPrinterId) {
              logger.info(`[PRINT] WebSocket ignorado: sem impressora de auto-print para rota ${autoTarget.route || data.printType}`);
              ws.send(JSON.stringify({
                type: 'SKIPPED',
                success: false,
                skipped: true,
                message: 'Sem impressora de auto-print configurada para esta rota'
              }));
              return;
            }

            if (this.pairedPrintListener && adminClientId && orderId) {
              this.pairedPrintListener.notifyOrderPrintingViaWebSocket(adminClientId, orderId);
            }

            await this.printerManager.print({
              printer: resolvedPrinterId || data.printerId,
              orderData: data.orderData,
              printType: effectivePrintType
            });

            if (this.pairedPrintListener && adminClientId && orderId) {
              this.pairedPrintListener.notifyOrderPrintedViaWebSocket(adminClientId, orderId);
            }
            ws.send(JSON.stringify({ type: 'SUCCESS', message: 'Pedido impresso!' }));
          }
        } catch (error) {
          const payload = (() => {
            try {
              return JSON.parse(message.toString());
            } catch (_) {
              return null;
            }
          })();
          const adminClientId = getOrderAdminClientId(payload?.orderData);
          const orderId = payload?.orderData?.id || payload?.orderData?.orderId || null;
          if (this.pairedPrintListener && adminClientId && orderId) {
            this.pairedPrintListener.notifyOrderPrintFailedViaWebSocket(adminClientId, orderId);
          }
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

    return new Promise((resolve, reject) => {
      const handleError = (error) => {
        this.server.off('listening', handleListening);
        logger.error(`Erro ao iniciar servidor HTTP na porta ${this.port}:`, error);
        reject(error);
      };

      const handleListening = () => {
        this.server.off('error', handleError);
        logger.info(`Servidor rodando na porta ${this.port}`);
        logger.info(`REST API: http://localhost:${this.port}/api`);
        logger.info(`WebSocket: ws://localhost:${this.port}`);
        resolve();
      };

      this.server.once('error', handleError);
      this.server.once('listening', handleListening);
      this.server.listen(this.port);
    });
  }

  stop() {
    if (this.wss) {
      this.wss.clients.forEach((client) => client.close());
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
