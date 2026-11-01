// Executa os handlers reais sem acessar impressora física ou Supabase.
const assert = require('node:assert/strict');
const os = require('node:os');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir() } };
  return originalLoad.call(this, request, parent, isMain);
};
const Server = require('../src/main/server');
const wsServer = require('../src/main/websocket/secure-server');
const MultiPairedPrintListener = require('../src/main/supabase/multi-paired-print-listener');
const Settings = require('../src/main/config/settings');

(async () => {
  const printed = [];
  const listener = new MultiPairedPrintListener(null);
  listener.getStatus = (id) => ({ paired: id === 'store-1', adminClientId: id, autoPrintEnabled: false });
  listener.isStoreAutoPrintEnabled = () => false;
  const manager = { async print(job) { printed.push(job); } };
  Settings.getAll = () => ({ printChannel: 'local' });
  const server = new Server(manager, listener);
  server.setupMiddleware();
  server.setupRoutes();
  const httpServer = await new Promise(resolve => {
    const instance = server.app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  wsServer.printerManager = manager;
  wsServer.pairedPrintListener = listener;

  let legacyMessage;
  const legacyReplies = [];
  server.wss = { on(_name, connection) {
    connection({ on(name, handler) { if (name === 'message') legacyMessage = handler; },
      send(value) { legacyReplies.push(JSON.parse(value)); } });
  } };
  server.setupWebSocket();

  try {
    for (const transport of ['http', 'dispatch', 'secure-ws', 'legacy-ws']) {
      for (const scenario of [
        { name: 'manual explícito', isAutoPrint: false, store: 'store-1', allowed: true },
        { name: 'manual legado', isAutoPrint: undefined, store: 'store-1', allowed: true },
        { name: 'automático desligado', isAutoPrint: true, store: 'store-1', allowed: false },
        { name: 'loja não pareada', isAutoPrint: false, store: 'other-store', allowed: false },
      ]) {
        const before = printed.length;
        const payload = {
          type: 'PRINT_ORDER', printer: 'Caixa', printerId: 'Caixa', printType: 'counter',
          isAutoPrint: scenario.isAutoPrint, useRawContent: true,
          rawContent: Buffer.from('Comanda manual').toString('base64'),
          orderData: { id: 'order-1', admin_client_id: scenario.store },
        };
        let success;
        if (transport === 'http' || transport === 'dispatch') {
          const response = await fetch(`${baseUrl}/api/print${transport === 'dispatch' ? '/dispatch' : ''}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
          });
          assert.equal(response.status, scenario.allowed ? 200 : 409);
          success = (await response.json()).success;
        } else if (transport === 'secure-ws') {
          const replies = [];
          await wsServer.handlePrint({ send(value) { replies.push(JSON.parse(value)); } }, payload);
          success = replies.at(-1).success;
        } else {
          await legacyMessage(Buffer.from(JSON.stringify(payload)));
          success = legacyReplies.at(-1).type !== 'ERROR';
        }
        assert.equal(success, scenario.allowed, `${transport}: ${scenario.name}`);
        assert.equal(printed.length - before, scenario.allowed ? 1 : 0, `${transport}: quantidade`);
        if (scenario.allowed) {
          assert.equal(printed.at(-1).printer, 'Caixa');
          assert.equal(printed.at(-1).orderData.admin_client_id, 'store-1');
        }
        console.log(`ok ${transport}: ${scenario.name}`);
      }
    }
  } finally {
    await new Promise(resolve => httpServer.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
