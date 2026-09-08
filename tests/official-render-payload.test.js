// Valida a escolha de payload do Hub de Impressao:
// - print_job com rawContent sempre tem prioridade
// - pedido interno sem rawContent embutido sempre busca o render oficial remoto
//   para manter um unico estilo de via balcão/cozinha.
//
// Rodar: node tests/official-render-payload.test.js

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
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

async function checkRejects(name, fn, expectedText) {
  try {
    await fn();
    fail++;
    console.log(`FAIL  ${name} -> resolved, want rejection`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const ok = message.includes(expectedText);
    if (ok) {
      pass++;
      console.log(`  ok  ${name}`);
    } else {
      fail++;
      console.log(`FAIL  ${name} -> got ${JSON.stringify(message)}, want text ${JSON.stringify(expectedText)}`);
    }
  }
}

function makeListener() {
  const listener = new PairedPrintListener(null, {
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
    appBaseUrl: 'https://app.pedidoshub.com',
    session: { access_token: 'token' }
  };

  return listener;
}

(async () => {
  console.log('--- official render payload ---');

  {
    const listener = makeListener();
    let remoteCalls = 0;
    listener.fetchRenderedPayload = async (orderId, printType) => {
      remoteCalls++;
      return { rawContent: `official:${orderId}:${printType}`, encoding: 'base64' };
    };

    const payload = await listener.resolvePrintPayload('order-1', 'counter', null, {
      id: 'order-1',
      order_number: 4,
      items: [{ name: 'Pizza', quantity: 1 }]
    });

    check('pedido com itens inline usa render oficial', payload.rawContent, 'official:order-1:counter');
    check('chama render oficial quando ha itens inline', remoteCalls, 1);
  }

  {
    const listener = makeListener();
    listener.currentPairing.appBaseUrl = 'http://dev.pedidoshub.localhost:3003';
    let remoteCalls = 0;
    listener.fetchRenderedPayload = async (orderId, printType) => {
      remoteCalls++;
      return { rawContent: `local-dev:${orderId}:${printType}`, encoding: 'base64' };
    };

    const payload = await listener.resolvePrintPayload('order-local', 'counter', null, {
      id: 'order-local',
      order_number: 14,
      items: JSON.stringify([{ name: 'Pizza', quantity: 1 }])
    });

    check('itens inline em JSON tambem usam render oficial', payload.rawContent, 'local-dev:order-local:counter');
    check('dev local chama render oficial quando ha itens inline', remoteCalls, 1);
  }

  {
    const listener = makeListener();
    listener.fetchRenderedPayload = async () => {
      throw new Error('render indisponivel');
    };

    await checkRejects(
      'pedido sem rawContent depende do render oficial',
      () => listener.resolvePrintPayload('order-2', 'counter', null, {
        id: 'order-2',
        order_number: 5
      }),
      'render indisponivel'
    );
  }

  {
    const listener = makeListener();
    let remoteCalls = 0;
    listener.fetchRenderedPayload = async () => {
      remoteCalls++;
      return { rawContent: 'remote-layout', encoding: 'base64' };
    };

    const payload = await listener.resolvePrintPayload('order-3', 'counter', {
      content: {
        rawContent: 'inline-job',
        encoding: 'base64'
      }
    });

    check('print_job com rawContent continua tendo prioridade', payload.rawContent, 'inline-job');
    check('nao chama render oficial quando job ja tem rawContent', remoteCalls, 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
