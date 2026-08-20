// HTTP and modern WebSocket auto-print must use routed autoPrint.attendance,
// never the default printer, when routed mode is configured.
//
// Run: node tests/http-ws-auto-print-attendance-routing.test.js

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
const Settings = require('../src/main/config/settings');
const secureWsServer = require('../src/main/websocket/secure-server');

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

function listen(app) {
  return new Promise((resolve) => {
    const httpServer = app.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      resolve({ httpServer, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function patchSettings() {
  const originalGetStorePrinters = Settings.getStorePrinters;
  const originalGetPrinterForType = Settings.getPrinterForType;

  Settings.getStorePrinters = () => ({
    default: 'Default',
    kitchen: null,
    counter: null,
    delivery: null,
    autoPrint: {
      kitchen: null,
      attendance: 'Attendance'
    }
  });
  Settings.getPrinterForType = () => 'Default';

  return () => {
    Settings.getStorePrinters = originalGetStorePrinters;
    Settings.getPrinterForType = originalGetPrinterForType;
  };
}

(async () => {
  console.log('--- HTTP/WS attendance auto-print routing ---');

  const restoreSettings = patchSettings();
  try {
    {
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
          shouldDeferOrderUntilAccept() {
            return false;
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
        const response = await fetch(`${baseUrl}/api/print`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            printerId: null,
            printType: 'delivery',
            rawContent: Buffer.from('Pedido delivery').toString('base64'),
            useRawContent: true,
            isAutoPrint: true,
            orderData: {
              id: 'http-order-1',
              admin_client_id: 'store-1',
              order_type: 'delivery',
              status: 'preparing'
            }
          })
        });

        check('HTTP auto-print routed request succeeds', response.status, 200);
        check('HTTP auto-print uses attendance printer', printed.map((job) => job.printer), ['Attendance']);
        check('HTTP attendance auto-print uses counter receipt layout', printed.map((job) => job.printType), ['counter']);
        check('HTTP auto-print does not use default', printed.some((job) => job.printer === 'Default'), false);
      } finally {
        await new Promise((resolve) => httpServer.close(resolve));
      }
    }

    {
      const printed = [];
      const messages = [];
      secureWsServer.printerManager = {
        async print(job) {
          printed.push(job);
        },
        async refreshPrinters() {},
        getPrinters() {
          return [{ id: 'Default', name: 'Default' }];
        }
      };
      secureWsServer.pairedPrintListener = {
        isStoreAutoPrintEnabled() {
          return true;
        },
        shouldDeferOrderUntilAccept() {
          return false;
        },
        notifyOrderPrintingViaWebSocket() {},
        notifyOrderPrintedViaWebSocket() {},
        notifyOrderPrintFailedViaWebSocket() {}
      };

      await secureWsServer.handlePrint({
        send(message) {
          messages.push(JSON.parse(message));
        }
      }, {
        type: 'print',
        printType: 'delivery',
        rawContent: Buffer.from('Pedido delivery').toString('base64'),
        useRawContent: true,
        isAutoPrint: true,
        orderData: {
          id: 'ws-order-1',
          admin_client_id: 'store-1',
          order_type: 'delivery',
          status: 'preparing'
        }
      });

      check('WS auto-print returns success', messages.at(-1)?.success, true);
      check('WS auto-print uses attendance printer', printed.map((job) => job.printer), ['Attendance']);
      check('WS attendance auto-print uses counter receipt layout', printed.map((job) => job.printType), ['counter']);
      check('WS auto-print does not use default', printed.some((job) => job.printer === 'Default'), false);
    }
  } finally {
    restoreSettings();
    secureWsServer.printerManager = null;
    secureWsServer.pairedPrintListener = null;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
