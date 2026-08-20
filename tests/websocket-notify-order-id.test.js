// WebSocket notification helpers must accept both legacy two-argument calls
// (adminClientId, orderId) and modern one-argument calls (orderId).
//
// Run: node tests/websocket-notify-order-id.test.js

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
  if (got === want) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name} -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

function makeListener() {
  const marked = [];
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
  listener.markOrderPrinted = async (orderId, printerType) => {
    marked.push({ orderId, printerType });
  };
  listener.marked = marked;
  return listener;
}

(async () => {
  console.log('--- websocket notify order id compatibility ---');

  {
    const listener = makeListener();
    listener.notifyOrderPrintingViaWebSocket('store-1', 'order-1');
    check('two-arg printing notification stores order id', listener.processingOrderIds.has('order-1'), true);
    check('two-arg printing notification does not store store id', listener.processingOrderIds.has('store-1'), false);
  }

  {
    const listener = makeListener();
    listener.notifyOrderPrintedViaWebSocket('store-1', 'order-2');
    await new Promise((resolve) => setTimeout(resolve, 0));
    check('two-arg printed notification stores order id', listener.processedOrderIds.has('order-2'), true);
    check('two-arg printed notification does not store store id', listener.processedOrderIds.has('store-1'), false);
    check('two-arg printed notification marks order id in ledger', listener.marked[0]?.orderId, 'order-2');
  }

  {
    const listener = makeListener();
    listener.notifyOrderPrintFailedViaWebSocket('store-1', 'order-3');
    check('two-arg failed notification removes order id from processing', listener.processingOrderIds.has('order-3'), false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
