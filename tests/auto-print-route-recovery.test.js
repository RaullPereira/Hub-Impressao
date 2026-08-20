// Verifies a temporarily unavailable configured route remains eligible for recovery.
//
// Run: node tests/auto-print-route-recovery.test.js

const assert = require('node:assert/strict');
const os = require('os');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir() } };
  return originalLoad.call(this, request, parent, isMain);
};

const PairedPrintListener = require('../src/main/supabase/paired-print-listener');
const Settings = require('../src/main/config/settings');

function makeListener() {
  const printed = [];
  const claims = new Set();
  const listener = new PairedPrintListener({
    refreshPrinters: async () => {},
    print: async (job) => {
      printed.push(job.printType);
    }
  }, {
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
    autoPrintRoutes: ['kitchen', 'counter']
  };
  listener.fetchRenderedPayloads = async (_orderId, printTypes) => Object.fromEntries(
    printTypes.map((printType) => [printType, { rawContent: printType, encoding: 'base64' }])
  );
  listener.claimAutoPrintLedger = async (_orderId, via) => {
    if (claims.has(via)) return null;
    claims.add(via);
    return { id: `claim-${via}` };
  };
  listener.runPrintActionWithRetry = async (action) => action();

  return { listener, printed };
}

(async () => {
  const originalGetStorePrinters = Settings.getStorePrinters;
  try {
    const { listener, printed } = makeListener();
    const order = {
      id: 'order-partial-availability',
      order_number: 1001,
      order_type: 'delivery',
      created_at: new Date().toISOString()
    };
    let kitchenAvailable = false;
    listener.resolveAutoPrintPrinterId = async (route) => {
      if (route === 'kitchen') return kitchenAvailable ? 'Kitchen' : null;
      return 'Attendance';
    };
    Settings.getStorePrinters = () => ({
      autoPrint: { kitchen: 'Kitchen', attendance: 'Attendance' }
    });

    const settlements = [];
    const intentBatches = [
      [{ id: 'intent-retry', order_id: order.id, lease_token: 'lease-retry', attempt_count: 2 }],
      [{ id: 'intent-attention', order_id: order.id, lease_token: 'lease-attention', attempt_count: 3 }]
    ];
    listener.autoPrintIntentClient = {
      claim: async () => intentBatches.shift() || [],
      settle: async (id, leaseToken, outcome, lastError) => {
        settlements.push({ id, leaseToken, outcome, lastError });
      }
    };
    listener.loadOrderById = async () => order;

    await listener.processAutoPrintIntents();

    assert.deepEqual(settlements, [{
      id: 'intent-retry',
      leaseToken: 'lease-retry',
      outcome: 'retry',
      lastError: null
    }]);
    assert.equal(listener.processedOrderIds.has(order.id), false);
    assert.deepEqual(printed, ['counter']);

    await listener.processAutoPrintIntents();

    assert.equal(settlements[1].outcome, 'attention');
    assert.deepEqual(printed, ['counter'], 'the ledger skips the route already printed on retries');

    kitchenAvailable = true;
    listener.currentPairing.lastSeenAt = new Date(Date.now() - 60_000).toISOString();
    listener.supabase = {
      from(table) {
        assert.equal(table, 'orders');
        const query = {
          select: () => query,
          eq: () => query,
          gte: () => query,
          lte: () => query,
          or: () => query,
          order: () => query,
          limit: async () => ({ data: [order], error: null })
        };
        return query;
      }
    };

    await listener.recoverMissedOrders();

    assert.deepEqual(printed, ['counter', 'kitchen']);
    assert.equal(listener.processedOrderIds.has(order.id), true);
  } finally {
    Settings.getStorePrinters = originalGetStorePrinters;
    Module._load = originalLoad;
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
