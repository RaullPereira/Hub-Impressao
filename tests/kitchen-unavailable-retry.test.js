// Pizza & Cia (26/11): pedido de mesa saia so no balcao. A impressora da
// cozinha estava escolhida no automatico, mas fora naquele instante; a via era
// pulada sem reserva e o pedido ficava como processado. Agora a via conta como
// falha, o pedido volta para nova tentativa por ate 15 min (alem da janela de
// 5 min da recuperacao) e a cozinha sai uma vez so quando a impressora volta.
//
// Rodar: node tests/kitchen-unavailable-retry.test.js
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

const AUTO_PRINT_MAP = { kitchen: 'Cozinha', attendance: 'Caixa' };

function makeListener(order) {
  const listener = new PairedPrintListener(null, {
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
    autoPrintType: 'both',
    autoPrintRoutes: ['counter', 'kitchen']
  };
  listener.touchHeartbeat = () => {};
  listener.refreshPrintersIfNeeded = async () => {};
  listener.runPrintActionWithRetry = async (action) => action();
  listener.fetchRenderedPayloads = async () => ({
    kitchen: { rawContent: 'a2l0Y2hlbg==', encoding: 'base64' },
    counter: { rawContent: 'Y291bnRlcg==', encoding: 'base64' }
  });

  const state = { kitchenOnline: false, claims: new Set(), printed: [] };
  listener.resolveAutoPrintPrinterId = async (route) => {
    if (route === 'kitchen') return state.kitchenOnline ? 'Cozinha' : null;
    if (route === 'attendance') return 'Caixa';
    return null;
  };
  listener.claimAutoPrintLedger = async (_orderId, route) => {
    if (state.claims.has(route)) return null;
    state.claims.add(route);
    return { id: `claim-${route}` };
  };
  listener.releaseAutoPrintLedger = async (id) => {
    state.claims.delete(String(id).replace('claim-', ''));
  };
  listener.printRawPayload = async (printerId) => {
    state.printed.push(printerId);
  };

  const query = {
    select: () => query,
    eq: () => query,
    in: async () => ({ data: [order], error: null })
  };
  listener.supabase = { from: () => query };
  return { listener, state };
}

(async () => {
  const originalGetStorePrinters = Settings.getStorePrinters;
  Settings.getStorePrinters = () => ({ autoPrint: AUTO_PRINT_MAP });
  try {
    const order = {
      id: 'order-mesa-9',
      order_number: 9,
      order_type: 'mesa',
      status: 'awaiting',
      created_at: new Date().toISOString(),
      items: [{ name: 'Pizza', quantity: 1 }]
    };

    await test('cozinha fora: balcao imprime e o pedido fica para nova tentativa', async () => {
      const { listener, state } = makeListener(order);
      await listener.handleAutoPrintOrder(order, 'realtime_insert');
      assert.deepEqual(state.printed, ['Caixa']);
      assert.ok(!state.claims.has('kitchen'), 'cozinha nao pode ficar reservada sem papel');
      assert.ok(!listener.processedOrderIds.has(order.id), 'pedido nao pode virar processado');
      assert.ok(listener.failedViaRetry.has(order.id));
    });

    await test('cozinha volta depois de 5 min: sai so a cozinha, uma vez', async () => {
      const { listener, state } = makeListener(order);
      await listener.handleAutoPrintOrder(order, 'realtime_insert');
      // 8 minutos depois: fora da janela de 5 min da recuperacao comum.
      listener.failedViaRetry.set(order.id, Date.now() - 8 * 60 * 1000);
      state.kitchenOnline = true;
      await listener.retryFailedViaOrders();
      assert.deepEqual(state.printed, ['Caixa', 'Cozinha']);
      assert.ok(listener.processedOrderIds.has(order.id));
      assert.ok(!listener.failedViaRetry.has(order.id));
      await listener.retryFailedViaOrders();
      assert.deepEqual(state.printed, ['Caixa', 'Cozinha']);
    });

    await test('desiste depois de 15 min sem cozinha', async () => {
      const { listener, state } = makeListener(order);
      await listener.handleAutoPrintOrder(order, 'realtime_insert');
      listener.failedViaRetry.set(order.id, Date.now() - 16 * 60 * 1000);
      state.kitchenOnline = true;
      await listener.retryFailedViaOrders();
      assert.deepEqual(state.printed, ['Caixa']);
      assert.ok(!listener.failedViaRetry.has(order.id));
    });

    await test('pedido cancelado sai da lista de nova tentativa', async () => {
      const cancelled = { ...order, id: 'order-cancelado', status: 'canceled' };
      const { listener, state } = makeListener(cancelled);
      listener.failedViaRetry.set(cancelled.id, Date.now());
      state.kitchenOnline = true;
      await listener.retryFailedViaOrders();
      assert.deepEqual(state.printed, []);
      assert.ok(!listener.failedViaRetry.has(cancelled.id));
    });

    await test('render com "fetch failed" passageiro tenta de novo e imprime', async () => {
      const { listener, state } = makeListener(order);
      state.kitchenOnline = true;
      delete listener.runPrintActionWithRetry; // usa o retry real
      listener.ensureSessionFresh = async () => {};
      const realRender = listener.fetchRenderedPayloads;
      let renderCalls = 0;
      listener.fetchRenderedPayloads = async (...args) => {
        renderCalls += 1;
        if (renderCalls === 1) throw new TypeError('fetch failed');
        return realRender(...args);
      };
      await listener.handleAutoPrintOrder(order, 'realtime_insert');
      assert.equal(renderCalls, 2);
      assert.deepEqual(new Set(state.printed), new Set(['Caixa', 'Cozinha']));
      assert.ok(listener.processedOrderIds.has(order.id));
    });

    await test('impressora do automatico sumiu: usa a cozinha da loja, nunca a padrao', async () => {
      const listener = new PairedPrintListener(null, {
        adminClientId: 'store-1',
        pairingStore: {
          getPairing: () => ({ adminClientId: 'store-1', enabled: true }),
          savePairing: () => {},
          updatePairing: () => {},
          clearPairing: () => {}
        }
      });
      listener.currentPairing = { adminClientId: 'store-1' };
      const windows = new Set(['EPSON TM-T20 Cozinha', 'Caixa']);
      listener.printerManager = {
        resolveAvailablePrinterName: async (name) => (windows.has(name) ? name : null)
      };
      Settings.getStorePrinters = () => ({
        autoPrint: { kitchen: 'EPSON antiga', attendance: 'Caixa' },
        kitchen: 'EPSON TM-T20 Cozinha',
        default: 'Caixa'
      });
      assert.equal(await listener.resolveAutoPrintPrinterId('kitchen'), 'EPSON TM-T20 Cozinha');

      // Sem impressora de cozinha cadastrada: nao cai na padrao (Caixa).
      Settings.getStorePrinters = () => ({
        autoPrint: { kitchen: 'EPSON antiga', attendance: 'Caixa' },
        default: 'Caixa'
      });
      assert.equal(await listener.resolveAutoPrintPrinterId('kitchen'), null);
      Settings.getStorePrinters = () => ({ autoPrint: AUTO_PRINT_MAP });
    });

    await test('via sem impressora escolhida continua pulada sem erro', async () => {
      Settings.getStorePrinters = () => ({ autoPrint: { attendance: 'Caixa' } });
      const { listener, state } = makeListener(order);
      await listener.handleAutoPrintOrder(order, 'realtime_insert');
      assert.deepEqual(state.printed, ['Caixa']);
      assert.ok(listener.processedOrderIds.has(order.id));
      assert.ok(!listener.failedViaRetry.has(order.id));
      Settings.getStorePrinters = () => ({ autoPrint: AUTO_PRINT_MAP });
    });
  } finally {
    Settings.getStorePrinters = originalGetStorePrinters;
  }

  console.log(`\n${passed} passaram, ${failed} falharam`);
  process.exit(failed > 0 ? 1 : 0);
})();
