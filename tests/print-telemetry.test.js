// Validates automatic-print telemetry records and deterministic log reporting.
//
// Run: node tests/print-telemetry.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const {
  buildPrintPerformanceRecord,
  calculatePickupMs,
  createPrintTelemetry,
  emitPrintPerformance
} = require('../src/main/utils/print-telemetry');
const {
  formatPrintPerformanceReport,
  parsePrintPerformanceLines,
  percentile,
  summarizePrintPerformance,
  summarizePrintPerformanceStream
} = require('../scripts/print-performance-report');

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

(async () => {
  console.log('--- print telemetry ---');

  await test('selects the slowest stage deterministically', () => {
    const telemetry = createPrintTelemetry({
      traceId: 'trace-1',
      storeId: 'store-1',
      orderId: 'order-1',
      via: 'kitchen',
      printer: 'Kitchen',
      source: 'realtime_insert'
    }, (() => {
      const values = [100, 1460];
      return () => values.shift();
    })());

    const record = telemetry.finish({
      pickupMs: 20,
      claimMs: 100,
      renderMs: 300,
      queueWaitMs: 10,
      spoolMs: 900
    });

    assert.equal(record.slowestStage, 'spool');
    assert.equal(record.totalMs, 1380);

    const tied = buildPrintPerformanceRecord({
      traceId: 'trace-2',
      orderId: 'order-2',
      source: 'recovery'
    }, {
      pickupMs: 50,
      claimMs: 50
    });
    assert.equal(tied.slowestStage, 'pickup');
  });

  await test('clamps invalid timings and emits only the telemetry schema', () => {
    const cyclicOrder = {};
    cyclicOrder.order = cyclicOrder;
    const record = buildPrintPerformanceRecord({
      traceId: 'trace-safe',
      storeId: 'store-safe',
      orderId: 'order-safe',
      via: 'attendance',
      printer: 'Counter',
      source: 'realtime_insert',
      outcome: 'failed',
      customerName: 'Sensitive Name',
      phone: '85999999999',
      address: 'Sensitive Address',
      items: ['Sensitive item text'],
      payload: { rawContent: 'bytes' },
      rawContent: 'bytes',
      order: cyclicOrder
    }, {
      pickupMs: -10,
      claimMs: '12.5',
      renderMs: Number.NaN,
      queueWaitMs: Number.POSITIVE_INFINITY,
      spoolMs: 7,
      totalMs: -1
    });

    assert.deepEqual(Object.keys(record), [
      'traceId',
      'storeId',
      'orderId',
      'via',
      'printer',
      'source',
      'outcome',
      'pickupMs',
      'claimMs',
      'renderMs',
      'queueWaitMs',
      'spoolMs',
      'totalMs',
      'slowestStage'
    ]);
    assert.equal(record.pickupMs, 0);
    assert.equal(record.claimMs, 12.5);
    assert.equal(record.renderMs, 0);
    assert.equal(record.queueWaitMs, 0);
    assert.equal(record.spoolMs, 7);
    assert.equal(record.totalMs, 0);
    assert.equal(record.slowestStage, 'claim');
    assert.equal(JSON.stringify(record).includes('Sensitive'), false);
    assert.equal(JSON.stringify(record).includes('rawContent'), false);
  });

  await test('keeps via and printer fields explicit when unresolved', () => {
    const record = buildPrintPerformanceRecord({
      traceId: 'trace-unresolved',
      orderId: 'order-unresolved',
      source: 'recovery',
      outcome: 'skipped'
    });

    assert.deepEqual(Object.keys(record), [
      'traceId',
      'orderId',
      'via',
      'printer',
      'source',
      'outcome',
      'pickupMs',
      'claimMs',
      'renderMs',
      'queueWaitMs',
      'spoolMs',
      'totalMs',
      'slowestStage'
    ]);
    assert.equal(record.via, '');
    assert.equal(record.printer, '');
  });

  await test('uses the eligible timestamp and clamps invalid pickup latency', () => {
    const order = {
      created_at: '2026-07-14T12:00:00.000Z',
      updated_at: '2026-07-14T12:00:02.000Z'
    };

    assert.equal(
      calculatePickupMs(order, 'realtime_insert', Date.parse('2026-07-14T12:00:03.000Z')),
      3000
    );
    assert.equal(
      calculatePickupMs(order, 'realtime_update_accepted', Date.parse('2026-07-14T12:00:03.000Z')),
      1000
    );
    const paidPixOrder = {
      created_at: '2026-07-14T11:00:00.000Z',
      updated_at: '2026-07-14T12:00:02.000Z',
      payment_method: 'pix_online',
      payment_status: 'paid'
    };
    assert.equal(
      calculatePickupMs(paidPixOrder, 'realtime_update_paid', Date.parse('2026-07-14T12:00:03.000Z')),
      1000
    );
    assert.equal(
      calculatePickupMs(paidPixOrder, 'recovery', Date.parse('2026-07-14T12:00:03.000Z')),
      1000
    );
    assert.equal(
      calculatePickupMs(order, 'recovery_accept', Date.parse('2026-07-14T11:59:59.000Z')),
      0
    );
    assert.equal(calculatePickupMs({ created_at: 'invalid' }, 'recovery', 123), 0);
  });

  await test('contains logger and serialization failures', () => {
    const lines = [];
    const record = emitPrintPerformance({
      info: (line) => lines.push(line)
    }, {
      traceId: 'trace-log',
      orderId: 'order-log',
      source: 'recovery'
    }, {
      spoolMs: 15
    });

    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith('[PRINT_PERF] {'));
    assert.equal(JSON.parse(lines[0].slice('[PRINT_PERF] '.length)).spoolMs, 15);
    assert.doesNotThrow(() => emitPrintPerformance({
      info: () => { throw new Error('logger unavailable'); }
    }, {
      traceId: 'trace-failure',
      orderId: 'order-failure',
      source: 'recovery'
    }));
    assert.equal(record.traceId, 'trace-log');
  });

  await test('parses valid performance JSON and ignores malformed lines', () => {
    const records = parsePrintPerformanceLines([
      'ordinary log line',
      '2026-07-14 INFO [PRINT_PERF] {"outcome":"printed","totalMs":120,"slowestStage":"render"}',
      '[PRINT_PERF] not-json',
      '[PRINT_PERF] [1,2,3]',
      '[PRINT_PERF] {"outcome":"failed","totalMs":999,"slowestStage":"spool"}',
      '[PRINT_PERF] {"outcome":"printed","totalMs":"invalid","slowestStage":"claim"}'
    ].join('\n'));

    assert.equal(records.length, 3);
    assert.equal(records[0].totalMs, 120);
    assert.equal(summarizePrintPerformance(records).count, 1);
  });

  await test('uses nearest-rank percentiles and formats deterministic bottlenecks', () => {
    const records = parsePrintPerformanceLines([
      '[PRINT_PERF] {"outcome":"printed","totalMs":400,"slowestStage":"spool"}',
      '[PRINT_PERF] {"outcome":"printed","totalMs":100,"slowestStage":"render"}',
      '[PRINT_PERF] {"outcome":"printed","totalMs":300,"slowestStage":"spool"}',
      '[PRINT_PERF] {"outcome":"printed","totalMs":200,"slowestStage":"render"}',
      '[PRINT_PERF] {"outcome":"failed","totalMs":900,"slowestStage":"spool"}'
    ].join('\n'));
    const summary = summarizePrintPerformance(records);

    assert.equal(percentile([400, 100, 300, 200], 0.5), 200);
    assert.deepEqual(summary, {
      count: 4,
      p50: 200,
      p95: 400,
      max: 400,
      bottlenecks: {
        render: 2,
        spool: 2
      }
    });
    assert.equal(formatPrintPerformanceReport(summary), [
      'count=4',
      'p50=200ms',
      'p95=400ms',
      'max=400ms',
      'bottlenecks: render=2, spool=2'
    ].join('\n'));
  });

  await test('streams the performance fixture into the deterministic report summary', async () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'print-performance.log');
    const summary = await summarizePrintPerformanceStream(
      fs.createReadStream(fixturePath, { encoding: 'utf8' })
    );

    assert.deepEqual(summary, {
      count: 4,
      p50: 200,
      p95: 400,
      max: 400,
      bottlenecks: {
        render: 2,
        spool: 2
      }
    });
  });

  await test('emits one sanitized record per routed printer with one shared trace', async () => {
    const originalLoad = Module._load;
    let logger = null;
    let originalLoggerInfo = null;

    try {
      Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'electron') {
          return { app: { getPath: () => os.tmpdir() } };
        }
        return originalLoad.call(this, request, parent, isMain);
      };

      const PairedPrintListener = require('../src/main/supabase/paired-print-listener');
      logger = require('../src/main/utils/logger');
      const lines = [];
      originalLoggerInfo = logger.info;
      logger.info = (line) => {
        if (String(line).startsWith('[PRINT_PERF] ')) lines.push(line);
      };

      let monotonicNow = 0;
      const listener = new PairedPrintListener({
        getPrinters: () => [{ id: 'Kitchen' }, { id: 'Counter' }],
        print: async () => {}
      }, {
        adminClientId: 'store-1',
        performanceNow: () => {
          monotonicNow += 10;
          return monotonicNow;
        },
        wallClockNow: () => Date.parse('2026-07-14T12:00:01.000Z'),
        traceIdFactory: () => 'trace-routed',
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
      listener.fetchRenderedPayloads = async () => ({
        kitchen: { rawContent: 'kitchen', encoding: 'base64' },
        counter: { rawContent: 'counter', encoding: 'base64' }
      });
      listener.claimAutoPrintLedger = async (_orderId, route) => ({ id: `claim-${route}` });
      listener.runPrintActionWithRetry = async (action) => action();

      await listener.autoPrintPerPrinter({
        id: 'order-routed',
        order_type: 'delivery',
        created_at: '2026-07-14T12:00:00.000Z',
        customer_name: 'Sensitive Name',
        items: ['Sensitive item text']
      }, 'order-routed', {
        kitchen: 'Kitchen',
        attendance: 'Counter',
        counter: 'Counter',
        delivery: 'Counter'
      }, 'realtime_insert');

      const records = lines.map((line) => JSON.parse(line.slice('[PRINT_PERF] '.length)));
      assert.equal(records.length, 2);
      assert.deepEqual(new Set(records.map((record) => record.traceId)), new Set(['trace-routed']));
      assert.deepEqual(new Set(records.map((record) => record.via)), new Set(['kitchen', 'attendance']));
      assert.deepEqual(new Set(records.map((record) => record.printer)), new Set(['Kitchen', 'Counter']));
      assert.ok(records.every((record) => record.outcome === 'printed'));
      assert.ok(records.every((record) => record.pickupMs === 1000));
      assert.ok(records.every((record) => record.totalMs >= record.pickupMs));
      assert.ok(records.every((record) => record.renderMs >= 0));
      assert.ok(records.every((record) => record.queueWaitMs >= 0));
      assert.ok(records.every((record) => record.spoolMs >= 0));
      assert.ok(records.every((record) => !JSON.stringify(record).includes('Sensitive')));

      lines.length = 0;
      listener.traceIdFactory = () => 'trace-unresolved-printer';
      listener.resolveAutoPrintPrinterId = async () => null;
      await listener.autoPrintPerPrinter({
        id: 'order-unresolved-printer',
        order_type: 'delivery',
        created_at: '2026-07-14T12:00:00.000Z'
      }, 'order-unresolved-printer', {
        kitchen: 'Kitchen',
        attendance: 'Counter',
        counter: 'Counter',
        delivery: 'Counter'
      }, 'realtime_insert');

      const skippedRecords = lines.map((line) => JSON.parse(line.slice('[PRINT_PERF] '.length)));
      assert.equal(skippedRecords.length, 2);
      assert.ok(skippedRecords.every((record) => record.outcome === 'failed'));
      assert.ok(skippedRecords.every((record) => record.printer === ''));
      assert.ok(skippedRecords.every((record) => Object.hasOwn(record, 'via')));
      assert.ok(skippedRecords.every((record) => Object.hasOwn(record, 'printer')));

      lines.length = 0;
      const resolverError = new Error('kitchen resolver failed');
      const partialPrints = [];
      listener.traceIdFactory = () => 'trace-partial-resolver';
      listener.resolveAutoPrintPrinterId = async (route) => {
        if (route === 'kitchen') throw resolverError;
        return 'Counter';
      };
      listener.printerManager.print = async (job) => {
        partialPrints.push(job.printer);
      };

      await assert.rejects(
        () => listener.autoPrintPerPrinter({
          id: 'order-partial-resolver',
          order_type: 'delivery',
          created_at: '2026-07-14T12:00:00.000Z'
        }, 'order-partial-resolver', {
          kitchen: 'Kitchen',
          attendance: 'Counter',
          counter: 'Counter',
          delivery: 'Counter'
        }, 'realtime_insert'),
        (error) => error === resolverError
      );

      const partialRecords = lines.map((line) => JSON.parse(line.slice('[PRINT_PERF] '.length)));
      assert.deepEqual(partialPrints, ['Counter']);
      assert.deepEqual(partialRecords.map((record) => [
        record.via,
        record.printer,
        record.outcome
      ]), [
        ['kitchen', '', 'failed'],
        ['attendance', 'Counter', 'printed']
      ]);
    } finally {
      if (logger && originalLoggerInfo) logger.info = originalLoggerInfo;
      Module._load = originalLoad;
    }
  });

  await test('includes successful retry work in per-printer spool time', async () => {
    const originalLoad = Module._load;
    let logger = null;
    let originalLoggerInfo = null;

    try {
      Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'electron') {
          return { app: { getPath: () => os.tmpdir() } };
        }
        return originalLoad.call(this, request, parent, isMain);
      };

      const PairedPrintListener = require('../src/main/supabase/paired-print-listener');
      logger = require('../src/main/utils/logger');
      const lines = [];
      originalLoggerInfo = logger.info;
      logger.info = (line) => {
        if (String(line).startsWith('[PRINT_PERF] ')) lines.push(line);
      };

      let monotonicNow = 0;
      let printAttempts = 0;
      const listener = new PairedPrintListener({
        getPrinters: () => [{ id: 'Counter' }],
        print: async () => {
          printAttempts += 1;
          if (printAttempts === 1) throw new Error('first attempt failed');
        }
      }, {
        adminClientId: 'store-retry',
        performanceNow: () => {
          monotonicNow += 10;
          return monotonicNow;
        },
        wallClockNow: () => Date.parse('2026-07-14T12:00:00.000Z'),
        traceIdFactory: () => 'trace-retry',
        pairingStore: {
          getPairing: () => ({ adminClientId: 'store-retry', enabled: true }),
          savePairing: () => {},
          updatePairing: () => {},
          clearPairing: () => {}
        }
      });
      listener.currentPairing = {
        adminClientId: 'store-retry',
        appBaseUrl: 'http://localhost:3000'
      };
      listener.resolveAutoPrintPrinterId = async () => 'Counter';
      listener.fetchRenderedPayloads = async () => ({
        counter: { rawContent: 'counter', encoding: 'base64' }
      });
      listener.claimAutoPrintLedger = async () => ({ id: 'claim-attendance' });
      listener.runPrintActionWithRetry = async (action) => {
        try {
          return await action();
        } catch {
          monotonicNow += 500;
          return action();
        }
      };

      await listener.autoPrintPerPrinter({
        id: 'order-retry',
        order_type: 'delivery',
        created_at: '2026-07-14T12:00:00.000Z'
      }, 'order-retry', {
        attendance: 'Counter'
      }, 'realtime_insert');

      const records = lines.map((line) => JSON.parse(line.slice('[PRINT_PERF] '.length)));
      assert.equal(printAttempts, 2);
      assert.equal(records.length, 1);
      assert.equal(records[0].outcome, 'printed');
      assert.ok(records[0].spoolMs >= 500);
      assert.ok(records[0].spoolMs > records[0].queueWaitMs);
    } finally {
      if (logger && originalLoggerInfo) logger.info = originalLoggerInfo;
      Module._load = originalLoad;
    }
  });

  await test('records the opaque legacy print action as spool time', async () => {
    const originalLoad = Module._load;
    let logger = null;
    let Settings = null;
    let originalLoggerInfo = null;
    let originalGetStorePrinters = null;

    try {
      Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'electron') {
          return { app: { getPath: () => os.tmpdir() } };
        }
        return originalLoad.call(this, request, parent, isMain);
      };

      const PairedPrintListener = require('../src/main/supabase/paired-print-listener');
      logger = require('../src/main/utils/logger');
      Settings = require('../src/main/config/settings');
      const lines = [];
      originalLoggerInfo = logger.info;
      originalGetStorePrinters = Settings.getStorePrinters;
      logger.info = (line) => {
        if (String(line).startsWith('[PRINT_PERF] ')) lines.push(line);
      };
      Settings.getStorePrinters = () => ({});

      let monotonicNow = 0;
      const listener = new PairedPrintListener(null, {
        adminClientId: 'store-legacy',
        performanceNow: () => {
          monotonicNow += 5;
          return monotonicNow;
        },
        wallClockNow: () => Date.parse('2026-07-14T12:00:03.000Z'),
        traceIdFactory: () => 'trace-legacy',
        pairingStore: {
          getPairing: () => ({ adminClientId: 'store-legacy', enabled: true }),
          savePairing: () => {},
          updatePairing: () => {},
          clearPairing: () => {}
        }
      });
      listener.currentPairing = { adminClientId: 'store-legacy' };
      listener.printSettings = {
        ...listener.printSettings,
        autoPrintEnabled: true,
        autoPrintOnAcceptEnabled: false,
        autoPrintRoutes: ['kitchen', 'counter']
      };
      listener.hasPendingOrPrintedPrintJob = async () => false;
      listener.claimAutoPrintLedger = async (_orderId, via) => (
        via === 'kitchen' ? { id: 'claim-kitchen' } : null
      );
      const printedRoutes = [];
      listener.printWithRouting = async (_orderId, printType) => {
        printedRoutes.push(printType);
        monotonicNow += 100;
      };
      listener.runPrintActionWithRetry = async (action) => action();

      await listener.handleAutoPrintOrder({
        id: 'order-legacy',
        created_at: '2026-07-14T12:00:03.000Z'
      }, 'realtime_insert');

      const records = lines.map((line) => JSON.parse(line.slice('[PRINT_PERF] '.length)));
      assert.deepEqual(printedRoutes, ['kitchen']);
      assert.equal(records.length, 2);
      assert.deepEqual(records.map((record) => [record.via, record.outcome]), [
        ['kitchen', 'printed'],
        ['counter', 'skipped']
      ]);
      assert.ok(records.every((record) => record.traceId === 'trace-legacy'));
      assert.ok(records.every((record) => record.pickupMs === 0));
      assert.ok(records.every((record) => record.totalMs >= record.pickupMs));
      assert.ok(records.every((record) => record.printer === ''));
      assert.ok(records.every((record) => record.renderMs === 0));
      assert.ok(records.every((record) => record.queueWaitMs === 0));
      assert.ok(records[0].spoolMs > records[0].claimMs);
      assert.equal(records[0].slowestStage, 'spool');
      assert.equal(records[1].spoolMs, 0);
    } finally {
      if (logger && originalLoggerInfo) logger.info = originalLoggerInfo;
      if (Settings && originalGetStorePrinters) Settings.getStorePrinters = originalGetStorePrinters;
      Module._load = originalLoad;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
