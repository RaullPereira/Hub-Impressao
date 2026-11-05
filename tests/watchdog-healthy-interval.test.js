// Com o Realtime saudavel (status 'active'), o watchdog nao deve consultar o
// Supabase a cada 20s: as consultas pesadas (print_jobs pendentes, pedidos
// perdidos, configuracoes) rodam no maximo a cada 60s. Reconectando, ou no
// startup, tudo roda em todo ciclo, como antes.
//
// Rodar: node tests/watchdog-healthy-interval.test.js

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
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

function makeListener(status) {
  const listener = new PairedPrintListener(null, {
    adminClientId: 'store-1',
    pairingStore: {
      getPairing: () => ({ adminClientId: 'store-1', enabled: true }),
      savePairing: () => {},
      updatePairing: () => {},
      clearPairing: () => {}
    }
  });
  listener.currentPairing = { adminClientId: 'store-1', enabled: true };
  listener.status = status;
  listener.lastSettingsRefreshAt = Date.now();
  const calls = { pending: 0, recovery: 0, deferred: 0 };
  listener.ensureSessionFresh = async () => {};
  listener.refreshPrintSettings = async () => { listener.lastSettingsRefreshAt = Date.now(); };
  listener.processPendingJobs = async () => { calls.pending++; };
  listener.recoverMissedOrders = async () => { calls.recovery++; listener.lastRecoveryRunAt = Date.now(); };
  listener.recoverDeferredAcceptOrders = async () => { calls.deferred++; };
  return { listener, calls };
}

async function withClock(fn) {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await fn((ms) => { now += ms; });
  } finally {
    Date.now = realNow;
  }
}

(async () => {
  await withClock(async (advance) => {
    const { listener, calls } = makeListener('active');
    await listener.runWatchdog('startup');
    check('startup roda tudo', [calls.pending, calls.recovery], [1, 1]);

    advance(20000);
    await listener.runWatchdog('interval');
    advance(20000);
    await listener.runWatchdog('interval');
    check('saudavel: ciclos de 20s e 40s nao consultam', [calls.pending, calls.recovery], [1, 1]);
    check('saudavel: aceite adiado continua em todo ciclo', calls.deferred, 3);

    advance(20000);
    await listener.runWatchdog('interval');
    check('saudavel: aos 60s roda tudo de novo', [calls.pending, calls.recovery], [2, 2]);
  });

  await withClock(async (advance) => {
    const { listener, calls } = makeListener('reconnecting');
    await listener.runWatchdog('interval');
    advance(20000);
    await listener.runWatchdog('interval');
    advance(20000);
    await listener.runWatchdog('interval');
    check('reconectando: roda tudo a cada 20s', [calls.pending, calls.recovery], [3, 3]);
  });

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail ? 1 : 0);
})();
