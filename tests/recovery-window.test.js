// A recuperacao periodica do Hub precisa olhar os ultimos 5 minutos. Antes, a
// janela partia do lastSeenAt, que o heartbeat renova a cada 15s: a rede de
// seguranca so via pedidos dos ultimos ~25s e um evento Realtime perdido virava
// comanda perdida. Primeiro pareamento continua sem imprimir backlog.
//
// Rodar: node tests/recovery-window.test.js
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

function makeListener({ lastSeenAt, recoveryFloorAt }) {
  const listener = new PairedPrintListener(null, {
    adminClientId: 'store-1',
    pairingStore: {
      getPairing: () => ({ adminClientId: 'store-1', enabled: true, lastSeenAt }),
      savePairing: () => {},
      updatePairing: () => {},
      clearPairing: () => {}
    }
  });
  listener.currentPairing = { adminClientId: 'store-1', lastSeenAt };
  listener.recoveryFloorAt = recoveryFloorAt;
  listener.printSettings = { ...listener.printSettings, autoPrintEnabled: true, autoPrintOnAcceptEnabled: false };
  listener.touchHeartbeat = () => {};
  const sinceValues = [];
  const query = {
    select: () => query,
    eq: () => query,
    gte: (_column, value) => { sinceValues.push(value); return query; },
    order: () => query,
    limit: async () => ({ data: [], error: null })
  };
  listener.supabase = { from: () => query };
  return { listener, sinceValues };
}

(async () => {
  console.log('--- recovery window ---');
  const now = Date.now();

  await test('recuperacao periodica olha 5 min mesmo com heartbeat recente', async () => {
    const { listener, sinceValues } = makeListener({
      lastSeenAt: new Date(now - 5000).toISOString(),
      recoveryFloorAt: now - 60 * 60 * 1000
    });
    await listener.recoverMissedOrders({ forceLookbackMs: 30 * 60 * 1000 });
    const sinceMs = Date.parse(sinceValues[0]);
    const lookbackMs = Date.now() - sinceMs;
    assert.ok(lookbackMs >= 4.9 * 60 * 1000 && lookbackMs <= 5.1 * 60 * 1000, `janela de ${Math.round(lookbackMs / 1000)}s`);
  });

  await test('primeiro pareamento nao recupera pedidos de antes da sessao', async () => {
    const floor = now - 20 * 1000;
    const { listener, sinceValues } = makeListener({ lastSeenAt: null, recoveryFloorAt: floor });
    await listener.recoverMissedOrders({ forceLookbackMs: 30 * 60 * 1000 });
    assert.strictEqual(Date.parse(sinceValues[0]), floor);
  });

  await test('reinicio recupera o tempo desligado, limitado a 5 min', async () => {
    const { listener, sinceValues } = makeListener({
      lastSeenAt: new Date(now - 2 * 60 * 1000).toISOString(),
      recoveryFloorAt: now - 2 * 60 * 1000 - 10000
    });
    await listener.recoverMissedOrders();
    assert.strictEqual(Date.parse(sinceValues[0]), now - 2 * 60 * 1000 - 10000);
  });

  await test('reserva perdida: tenta de novo e so desiste depois de 90s', async () => {
    const originalGetStorePrinters = Settings.getStorePrinters;
    Settings.getStorePrinters = () => null;
    try {
      const { listener } = makeListener({ lastSeenAt: null, recoveryFloorAt: now });
      listener.printSettings.autoPrintRoutes = ['counter'];
      listener.hasPendingRoutePrintJob = async () => false;
      let claims = 0;
      listener.claimAutoPrintLedger = async () => { claims += 1; return null; };
      listener.printWithRouting = async () => { throw new Error('nao deveria imprimir'); };
      const order = { id: 'order-9', order_number: 9 };

      await listener.handleAutoPrintOrder(order, 'realtime_insert');
      assert.strictEqual(listener.processedOrderIds.has('order-9'), false);
      await listener.handleAutoPrintOrder(order, 'recovery');
      assert.strictEqual(listener.processedOrderIds.has('order-9'), false, 'antes de 90s continua tentando');

      listener.lostClaimSince.set('order-9', Date.now() - 91 * 1000);
      await listener.handleAutoPrintOrder(order, 'recovery');
      assert.strictEqual(listener.processedOrderIds.has('order-9'), true, 'depois de 90s o outro aparelho imprimiu');
      assert.strictEqual(claims, 3);
    } finally {
      Settings.getStorePrinters = originalGetStorePrinters;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
