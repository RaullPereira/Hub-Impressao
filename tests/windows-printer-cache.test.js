const assert = require('node:assert/strict');
const os = require('node:os');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const winSpool = require('../src/main/printer/win-spool');
const WindowsPrinterManager = require('../src/main/printer/windows-manager');
const PairedPrintListener = require('../src/main/supabase/paired-print-listener');

async function run() {
  const originalListPrinters = winSpool.listPrinters;
  const originalGetDefaultPrinter = winSpool.getDefaultPrinter;
  let listCalls = 0;

  winSpool.listPrinters = async () => {
    listCalls += 1;
    return ['Impressora Termica'];
  };
  winSpool.getDefaultPrinter = async () => 'Impressora Termica';

  try {
    const manager = new WindowsPrinterManager();
    manager.printers = [{
      id: 'Impressora Termica',
      name: 'Impressora Termica',
      type: 'WINDOWS_SPOOLER',
      isDefault: true,
      status: 'ready'
    }];
    manager._lastRefreshAt = 0;

    const resolved = await manager.resolveAvailablePrinterName('Impressora Termica', { allowDefault: false });
    assert.equal(resolved, 'Impressora Termica');
    assert.equal(listCalls, 0, 'a impressão normal não deve bloquear em uma nova enumeração do Windows');

    const ensured = await manager.ensurePrinterAvailable('Impressora Termica');
    assert.equal(ensured, 'Impressora Termica');
    assert.equal(listCalls, 0, 'a validação anterior ao spool também deve reutilizar o cache');

    const missing = await manager.resolveAvailablePrinterName('Impressora Nova', { allowDefault: false });
    assert.equal(missing, null);
    assert.equal(listCalls, 1, 'cache miss deve permitir uma redescoberta forçada');

    let listenerRefreshCalls = 0;
    const listener = new PairedPrintListener({
      getPrinters: () => [{ id: 'Impressora Termica', name: 'Impressora Termica' }],
      refreshPrinters: async () => {
        listenerRefreshCalls += 1;
      }
    });

    await listener.refreshPrintersIfNeeded();
    assert.equal(listenerRefreshCalls, 0, 'o listener não deve repetir a descoberta quando o cache está preenchido');
    await listener.refreshPrintersIfNeeded(true);
    assert.equal(listenerRefreshCalls, 1, 'o caminho de recuperação deve continuar podendo forçar a descoberta');
  } finally {
    winSpool.listPrinters = originalListPrinters;
    winSpool.getDefaultPrinter = originalGetDefaultPrinter;
  }
}

run()
  .then(() => {
    console.log('windows-printer-cache.test.js: ok');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
  });
