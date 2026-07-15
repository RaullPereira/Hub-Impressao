// Garante que auto_print_type=both respeita as duas vias no Hub Impressao.
//
// Rodar: node tests/auto-print-both-routing.test.js

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
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
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
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

function makeListener(printerMap, printOverride = null) {
  const printed = [];
  const listener = new PairedPrintListener({
    refreshPrinters: async () => {},
    print: async (job) => {
      printed.push(job);
      if (printOverride) await printOverride(job);
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
  listener.resolveAvailablePrinterId = async (type) => printerMap[type] || null;
  listener.resolvePrintPayload = async (_orderId, printType) => ({
    rawContent: Buffer.from(`via:${printType}`, 'utf8').toString('base64'),
    encoding: 'base64',
  });
  listener.fetchRenderedPayloads = async (_orderId, printTypes) => Object.fromEntries(
    printTypes.map((printType) => [printType, {
      rawContent: Buffer.from(`via:${printType}`, 'utf8').toString('base64'),
      encoding: 'base64',
    }])
  );

  return { listener, printed };
}

(async () => {
  console.log('--- auto print both routing ---');

  {
    const { listener, printed } = makeListener({
      kitchen: 'Printer Kitchen',
      counter: 'Printer Counter',
    });

    await listener.printWithRouting('order-1', 'both', null, { id: 'order-1' });

    check('imprime cozinha e completa em impressoras diferentes', printed.map((job) => job.printType), ['kitchen', 'counter']);
    check('usa impressoras configuradas por via', printed.map((job) => job.printer), ['Printer Kitchen', 'Printer Counter']);
  }

  {
    const { listener, printed } = makeListener({
      kitchen: 'Printer Shared',
      counter: 'Printer Shared',
    });

    await listener.printWithRouting('order-2', 'both', null, { id: 'order-2' });

    check('mesma impressora recebe payload combinado uma vez', printed.map((job) => job.printType), ['both']);
    check('payload combinado vai para impressora compartilhada', printed.map((job) => job.printer), ['Printer Shared']);
  }

  {
    const kitchenGate = deferred();
    const counterGate = deferred();
    const kitchenError = new Error('Kitchen failed');
    const { listener, printed } = makeListener({
      kitchen: 'Printer Kitchen',
      counter: 'Printer Counter',
    }, async (job) => {
      if (job.printer === 'Printer Kitchen') return kitchenGate.promise;
      return counterGate.promise;
    });

    let settled = false;
    let rejection = null;
    const operation = listener.printWithRouting('order-3', 'both', null, { id: 'order-3' });
    operation.then(
      () => { settled = true; },
      () => { settled = true; }
    );

    await flushMicrotasks();
    check('vias diferentes iniciam antes de qualquer gate resolver', printed.map((job) => job.printer), ['Printer Kitchen', 'Printer Counter']);

    kitchenGate.reject(kitchenError);
    await flushMicrotasks();
    check('falha de uma via aguarda a impressora irma terminar', settled, false);

    counterGate.resolve();
    try {
      await operation;
    } catch (error) {
      rejection = error;
    }

    check('both rejeita o primeiro erro depois de todas as vias', rejection === kitchenError, true);
    check('cada impressora recebe uma tarefa por tentativa', printed.map((job) => job.printer), ['Printer Kitchen', 'Printer Counter']);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
