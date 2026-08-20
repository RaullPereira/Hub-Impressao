// Valida retry de render oficial quando o JWT salvo no pareamento expirou.
//
// Rodar: node tests/render-session-refresh.test.js

const os = require('os');
const Module = require('module');
const originalLoad = Module._load;

let fetchCalls = [];

Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }

  if (request === '../utils/fetch' && parent?.filename?.endsWith('paired-print-listener.js')) {
    return async (url, options) => {
      fetchCalls.push({ url, options });

      if (fetchCalls.length === 1) {
        return {
          ok: false,
          status: 401,
          json: async () => ({ success: false, error: 'Token inválido ou expirado' })
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          payload: {
            rawContent: 'cmF3',
            encoding: 'base64',
            printType: 'counter'
          }
        })
      };
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

const PairedPrintListener = require('../src/main/supabase/paired-print-listener');

let pass = 0;
let fail = 0;

function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++;
    console.log('  ok  ' + name);
  } else {
    fail++;
    console.log('FAIL  ' + name + ' -> got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
  }
}

(async () => {
  console.log('--- render session refresh ---');

  let currentPairing = null;
  const pairingStore = {
    getPairing: () => currentPairing,
    savePairing: () => {},
    updatePairing: (patch) => {
      currentPairing = { ...currentPairing, ...patch };
    },
    clearPairing: () => {}
  };
  const listener = new PairedPrintListener(null, {
    adminClientId: 'store-1',
    pairingStore
  });

  listener.currentPairing = {
    adminClientId: 'store-1',
    appBaseUrl: 'http://localhost:3003',
    session: { access_token: 'stale-token', refresh_token: 'refresh-token' }
  };
  currentPairing = listener.currentPairing;

  const refreshCalls = [];
  listener.ensureSessionFresh = async (force = false) => {
    refreshCalls.push(force);
    if (force) {
      listener.currentPairing = {
        ...listener.currentPairing,
        session: { access_token: 'fresh-token', refresh_token: 'refresh-token' }
      };
    }
  };

  const payload = await listener.fetchRenderedPayload('order-1', 'counter');

  check('retorna payload depois do retry', payload.rawContent, 'cmF3');
  check('tentou render duas vezes', fetchCalls.length, 2);
  check('primeira tentativa usa token salvo', fetchCalls[0].options.headers.Authorization, 'Bearer stale-token');
  check('segunda tentativa usa token renovado', fetchCalls[1].options.headers.Authorization, 'Bearer fresh-token');
  check('refresh normal antes e forcado no 401', refreshCalls, [false, true]);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
