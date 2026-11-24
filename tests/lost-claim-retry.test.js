// Quando outro aparelho reserva a via antes do Hub (ex.: tablet com o painel
// aberto), o Hub nao pode desistir do pedido: se a reserva for liberada, a
// recuperacao precisa imprimir. E pedido explicito pendente (manual do celular
// ou coluna do KDS) nao pode bloquear a comanda automatica da chegada.
//
// Rodar: node tests/lost-claim-retry.test.js
const assert = require('assert');
const os = require('os');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const PairedPrintListener = require('../src/main/supabase/paired-print-listener');
const Settings = require('../src/main/config/settings');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

function makeListener() {
  const listener = new PairedPrintListener({ refreshPrinters: async () => {}, print: async () => {} }, {
    adminClientId: 'store-1',
    pairingStore: {
      getPairing: () => ({ adminClientId: 'store-1', enabled: true }),
      savePairing: () => {},
      updatePairing: () => {},
      clearPairing: () => {}
    }
  });
  listener.currentPairing = { adminClientId: 'store-1', appBaseUrl: 'http://localhost:3000' };
  listener.printSettings = {
    ...listener.printSettings,
    autoPrintEnabled: true,
    autoPrintOnAcceptEnabled: false,
    autoPrintRoutes: ['counter']
  };
  listener.runPrintActionWithRetry = async (action) => action();
  return listener;
}

function pendingJobsClient(jobs) {
  const query = {
    select: () => query,
    eq: () => query,
    limit: async () => ({ data: jobs, error: null })
  };
  return { from: () => query };
}

const order = { id: 'order-1', order_number: 45, order_type: 'delivery' };

(async () => {
  console.log('--- lost claim retry ---');
  const originalGetStorePrinters = Settings.getStorePrinters;

  try {
    await test('legacy: via reservada por outro aparelho nao marca o pedido como processado', async () => {
      Settings.getStorePrinters = () => null;
      const listener = makeListener();
      const prints = [];
      let claimAttempts = 0;
      listener.hasPendingRoutePrintJob = async () => false;
      listener.claimAutoPrintLedger = async () => {
        claimAttempts += 1;
        return claimAttempts === 1 ? null : { id: 'claim-counter' };
      };
      listener.printWithRouting = async (_orderId, printType) => { prints.push(printType); };

      await listener.handleAutoPrintOrder(order, 'realtime_insert');
      assert.strictEqual(listener.processedOrderIds.has(order.id), false);
      assert.deepStrictEqual(prints, []);

      // Outro aparelho falhou e soltou a reserva: a recuperacao imprime.
      await listener.handleAutoPrintOrder(order, 'recovery');
      assert.deepStrictEqual(prints, ['counter']);
      assert.strictEqual(listener.processedOrderIds.has(order.id), true);
    });

    await test('por impressora: via reservada por outro aparelho tenta de novo na recuperacao', async () => {
      Settings.getStorePrinters = () => ({ autoPrint: { attendance: 'Counter', counter: 'Counter', delivery: 'Counter' } });
      const listener = makeListener();
      const prints = [];
      let claimAttempts = 0;
      listener.resolveAutoPrintPrinterId = async () => 'Counter';
      listener.fetchRenderedPayloads = async (_orderId, types) => Object.fromEntries(
        types.map((type) => [type, { rawContent: Buffer.from(type).toString('base64'), encoding: 'base64', printType: type }])
      );
      listener.claimAutoPrintLedger = async () => {
        claimAttempts += 1;
        return claimAttempts === 1 ? null : { id: 'claim-attendance' };
      };
      listener.printRawPayload = async (_printerId, _payload, printType) => { prints.push(printType); };

      await listener.handleAutoPrintOrder(order, 'realtime_insert');
      assert.strictEqual(listener.processedOrderIds.has(order.id), false);
      assert.deepStrictEqual(prints, []);

      await listener.handleAutoPrintOrder(order, 'recovery');
      assert.strictEqual(prints.length, 1);
      assert.strictEqual(listener.processedOrderIds.has(order.id), true);
    });

    await test('pedido manual ou de coluna do KDS pendente nao bloqueia a comanda automatica', async () => {
      const listener = makeListener();
      listener.supabase = pendingJobsClient([
        { id: 'job-kds', content: { trigger: 'kds_station', station_id: 'forno' } },
        { id: 'job-ready', content: { trigger: 'kds_ready' } }
      ]);
      assert.strictEqual(await listener.hasPendingRoutePrintJob(order.id), false);
    });

    await test('job pendente da propria via continua bloqueando (a fila imprime)', async () => {
      const listener = makeListener();
      listener.supabase = pendingJobsClient([
        { id: 'job-kds', content: { trigger: 'kds_station' } },
        { id: 'job-route', content: { rawContent: 'abc' } }
      ]);
      assert.strictEqual(await listener.hasPendingRoutePrintJob(order.id), true);
    });
  } finally {
    Settings.getStorePrinters = originalGetStorePrinters;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
