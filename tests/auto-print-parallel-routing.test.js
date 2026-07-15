// Verifies routed auto-print claims and dispatches independent vias in parallel.
//
// Run: node tests/auto-print-parallel-routing.test.js

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve();
  }
}

function payload(printType) {
  return {
    rawContent: Buffer.from(`via:${printType}`, 'utf8').toString('base64'),
    encoding: 'base64',
    printType
  };
}

function makeListener(PairedPrintListener, print) {
  const listener = new PairedPrintListener({
    refreshPrinters: async () => {},
    print
  }, {
    adminClientId: 'store-1',
    pairingStore: {
      getPairing: () => ({ adminClientId: 'store-1', enabled: true }),
      savePairing: () => {},
      updatePairing: () => {},
      clearPairing: () => {}
    }
  });

  listener.currentPairing = {
    adminClientId: 'store-1',
    appBaseUrl: 'http://localhost:3000'
  };
  listener.resolveAutoPrintPrinterId = async (route) => ({
    kitchen: 'Kitchen',
    attendance: 'Counter'
  })[route] || null;
  listener.runPrintActionWithRetry = async (action) => action();

  return listener;
}

const autoPrintMap = {
  kitchen: 'Kitchen',
  attendance: 'Counter',
  counter: 'Counter',
  delivery: 'Counter'
};

const order = {
  id: 'order-1',
  order_number: 1001,
  order_type: 'delivery'
};

