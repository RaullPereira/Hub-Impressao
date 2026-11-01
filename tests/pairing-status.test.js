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
    kdsReadyPrintRoutes: ['counter'],
  });

  assert.strictEqual(listener.getStatus().autoPrintOnAcceptEnabled, true);
  assert.strictEqual(listener.getStatus().kdsReadyPrintEnabled, true);
  assert.deepStrictEqual(listener.getStatus().kdsReadyPrintRoutes, ['counter']);

  const multi = new MultiPairedPrintListener(null);
  multi.listeners.set('store-1', listener);
  assert.strictEqual(multi.getStatus('store-1').autoPrintOnAcceptEnabled, true);
  assert.strictEqual(multi.getStatus().pairings[0].autoPrintOnAcceptEnabled, true);
  assert.strictEqual(multi.getStatus().kdsReadyPrintEnabled, true);

  listener.printSettings.autoPrintEnabled = false;
  assert.strictEqual(multi.isStoreAutoPrintEnabled('store-1'), false);
  assert.strictEqual(multi.isStoreManualPrintEnabled('store-1'), true);

  // Desativar o pareamento continua bloqueando a loja, mesmo no clique manual.
  listener.currentPairing = { ...listener.pairingStore.getPairing(), enabled: false };
  assert.strictEqual(multi.isStoreManualPrintEnabled('store-1'), false);

  console.log('pairing status tests passed');
} finally {
  Module._load = originalLoad;
}
