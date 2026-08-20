// Teste standalone para o fallback HTTP de impressao.
// O clique manual deve imprimir mesmo quando "imprimir somente ao aceitar"
// esta ligado; apenas autoimpressao de pedido aguardando aceite deve ser adiada.
//
// Rodar: node tests/manual-print-http-defer.test.js

const os = require('os');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Server = require('../src/main/server');

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

function listen(app) {
  return new Promise((resolve) => {
    const httpServer = app.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      resolve({ httpServer, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

(async () => {
  console.log('--- manual print HTTP defer ---');

  const printed = [];
  const server = new Server(
    {
      async print(job) {
        printed.push(job);
      }
    },
    {
      isStoreAutoPrintEnabled() {
        return true;
      },
      shouldDeferOrderUntilAccept(_adminClientId, orderData) {
        return orderData?.source === 'digital_menu' && orderData?.status === 'awaiting';
      },
      notifyOrderPrintingViaWebSocket() {},
      notifyOrderPrintedViaWebSocket() {},
      notifyOrderPrintFailedViaWebSocket() {}
    }
  );

  server.setupMiddleware();
  server.setupRoutes();
  const { httpServer, baseUrl } = await listen(server.app);

  try {
    const manualResponse = await fetch(`${baseUrl}/api/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: 'Caixa',
        printType: 'counter',
        rawContent: Buffer.from('Pedido manual').toString('base64'),
        useRawContent: true,
        isAutoPrint: false,
        orderData: {
          id: 'manual-1',
          admin_client_id: 'store-1',
          source: 'digital_menu',
          status: 'awaiting'
        }
      })
    });

    check('clique manual nao e adiado', manualResponse.status, 200);
    check('clique manual imprime', printed.length, 1);

    const autoResponse = await fetch(`${baseUrl}/api/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: 'Caixa',
        printType: 'counter',
        rawContent: Buffer.from('Pedido automatico').toString('base64'),
        useRawContent: true,
        isAutoPrint: true,
        orderData: {
          id: 'auto-1',
          admin_client_id: 'store-1',
          source: 'digital_menu',
          status: 'awaiting'
        }
      })
    });

    check('autoimpressao aguardando aceite e adiada', autoResponse.status, 409);
    check('autoimpressao adiada nao imprime', printed.length, 1);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