(async () => {
  console.log('--- auto print parallel routing ---');

  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') {
        return { app: { getPath: () => os.tmpdir() } };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const PairedPrintListener = require('../src/main/supabase/paired-print-listener');

    await test('one failed printer does not block or release a successful via', async () => {
      const kitchenGate = deferred();
      const counterGate = deferred();
      const kitchenError = new Error('Kitchen printer failed');
      const started = [];
      const completed = [];
      const claims = [];
      const released = [];
      const fetchCalls = [];

      const listener = makeListener(PairedPrintListener, async (job) => {
        started.push(job.printer);
        if (job.printer === 'Kitchen') {
          await kitchenGate.promise;
          completed.push('Kitchen');
          return;
        }

        await counterGate.promise;
        completed.push('Counter');
      });

      listener.claimAutoPrintLedger = async (_orderId, route) => {
        claims.push(route);
        return { id: `claim-${route}` };
      };
      listener.releaseAutoPrintLedger = async (claimId) => {
        released.push(claimId);
      };
      listener.fetchRenderedPayloads = async (orderId, printTypes) => {
        fetchCalls.push({ orderId, printTypes });
        return {
          kitchen: payload('kitchen'),
          counter: payload('counter')
        };
      };
      let operationSettled = false;
      const operation = listener.autoPrintPerPrinter(order, order.id, autoPrintMap, 'test');
      operation.then(
        () => { operationSettled = true; },
        () => { operationSettled = true; }
      );

      await flushMicrotasks();
      const parallelStartAssertion = (() => {
        try {
          assert.deepStrictEqual(new Set(started), new Set(['Kitchen', 'Counter']));
          return null;
        } catch (error) {
          return error;
        }
      })();

      kitchenGate.reject(kitchenError);
      await flushMicrotasks();

      if (!parallelStartAssertion) {
        assert.strictEqual(operationSettled, false, 'operation must wait for Counter after Kitchen rejects');
      }

      counterGate.resolve();
      await assert.rejects(operation, (error) => error === kitchenError);

      if (parallelStartAssertion) throw parallelStartAssertion;

      assert.deepStrictEqual(completed, ['Counter']);
      assert.deepStrictEqual(claims, ['kitchen', 'attendance']);
      assert.deepStrictEqual(released, ['claim-kitchen']);
      assert.deepStrictEqual(fetchCalls, [{
        orderId: 'order-1',
        printTypes: ['kitchen', 'counter']
      }]);
    });

    await test('render failure releases every won claim before dispatch', async () => {
      const renderError = new Error('official render failed');
      const claims = [];
      const released = [];
      const fetchCalls = [];
      const started = [];
      const listener = makeListener(PairedPrintListener, async (job) => {
        started.push(job.printer);
      });

      listener.claimAutoPrintLedger = async (_orderId, route) => {
        claims.push(route);
        return { id: `claim-${route}` };
      };
      listener.releaseAutoPrintLedger = async (claimId) => {
        released.push(claimId);
      };
      listener.fetchRenderedPayloads = async (orderId, printTypes) => {
        fetchCalls.push({ orderId, printTypes });
        throw renderError;
      };
      await assert.rejects(
        () => listener.autoPrintPerPrinter(order, order.id, autoPrintMap, 'test'),
        (error) => error === renderError
      );

      assert.deepStrictEqual(claims, []);
      assert.deepStrictEqual(released, []);
      assert.deepStrictEqual(started, []);
      assert.deepStrictEqual(fetchCalls, [{
        orderId: 'order-1',
        printTypes: ['kitchen', 'counter']
      }]);
    });

    await test('successful claimed route prints before a sibling claim error is returned', async () => {
      const claimError = new Error('kitchen claim failed');
      const printed = [];
      const released = [];
      const fetchCalls = [];
      const listener = makeListener(PairedPrintListener, async (job) => {
        printed.push(job.printer);
      });

      listener.claimAutoPrintLedger = async (_orderId, route) => {
        if (route === 'kitchen') throw claimError;
        return { id: `claim-${route}` };
      };
      listener.releaseAutoPrintLedger = async (claimId) => {
        released.push(claimId);
      };
      listener.fetchRenderedPayloads = async (orderId, printTypes) => {
        fetchCalls.push({ orderId, printTypes });
        return { counter: payload('counter') };
      };

      await assert.rejects(
        () => listener.autoPrintPerPrinter(order, order.id, autoPrintMap, 'test'),
        (error) => error === claimError
      );

      assert.deepStrictEqual(printed, ['Counter']);
      assert.deepStrictEqual(released, []);
      assert.deepStrictEqual(fetchCalls, [{
        orderId: 'order-1',
        printTypes: ['kitchen', 'counter']
      }]);
    });

    await test('claim error plus already-owned route rejects without dispatch', async () => {
      const claimError = new Error('kitchen claim failed');
      const printed = [];
      let fetchCalls = 0;
      const listener = makeListener(PairedPrintListener, async (job) => {
        printed.push(job.printer);
      });

      listener.claimAutoPrintLedger = async (_orderId, route) => {
        if (route === 'kitchen') throw claimError;
        return null;
      };
      listener.fetchRenderedPayloads = async () => {
        fetchCalls += 1;
        return {};
      };

      await assert.rejects(
        () => listener.autoPrintPerPrinter(order, order.id, autoPrintMap, 'test'),
        (error) => error === claimError
      );

      assert.deepStrictEqual(printed, []);
      assert.strictEqual(fetchCalls, 1);
    });

    await test('release rejection preserves the original print error', async () => {
      const printError = new Error('Kitchen print failed');
      const releaseError = new Error('ledger delete failed');
      const released = [];
      const completed = [];
      const listener = makeListener(PairedPrintListener, async (job) => {
        if (job.printer === 'Kitchen') throw printError;
        completed.push(job.printer);
      });

      listener.claimAutoPrintLedger = async (_orderId, route) => ({ id: `claim-${route}` });
      listener.releaseAutoPrintLedger = async (claimId) => {
        released.push(claimId);
        throw releaseError;
      };
      listener.fetchRenderedPayloads = async () => ({
        kitchen: payload('kitchen'),
        counter: payload('counter')
      });

      await assert.rejects(
        () => listener.autoPrintPerPrinter(order, order.id, autoPrintMap, 'test'),
        (error) => error === printError
      );

      assert.deepStrictEqual(completed, ['Counter']);
      assert.deepStrictEqual(released, ['claim-kitchen']);
    });

    await test('ledger release rejects a returned Supabase delete error', async () => {
      const releaseError = new Error('delete returned error');
      const listener = makeListener(PairedPrintListener, async () => {});
      listener.supabase = {
        from: () => ({
          delete: () => ({
            eq: async () => ({ error: releaseError })
          })
        })
      };

      await assert.rejects(
        () => listener.releaseAutoPrintLedger('claim-kitchen'),
        (error) => error === releaseError
      );
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
