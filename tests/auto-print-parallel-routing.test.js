// Verifies routed auto-print reserves printer queues before claiming each via.
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

function payload(printType, label = printType) {
  return {
    rawContent: Buffer.from(`via:${label}`, 'utf8').toString('base64'),
    encoding: 'base64',
    printType
  };
}

function decodePayload(job) {
  return Buffer.from(job.rawContent, 'base64').toString('utf8');
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

    await test('same-printer second via is not claimed until the first queue task completes', async () => {
      const firstPrintGate = deferred();
      const claims = [];
      const prints = [];
      const listener = makeListener(PairedPrintListener, async (job) => {
        prints.push(job.printType);
        if (job.printType === 'kitchen') {
          await firstPrintGate.promise;
        }
      });

      listener.resolveAutoPrintPrinterId = async () => 'Shared';
      listener.claimAutoPrintLedger = async (_orderId, route) => {
        claims.push(route);
        return { id: `claim-${route}` };
      };
      listener.fetchRenderedPayloads = async () => ({
        kitchen: payload('kitchen'),
        counter: payload('counter')
      });

      const operation = listener.autoPrintPerPrinter(order, order.id, autoPrintMap, 'test');
      await flushMicrotasks();

      assert.deepStrictEqual(claims, ['kitchen']);
      assert.deepStrictEqual(prints, ['kitchen']);

      firstPrintGate.resolve();
      await operation;

      assert.deepStrictEqual(claims, ['kitchen', 'attendance']);
      assert.deepStrictEqual(prints, ['kitchen', 'counter']);
    });

    await test('distinct printers claim and print concurrently', async () => {
      const claimGates = {
        kitchen: deferred(),
        attendance: deferred()
      };
      const printGates = {
        Kitchen: deferred(),
        Counter: deferred()
      };
      const claims = [];
      const prints = [];
      const listener = makeListener(PairedPrintListener, async (job) => {
        prints.push(job.printer);
        await printGates[job.printer].promise;
      });

      listener.claimAutoPrintLedger = async (_orderId, route) => {
        claims.push(route);
        await claimGates[route].promise;
        return { id: `claim-${route}` };
      };
      listener.fetchRenderedPayloads = async () => ({
        kitchen: payload('kitchen'),
        counter: payload('counter')
      });

      const operation = listener.autoPrintPerPrinter(order, order.id, autoPrintMap, 'test');
      await flushMicrotasks();
      assert.deepStrictEqual(new Set(claims), new Set(['kitchen', 'attendance']));

      claimGates.kitchen.resolve();
      claimGates.attendance.resolve();
      await flushMicrotasks();
      assert.deepStrictEqual(new Set(prints), new Set(['Kitchen', 'Counter']));

      printGates.Kitchen.resolve();
      printGates.Counter.resolve();
      await operation;
    });

    await test('same-printer work remains FIFO across auto-print invocations', async () => {
      const firstPrintGate = deferred();
      const claims = [];
      const prints = [];
      const listener = makeListener(PairedPrintListener, async (job) => {
        const label = decodePayload(job);
        prints.push(label);
        if (label === 'via:order-1') {
          await firstPrintGate.promise;
        }
      });

      listener.resolveAutoPrintPrinterId = async () => 'Shared';
      listener.claimAutoPrintLedger = async (orderId, route) => {
        claims.push(`${orderId}:${route}`);
        return { id: `claim-${orderId}-${route}` };
      };
      listener.fetchRenderedPayloads = async (orderId) => ({
        counter: payload('counter', orderId)
      });

      const firstOperation = listener.autoPrintPerPrinter(
        { ...order, id: 'order-1' },
        'order-1',
        { attendance: 'Shared' },
        'test'
      );
      await flushMicrotasks();
      assert.deepStrictEqual(claims, ['order-1:attendance']);
      assert.deepStrictEqual(prints, ['via:order-1']);

      const secondOperation = listener.autoPrintPerPrinter(
        { ...order, id: 'order-2' },
        'order-2',
        { attendance: 'Shared' },
        'test'
      );
      await flushMicrotasks();

      assert.deepStrictEqual(claims, ['order-1:attendance']);
      assert.deepStrictEqual(prints, ['via:order-1']);

      firstPrintGate.resolve();
      await Promise.all([firstOperation, secondOperation]);

      assert.deepStrictEqual(claims, [
        'order-1:attendance',
        'order-2:attendance'
      ]);
      assert.deepStrictEqual(prints, ['via:order-1', 'via:order-2']);
    });

    await test('partial print failure releases only its claim and waits for other vias', async () => {
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
      assert.deepStrictEqual(new Set(started), new Set(['Kitchen', 'Counter']));

      kitchenGate.reject(kitchenError);
      await flushMicrotasks();
      assert.strictEqual(operationSettled, false, 'operation must settle the Counter route too');
      assert.deepStrictEqual(released, ['claim-kitchen']);

      counterGate.resolve();
      await assert.rejects(operation, (error) => error === kitchenError);

      assert.deepStrictEqual(completed, ['Counter']);
      assert.deepStrictEqual(claims, ['kitchen', 'attendance']);
      assert.deepStrictEqual(released, ['claim-kitchen']);
      assert.deepStrictEqual(fetchCalls, [{
        orderId: 'order-1',
        printTypes: ['kitchen', 'counter']
      }]);
    });

    await test('render failure happens before claims and dispatch', async () => {
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

    await test('claim rejection does not block another printer queue', async () => {
      const claimError = new Error('kitchen claim failed');
      const printed = [];
      const listener = makeListener(PairedPrintListener, async (job) => {
        printed.push(job.printer);
      });

      listener.claimAutoPrintLedger = async (_orderId, route) => {
        if (route === 'kitchen') throw claimError;
        return { id: `claim-${route}` };
      };
      listener.fetchRenderedPayloads = async () => ({
        kitchen: payload('kitchen'),
        counter: payload('counter')
      });

      await assert.rejects(
        () => listener.autoPrintPerPrinter(order, order.id, autoPrintMap, 'test'),
        (error) => error === claimError
      );

      assert.deepStrictEqual(printed, ['Counter']);
    });

    await test('release retries immediately once and preserves the print failure after recovery', async () => {
      const printError = new Error('Counter print failed');
      const firstReleaseError = new Error('temporary ledger delete failure');
      const releaseCalls = [];
      const listener = makeListener(PairedPrintListener, async () => {
        throw printError;
      });

      listener.resolveAutoPrintPrinterId = async () => 'Counter';
      listener.claimAutoPrintLedger = async () => ({ id: 'claim-attendance' });
      listener.releaseAutoPrintLedger = async (claimId) => {
        releaseCalls.push(claimId);
        if (releaseCalls.length === 1) throw firstReleaseError;
      };
      listener.fetchRenderedPayloads = async () => ({
        counter: payload('counter')
      });

      await assert.rejects(
        () => listener.autoPrintPerPrinter(
          order,
          order.id,
          { attendance: 'Counter' },
          'test'
        ),
        (error) => error === printError
      );

      assert.deepStrictEqual(releaseCalls, ['claim-attendance', 'claim-attendance']);
    });

    await test('final release failure surfaces both print and release errors after two attempts', async () => {
      const printError = new Error('Counter print failed');
      const releaseErrors = [
        new Error('ledger delete failed once'),
        new Error('ledger delete failed twice')
      ];
      let releaseAttempts = 0;
      const listener = makeListener(PairedPrintListener, async () => {
        throw printError;
      });

      listener.resolveAutoPrintPrinterId = async () => 'Counter';
      listener.claimAutoPrintLedger = async () => ({ id: 'claim-attendance' });
      listener.releaseAutoPrintLedger = async () => {
        const error = releaseErrors[releaseAttempts];
        releaseAttempts += 1;
        throw error;
      };
      listener.fetchRenderedPayloads = async () => ({
        counter: payload('counter')
      });

      await assert.rejects(
        () => listener.autoPrintPerPrinter(
          order,
          order.id,
          { attendance: 'Counter' },
          'test'
        ),
        (error) => {
          assert.ok(error instanceof AggregateError);
          assert.deepStrictEqual(error.errors, [printError, releaseErrors[1]]);
          assert.strictEqual(error.printError, printError);
          assert.strictEqual(error.releaseError, releaseErrors[1]);
          return true;
        }
      );

      assert.strictEqual(releaseAttempts, 2);
    });

    await test('telemetry emits exactly one terminal outcome per available via', async () => {
      const claimError = new Error('kitchen claim failed');
      const telemetry = [];
      const printed = [];
      const listener = makeListener(PairedPrintListener, async (job) => {
        printed.push(job.printer);
      });

      listener.printSettings.barPrintEnabled = true;
      listener.resolveAutoPrintPrinterId = async (route) => ({
        kitchen: 'Kitchen',
        attendance: 'Counter',
        bar: 'Bar'
      })[route] || null;
      listener.claimAutoPrintLedger = async (_orderId, route) => {
        if (route === 'kitchen') throw claimError;
        if (route === 'attendance') return null;
        return { id: `claim-${route}` };
      };
      listener.fetchRenderedPayloads = async () => ({
        kitchen: payload('kitchen'),
        counter: payload('counter'),
        bar: payload('bar')
      });
      listener.emitAutoPrintTelemetry = (_context, details) => {
        telemetry.push(details);
      };

      await assert.rejects(
        () => listener.autoPrintPerPrinter(order, order.id, {
          ...autoPrintMap,
          bar: 'Bar'
        }, 'test'),
        (error) => error === claimError
      );

      assert.deepStrictEqual(printed, ['Bar']);
      assert.deepStrictEqual(telemetry.map(({ via, outcome }) => [via, outcome]), [
        ['kitchen', 'failed'],
        ['attendance', 'skipped'],
        ['bar', 'printed']
      ]);
      assert.deepStrictEqual(telemetry.map(({ via }) => via).sort(), [
        'attendance',
        'bar',
        'kitchen'
      ]);
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
