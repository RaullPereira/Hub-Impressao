// Computador da impressao automatica: com um computador escolhido no painel,
// so o Hub dele reserva e imprime. Os outros Hubs (ex.: notebook com driver da
// impressora, mas sem o USB) nao reservam a comanda e recusam auto-print local.
//
// Rodar: node tests/auto-print-station.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-station-'));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => userData } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const Settings = require('../src/main/config/settings');
const PairedPrintListener = require('../src/main/supabase/paired-print-listener');
const MultiPairedPrintListener = require('../src/main/supabase/multi-paired-print-listener');

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

function makeListener(station) {
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
  listener.printSettings = {
    ...listener.printSettings,
    autoPrintEnabled: true,
    autoPrintOnAcceptEnabled: false,
    autoPrintRoutes: ['counter'],
    autoPrintStation: station
  };
  listener.touchHeartbeat = () => {};
  return listener;
}

(async () => {
  console.log('--- auto print station ---');
  const ownId = Settings.getStationId();

  await test('id do Hub e gerado uma vez e fica salvo', async () => {
    assert.match(ownId, /^hub:[A-Za-z0-9-]{8,}$/);
    Settings.resetCacheForTests();
    assert.strictEqual(Settings.getStationId(), ownId);
  });

  await test('sem computador escolhido o Hub imprime como antes', async () => {
    const listener = makeListener(null);
    let claims = 0;
    listener.hasPendingRoutePrintJob = async () => false;
    listener.claimAutoPrintLedger = async () => { claims += 1; return { id: 'c1' }; };
    listener.printWithRouting = async () => {};
    const originalGetStorePrinters = Settings.getStorePrinters;
    Settings.getStorePrinters = () => null;
    try {
      await listener.handleAutoPrintOrder({ id: 'o1', order_number: 1 }, 'realtime_insert');
    } finally {
      Settings.getStorePrinters = originalGetStorePrinters;
    }
    assert.strictEqual(claims, 1);
    assert.strictEqual(listener.getStatus().isAutoPrintStation, true);
    assert.strictEqual(listener.getStatus().stationId, ownId);
  });

  await test('Hub que nao e o escolhido nao reserva nem marca o pedido', async () => {
    const listener = makeListener({ browserId: 'browser:caixa', hubStationId: 'hub:outro-computador', label: 'CAIXA' });
    let claims = 0;
    listener.claimAutoPrintLedger = async () => { claims += 1; return { id: 'c1' }; };
    await listener.handleAutoPrintOrder({ id: 'o2', order_number: 2 }, 'realtime_insert');
    assert.strictEqual(claims, 0);
    assert.strictEqual(listener.processedOrderIds.has('o2'), false);
    const status = listener.getStatus();
    assert.strictEqual(status.isAutoPrintStation, false);
    assert.strictEqual(status.autoPrintStationLabel, 'CAIXA');
  });

  await test('escolha so do navegador (sem id de Hub) nao bloqueia o Hub', async () => {
    const listener = makeListener({ browserId: 'browser:caixa', hubStationId: null, label: 'Navegador (Windows)' });
    assert.strictEqual(listener.isAutoPrintStation(), true);
    const multi = new MultiPairedPrintListener(null);
    multi.listeners.set('store-1', listener);
    assert.strictEqual(multi.isStoreAutoPrintEnabled('store-1'), true);
  });

  await test('Hub escolhido imprime', async () => {
    const listener = makeListener({ browserId: 'browser:caixa', hubStationId: ownId, label: 'CAIXA' });
    let claims = 0;
    listener.hasPendingRoutePrintJob = async () => false;
    listener.claimAutoPrintLedger = async () => { claims += 1; return { id: 'c1' }; };
    listener.printWithRouting = async () => {};
    const originalGetStorePrinters = Settings.getStorePrinters;
    Settings.getStorePrinters = () => null;
    try {
      await listener.handleAutoPrintOrder({ id: 'o3', order_number: 3 }, 'realtime_insert');
    } finally {
      Settings.getStorePrinters = originalGetStorePrinters;
    }
    assert.strictEqual(claims, 1);
  });

  await test('fila de print_jobs fica so com o computador escolhido', async () => {
    const listener = makeListener({ browserId: 'browser:caixa', hubStationId: 'hub:outro-computador', label: 'CAIXA' });
    listener.supabase = {};
    listener.refreshPrintSettings = async () => {};
    let claimed = 0;
    listener.claimPrintJob = async () => { claimed += 1; return { id: 'job-1' }; };
    listener.updatePrintJobStatus = async () => { throw new Error('nao deveria mexer no job'); };
    await listener.processPrintJob({ id: 'job-1', order_id: 'o4', printer_type: 'counter', status: 'pending', created_at: new Date().toISOString(), content: { trigger: 'kds_station' } }, 'realtime_insert');
    assert.strictEqual(claimed, 0);
  });

  await test('impressao automatica pelo WebSocket local e recusada no Hub nao escolhido', async () => {
    const multi = new MultiPairedPrintListener(null);
    const listener = makeListener({ browserId: 'browser:caixa', hubStationId: 'hub:outro-computador', label: 'CAIXA' });
    multi.listeners.set('store-1', listener);
    assert.strictEqual(multi.isStoreAutoPrintEnabled('store-1'), false);
    listener.printSettings.autoPrintStation = null;
    assert.strictEqual(multi.isStoreAutoPrintEnabled('store-1'), true);
  });

  await test('le o computador escolhido de print_settings', async () => {
    const listener = makeListener(null);
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: { auto_print_enabled: true, auto_print_station: { browserId: 'browser:caixa', hubStationId: ownId, label: 'CAIXA' } }, error: null })
    };
    listener.supabase = { from: () => query };
    await listener.refreshPrintSettings();
    assert.deepStrictEqual(listener.printSettings.autoPrintStation, { browserId: 'browser:caixa', hubStationId: ownId, label: 'CAIXA' });
    assert.strictEqual(listener.isAutoPrintStation(), true);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(userData, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
})();
