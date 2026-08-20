// Explicit printer targets sent by Pedidos Hub must not be replaced by the
// store default route. This protects per-printer auto-print during sync lag and
// manual route-specific prints.
//
// Run: node tests/explicit-printer-route-priority.test.js

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
  let currentPrinters = {
    default: 'DeliveryCounter',
    kitchen: null,
    counter: 'DeliveryCounter',
    delivery: 'DeliveryCounter',
    autoPrint: null
  };

  Settings.getStorePrinters = () => currentPrinters;
  Settings.getPrinterForType = () => 'DeliveryCounter';

  return {
    setPrinters(nextPrinters) {
      currentPrinters = nextPrinters;
    },
    restore() {
      Settings.getStorePrinters = originalGetStorePrinters;
      Settings.getPrinterForType = originalGetPrinterForType;
    }
  };
}

(async () => {
  console.log('--- explicit printer route priority ---');

  const settingsPatch = patchSettings();
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
            printerId: 'KitchenExplicit',
            printType: 'kitchen',
            rawContent: Buffer.from('Kitchen ticket').toString('base64'),
            useRawContent: true,
            isAutoPrint: true,
            orderData: {
              id: 'http-explicit-kitchen',
              admin_client_id: 'store-1',
              status: 'preparing'
            }
          })
        });

        check('HTTP explicit kitchen request succeeds', response.status, 200);
        check('HTTP explicit kitchen printer is not replaced by default', printed.map((job) => job.printer), ['KitchenExplicit']);
        check('HTTP explicit kitchen keeps kitchen layout', printed.map((job) => job.printType), ['kitchen']);
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
          return [{ id: 'DeliveryCounter', name: 'DeliveryCounter' }];
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
        printer: 'KitchenExplicit',
        printType: 'kitchen',
        rawContent: Buffer.from('Kitchen ticket').toString('base64'),
        useRawContent: true,
        isAutoPrint: true,
        orderData: {
          id: 'ws-explicit-kitchen',
          admin_client_id: 'store-1',
          status: 'preparing'
        }
      });

      check('WS explicit kitchen request succeeds', messages.at(-1)?.success, true);
      check('WS explicit kitchen printer is not replaced by default', printed.map((job) => job.printer), ['KitchenExplicit']);
      check('WS explicit kitchen keeps kitchen layout', printed.map((job) => job.printType), ['kitchen']);
    }

    settingsPatch.setPrinters({
      default: 'DeliveryCounter',
      kitchen: 'DeliveryCounter',
      counter: 'DeliveryCounter',
      delivery: 'DeliveryCounter',
      autoPrint: {
        kitchen: 'DeliveryCounter',
        attendance: 'DeliveryCounter'
      }
    });

    {
      const printed = [];
      const messages = [];
      secureWsServer.printerManager = {
        async print(job) {
          printed.push(job);
        },
        async refreshPrinters() {},
        getPrinters() {
          return [{ id: 'DeliveryCounter', name: 'DeliveryCounter' }];
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
        printer: 'KitchenExplicit',
        printType: 'kitchen',
        rawContent: Buffer.from('Kitchen ticket').toString('base64'),
        useRawContent: true,
        isAutoPrint: true,
        orderData: {
          id: 'ws-explicit-kitchen-with-stale-map',
          admin_client_id: 'store-1',
          status: 'preparing'
        }
      });

      check('WS explicit kitchen request succeeds with stale routed map', messages.at(-1)?.success, true);
      check('WS explicit kitchen printer beats stale routed map', printed.map((job) => job.printer), ['KitchenExplicit']);
      check('WS explicit kitchen still keeps kitchen layout with stale routed map', printed.map((job) => job.printType), ['kitchen']);
    }
  } finally {
    settingsPatch.restore();
    secureWsServer.printerManager = null;
    secureWsServer.pairedPrintListener = null;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
