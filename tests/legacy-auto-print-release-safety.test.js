// Verifies a failed legacy claim release remains conservative and avoids reconnect.
//
// Run: node tests/legacy-auto-print-release-safety.test.js

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

(async () => {
  const originalGetStorePrinters = Settings.getStorePrinters;
  try {
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
      autoPrintRoutes: ['counter']
    };
    listener.hasPrintJobWithStatuses = async () => false;
    listener.claimAutoPrintLedger = async () => ({ id: 'claim-counter' });
    const printError = new Error('socket closed');
    listener.printWithRouting = async () => {
      throw printError;
    };
    listener.runPrintActionWithRetry = async (action) => action();
    let releaseCalls = 0;
    listener.releaseAutoPrintLedger = async () => {
      releaseCalls += 1;
      throw new Error('ledger delete failed');
    };
    const reconnects = [];
    listener.scheduleReconnect = (error) => reconnects.push(error);
    Settings.getStorePrinters = () => null;

    const result = await listener.handleAutoPrintOrder({
      id: 'order-release-failure',
      created_at: new Date().toISOString()
    }, 'realtime_insert');

    assert.equal(releaseCalls, 2);
    assert.equal(reconnects.length, 0);
    assert.equal(result.outcome, 'attention');
    assert.ok(result.error instanceof AggregateError);
    assert.equal(result.error.printError, printError);
  } finally {
    Settings.getStorePrinters = originalGetStorePrinters;
    Module._load = originalLoad;
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
