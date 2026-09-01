const assert = require('node:assert/strict');
const os = require('node:os');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function loadElectronStub(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Settings = require('../src/main/config/settings');
const PairedPrintListener = require('../src/main/supabase/paired-print-listener');

const cutoff = '2026-09-01T12:00:00.000Z';
const safety = {
  getOrCreate: () => ({ safeActivationAt: cutoff, safeActivationVersion: '1.9.5' }),
  get: () => ({ safeActivationAt: cutoff, safeActivationVersion: '1.9.5' }),
  allows: (_storeId, candidateIso) => Date.parse(candidateIso) >= Date.parse(cutoff)
};

function createListener(options = {}) {
  const listener = new PairedPrintListener(null, {
    adminClientId: 'store-1',
    safePrintActivation: safety,
    pairingStore: {
      getPairing: () => ({ adminClientId: 'store-1', enabled: true }),
      savePairing: () => {},
      updatePairing: () => {},
      clearPairing: () => {}
    },
    ...options
  });
  listener.currentPairing = { adminClientId: 'store-1', storeName: 'Test Store' };
  listener.printSettings.autoPrintEnabled = true;
  listener.printSettings.autoPrintRoutes = ['counter'];
  return listener;
}

(async () => {
  const settlements = [];
  let orderLoads = 0;
  let durableDispatches = 0;
  const durableListener = createListener({
    autoPrintIntentClient: {
      claim: async () => [
        {
          id: 'legacy-intent',
          order_id: 'legacy-order',
          lease_token: 'legacy-lease',
          attempt_count: 0,
          created_at: '2026-09-01T11:59:59.000Z'
        },
        {
          id: 'new-intent',
          order_id: 'new-order',
          lease_token: 'new-lease',
          attempt_count: 0,
          created_at: cutoff
        }
      ],
      settle: async (id, leaseToken, outcome, lastError) => {
        settlements.push({ id, leaseToken, outcome, lastError });
      }
    }
  });
  durableListener.loadOrderById = async (orderId) => {
    orderLoads += 1;
    return { id: orderId, created_at: cutoff };
  };
  durableListener.handleAutoPrintOrder = async () => {
    durableDispatches += 1;
    return { outcome: 'printed' };
  };

  await durableListener.processAutoPrintIntents();

  assert.equal(orderLoads, 1, 'legacy intent must be rejected before loading its order');
  assert.equal(durableDispatches, 1, 'only the new intent may enter automatic dispatch');
  assert.deepEqual(settlements, [
    {
      id: 'legacy-intent',
      leaseToken: 'legacy-lease',
      outcome: 'attention',
      lastError: 'pre_activation_backlog'
    },
    {
      id: 'new-intent',
      leaseToken: 'new-lease',
      outcome: 'completed',
      lastError: null
    }
  ]);

  const originalGetStorePrinters = Settings.getStorePrinters;
  Settings.getStorePrinters = () => ({ autoPrint: null });
  try {
    const orderListener = createListener();
    let claims = 0;
    let spoolCalls = 0;
    orderListener.hasPrintJobWithStatuses = async () => false;
    orderListener.claimAutoPrintLedger = async () => {
      claims += 1;
      return { id: `claim-${claims}` };
    };
    orderListener.printWithRouting = async () => {
      spoolCalls += 1;
    };

    assert.deepEqual(
      await orderListener.handleAutoPrintOrder({
        id: 'delayed-realtime-order',
        created_at: '2026-09-01T11:59:59.999Z',
        status: 'pending'
      }, 'realtime_insert'),
      { outcome: 'skipped', reason: 'pre_activation_backlog' }
    );
    assert.equal(claims, 0);
    assert.equal(spoolCalls, 0);

    assert.deepEqual(
      await orderListener.handleAutoPrintOrder({
        id: 'boundary-order',
        created_at: cutoff,
        status: 'pending'
      }, 'realtime_insert'),
      { outcome: 'printed' }
    );
    assert.equal(claims, 1);
    assert.equal(spoolCalls, 1);
  } finally {
    Settings.getStorePrinters = originalGetStorePrinters;
  }

  const jobListener = createListener();
  jobListener.supabase = {};
  let jobClaims = 0;
  let jobSpoolCalls = 0;
  const jobStatuses = [];
  jobListener.refreshPrintSettings = async () => {};
  jobListener.claimPrintJob = async () => {
    jobClaims += 1;
    return { id: 'claimed-job' };
  };
  jobListener.printWithRouting = async () => {
    jobSpoolCalls += 1;
  };
  jobListener.updatePrintJobStatus = async (id, status) => {
    jobStatuses.push({ id, status });
  };

  await jobListener.processPrintJob({
    id: 'delayed-print-job',
    order_id: 'old-order',
    status: 'pending',
    created_at: '2026-09-01T11:59:59.999Z'
  }, 'realtime_insert');

  assert.equal(jobClaims, 0, 'old jobs must not claim a print route');
  assert.equal(jobSpoolCalls, 0, 'old jobs must not reach spool');
  assert.deepEqual(jobStatuses, [{ id: 'delayed-print-job', status: 'failed' }]);

  console.log('safe print listener boundaries: ok');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
