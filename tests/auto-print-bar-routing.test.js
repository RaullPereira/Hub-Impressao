// Verifies routed auto-print mode supports an isolated bar route.
//
// Run: node tests/auto-print-bar-routing.test.js

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

let pass = 0;
let fail = 0;

function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name} -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

function makeListener(printerMap) {
  const printed = [];
  const claimed = [];
  const released = [];
  const listener = new PairedPrintListener({
    refreshPrinters: async () => {},
    print: async (job) => {
      printed.push(job);
    },
  }, {
    adminClientId: 'store-1',
    pairingStore: {
      getPairing: () => ({ adminClientId: 'store-1', enabled: true }),
      savePairing: () => {},
      updatePairing: () => {},
      clearPairing: () => {},
    },
  });

  listener.currentPairing = { adminClientId: 'store-1', appBaseUrl: 'http://localhost:3000' };
  listener.printSettings = {
    ...listener.printSettings,
    barPrintEnabled: true,
  };
  listener.resolveAutoPrintPrinterId = async (route) => printerMap[route] || null;
  listener.fetchRenderedPayloads = async (_orderId, printTypes) => Object.fromEntries(
    printTypes.map((printType) => [printType, {
      rawContent: Buffer.from(`via:${printType}`, 'utf8').toString('base64'),
      encoding: 'base64',
    }])
  );
  listener.claimAutoPrintLedger = async (_orderId, route) => {
    claimed.push(route);
    return { id: `claim-${route}` };
  };
  listener.releaseAutoPrintLedger = async (jobId) => {
    released.push(jobId);
  };

  return { listener, printed, claimed, released };
}

(async () => {
  console.log('--- auto print bar routing ---');

  const { listener, printed, claimed, released } = makeListener({
    kitchen: 'Kitchen',
    attendance: 'Attendance',
    bar: 'Bar',
    default: 'Default',
  });

  await listener.autoPrintPerPrinter({
    id: 'order-1',
    order_number: 1001,
    order_type: 'delivery',
    items: [
      { name: 'Pizza', category: 'Pizzas', quantity: 1 },
      { name: 'Coca-Cola', category: 'Bebidas', quantity: 2 },
    ],
  }, 'order-1', {
    kitchen: 'Kitchen',
    attendance: 'Attendance',
    counter: 'Attendance',
    delivery: 'Attendance',
    bar: 'Bar',
  }, 'test');

  check('delivery prints kitchen attendance and bar', printed.map((job) => job.printType), ['kitchen', 'counter', 'bar']);
  check('delivery uses each sector printer', printed.map((job) => job.printer), ['Kitchen', 'Attendance', 'Bar']);
  check('default printer is not used as routed fallback', printed.some((job) => job.printer === 'Default'), false);
  check('ledger is claimed by route including bar', claimed, ['kitchen', 'attendance', 'bar']);
  check('successful print does not release claims', released, []);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
