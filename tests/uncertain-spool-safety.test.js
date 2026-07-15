// Verifies uncertain spool outcomes never reopen conservative printed claims.
//
// Run: node tests/uncertain-spool-safety.test.js

const assert = require('assert');
const os = require('os');
const Module = require('module');

const originalLoad = Module._load;
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

function uncertainTimeout() {
  const error = new Error('Spool timeout after dispatch');
  error.printOutcomeUncertain = true;
  return error;
}

function makeListener(PairedPrintListener, adminClientId) {
  const listener = new PairedPrintListener(null, {
    adminClientId,
    pairingStore: {
      getPairing: () => ({ adminClientId, enabled: true }),
      savePairing: () => {},
      updatePairing: () => {},
      clearPairing: () => {}
    }
  });
  listener.currentPairing = { adminClientId };
  return listener;
}

(async () => {
  console.log('--- uncertain spool safety ---');

  try {
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') {
        return { app: { getPath: () => os.tmpdir() } };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const PairedPrintListener = require('../src/main/supabase/paired-print-listener');
    const Settings = require('../src/main/config/settings');

    await test('uncertain timeout is attempted once while normal timeout still retries', async () => {
      const listener = makeListener(PairedPrintListener, 'store-retry');
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (callback) => {
        callback();
        return 0;
      };

      try {
        const uncertainError = uncertainTimeout();
        let uncertainAttempts = 0;
        await assert.rejects(
          () => listener.runPrintActionWithRetry(async () => {
            uncertainAttempts += 1;
            throw uncertainError;
          }, 'uncertain spool'),
          (error) => error === uncertainError
        );

        assert.strictEqual(listener.isRetriablePrintError(uncertainError), false);
        assert.strictEqual(uncertainAttempts, 1);

        const normalTimeout = new Error('Spool timeout before dispatch');
        let normalAttempts = 0;
        const result = await listener.runPrintActionWithRetry(async () => {
          normalAttempts += 1;
          if (normalAttempts === 1) throw normalTimeout;
          return 'printed';
        }, 'normal spool timeout');

        assert.strictEqual(listener.isRetriablePrintError(normalTimeout), true);
        assert.strictEqual(normalAttempts, 2);
        assert.strictEqual(result, 'printed');
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    });

    await test('reconnect scheduler ignores uncertain outcomes from any caller', async () => {
      const listener = makeListener(PairedPrintListener, 'store-reconnect');
      const originalSetTimeout = global.setTimeout;
      listener.currentPairing = {
        adminClientId: 'store-reconnect',
        enabled: true,
        appBaseUrl: 'http://localhost:3000',
        supabaseUrl: 'http://localhost:54321',
        anonKey: 'anon-key',
        session: {
          access_token: 'access-token',
          refresh_token: 'refresh-token'
        }
      };
      global.setTimeout = () => 'unexpected-reconnect-timer';

      try {
        listener.scheduleReconnect(uncertainTimeout());
      } finally {
        global.setTimeout = originalSetTimeout;
      }

      assert.strictEqual(listener.reconnectTimer, null);
      assert.strictEqual(listener.reconnectAttempt, 0);
      assert.strictEqual(listener.status, 'idle');
    });

    await test('legacy auto print keeps an uncertain claim and does not reconnect', async () => {
      const listener = makeListener(PairedPrintListener, 'store-legacy');
      const originalGetStorePrinters = Settings.getStorePrinters;
      const uncertainError = uncertainTimeout();
      const released = [];
      const telemetry = [];
      const reconnects = [];
      let printAttempts = 0;

      listener.printSettings = {
        ...listener.printSettings,
        autoPrintEnabled: true,
        autoPrintOnAcceptEnabled: false,
        autoPrintRoutes: ['counter']
      };
      listener.hasPendingOrPrintedPrintJob = async () => false;
      listener.claimAutoPrintLedger = async () => ({ id: 'claim-counter' });
      listener.releaseAutoPrintLedger = async (claimId) => {
        released.push(claimId);
      };
      listener.printWithRouting = async () => {
        printAttempts += 1;
        throw uncertainError;
      };
      listener.runPrintActionWithRetry = async (action) => action();
      listener.emitAutoPrintTelemetry = (_context, details) => {
        telemetry.push(details);
      };
      listener.scheduleReconnect = (error) => {
        reconnects.push(error);
      };

      try {
        Settings.getStorePrinters = () => ({});
        await listener.handleAutoPrintOrder({
          id: 'order-legacy-uncertain',
          created_at: new Date().toISOString()
        }, 'realtime_insert');
      } finally {
        Settings.getStorePrinters = originalGetStorePrinters;
      }

      assert.strictEqual(printAttempts, 1);
      assert.deepStrictEqual(released, []);
      assert.deepStrictEqual(reconnects, []);
      assert.deepStrictEqual(telemetry.map(({ via, outcome }) => [via, outcome]), [
        ['counter', 'failed']
      ]);
    });

    await test('claimed queued job keeps printed status after uncertain timeout', async () => {
      const listener = makeListener(PairedPrintListener, 'store-queued');
      const uncertainError = uncertainTimeout();
      const statuses = [];
      const reconnects = [];
      let printAttempts = 0;
      let claimAttempts = 0;

      listener.supabase = {};
      listener.refreshPrintSettings = async () => {
        listener.printSettings.autoPrintEnabled = true;
      };
      listener.isOrderAlreadyPrinted = async () => false;
      listener.claimPrintJob = async () => {
        claimAttempts += 1;
        return { id: 'job-uncertain', status: 'printed' };
      };
      listener.printWithRouting = async () => {
        printAttempts += 1;
        throw uncertainError;
      };
      listener.runPrintActionWithRetry = async (action) => action();
      listener.updatePrintJobStatus = async (_jobId, status) => {
        statuses.push(status);
      };
      listener.scheduleReconnect = (error) => {
        reconnects.push(error);
      };

      await listener.processPrintJob({
        id: 'job-uncertain',
        admin_client_id: 'store-queued',
        order_id: 'order-queued',
        printer_type: 'counter',
        status: 'pending',
        created_at: new Date().toISOString()
      }, 'realtime_insert');

      assert.strictEqual(claimAttempts, 1);
      assert.strictEqual(printAttempts, 1);
      assert.deepStrictEqual(statuses, []);
      assert.deepStrictEqual(reconnects, []);
      assert.strictEqual(listener.processedJobIds.has('job-uncertain'), true);
      assert.strictEqual(listener.processedOrderIds.has('order-queued'), true);
    });
  } catch (error) {
    failed += 1;
    console.error('FAIL  test setup');
    console.error(error && error.stack ? error.stack : error);
  } finally {
    Module._load = originalLoad;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
