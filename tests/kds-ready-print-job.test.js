const assert = require('assert');
const Module = require('module');
const os = require('os');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }

  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  try {
    const PairedPrintListener = require('../src/main/supabase/paired-print-listener');
    const { shouldProcessQueuedPrintJob } = PairedPrintListener;

    const normalJob = { id: 'job-normal', content: { trigger: 'manual' } };
    const kdsJob = { id: 'job-kds', content: { trigger: 'kds_ready' } };

    assert.strictEqual(typeof shouldProcessQueuedPrintJob, 'function');
    assert.strictEqual(shouldProcessQueuedPrintJob({ autoPrintEnabled: false, kdsReadyPrintEnabled: false }, normalJob), false);
    assert.strictEqual(shouldProcessQueuedPrintJob({ autoPrintEnabled: false, kdsReadyPrintEnabled: true }, normalJob), false);
    assert.strictEqual(shouldProcessQueuedPrintJob({ autoPrintEnabled: false, kdsReadyPrintEnabled: true }, kdsJob), true);
    assert.strictEqual(shouldProcessQueuedPrintJob({ autoPrintEnabled: true, kdsReadyPrintEnabled: false }, normalJob), true);

    const listener = new PairedPrintListener(null, {
      adminClientId: 'store-1',
      pairingStore: {
        getPairing: () => ({ adminClientId: 'store-1', enabled: true }),
        savePairing: () => {},
        updatePairing: () => {},
        clearPairing: () => {},
      },
    });
    listener.currentPairing = { adminClientId: 'store-1' };
    listener.supabase = {};
    listener.printSettings = {
      ...listener.printSettings,
      autoPrintEnabled: false,
      kdsReadyPrintEnabled: true,
    };
    listener.refreshPrintSettings = async () => listener.printSettings;
    listener.isOrderAlreadyPrinted = async () => true;
    listener.claimPrintJob = async (id) => ({ id });
    listener.runPrintActionWithRetry = async (action) => action();
    listener.updatePrintJobStatus = async () => {};
    const printedRoutes = [];
    listener.printWithRouting = async (_orderId, route) => printedRoutes.push(route);

    await listener.processPrintJob({ id: 'job-counter', order_id: 'order-1', printer_type: 'counter', content: { trigger: 'kds_ready' } }, 'realtime_insert');
    await listener.processPrintJob({ id: 'job-kitchen', order_id: 'order-1', printer_type: 'kitchen', content: { trigger: 'kds_ready' } }, 'realtime_insert');

    assert.deepStrictEqual(printedRoutes, ['counter', 'kitchen']);
    console.log('kds ready print job tests passed');
  } finally {
    Module._load = originalLoad;
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
