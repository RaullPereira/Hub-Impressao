// Garante que pedidos criados offline e ja impressos no navegador nao sejam
// reimpressos pelo listener autonomo quando sincronizarem no Supabase.
//
// Rodar: node tests/offline-auto-print-skip.test.js

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
  if (got === want) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

(async () => {
  console.log('--- offline auto print skip ---');

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
    autoPrintType: 'counter'
  };

  let claimCalls = 0;
  let printCalls = 0;
  listener.hasPendingOrPrintedPrintJob = async () => false;
  listener.claimAutoPrintLedger = async () => {
    claimCalls++;
    return { id: 'claim-1' };
  };
  listener.printWithRouting = async () => {
    printCalls++;
  };

  await listener.handleAutoPrintOrder({
    id: 'remote-1',
    order_number: 10,
    origin: 'local',
    status: 'awaiting',
    custom_data: {
      offlineAutoPrintedAt: '2026-06-13T18:00:00.000Z',
      offlineLocalId: 'local_order_1'
    }
  }, 'realtime_insert');

  check('nao reivindica ledger', claimCalls, 0);
  check('nao imprime', printCalls, 0);
  check('marca como processado em memoria', listener.processedOrderIds.has('remote-1'), true);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
