const assert = require('assert');
const Module = require('module');
const os = require('os');
const path = require('path');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath() {
          return path.join(os.tmpdir(), 'hub-impressao-test-user-data');
        }
      }
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

try {
  const PairedPrintListener = require('../src/main/supabase/paired-print-listener');
  const MultiPairedPrintListener = require('../src/main/supabase/multi-paired-print-listener');

  const listener = new PairedPrintListener(null, {
    adminClientId: 'store-1',
    pairingStore: {
      getPairing: () => ({
        adminClientId: 'store-1',
        enabled: true,
        appBaseUrl: 'https://app.pedidoshub.com',
        supabaseUrl: 'https://example.supabase.co',
        anonKey: 'anon',
        session: { access_token: 'token', refresh_token: 'refresh' },
      }),
      savePairing: () => {},
      updatePairing: () => {},
      clearPairing: () => {},
    },
  });

  listener.status = 'active';
  listener.printSettings = Object.assign({}, listener.printSettings, {
    autoPrintEnabled: true,
    autoPrintType: 'kitchen',
    autoPrintOnAcceptEnabled: true,
    kdsReadyPrintEnabled: true,
    kdsReadyPrintRoutes: ['counter', 'kitchen'],
  });

  assert.strictEqual(listener.getStatus().autoPrintOnAcceptEnabled, true);
  assert.strictEqual(listener.getStatus().kdsReadyPrintEnabled, true);
  assert.deepStrictEqual(listener.getStatus().kdsReadyPrintRoutes, ['counter', 'kitchen']);

  const multi = new MultiPairedPrintListener(null);
  multi.listeners.set('store-1', listener);
  assert.strictEqual(multi.getStatus('store-1').autoPrintOnAcceptEnabled, true);
  assert.strictEqual(multi.getStatus('store-1').kdsReadyPrintEnabled, true);
  assert.strictEqual(multi.getStatus().pairings[0].autoPrintOnAcceptEnabled, true);
  assert.deepStrictEqual(multi.getStatus().pairings[0].kdsReadyPrintRoutes, ['counter', 'kitchen']);

  console.log('pairing status tests passed');
} finally {
  Module._load = originalLoad;
}
