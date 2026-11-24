// Impressora de rede cadastrada à mão (TCP:IP) aparece na lista para rotear, mesmo sem a busca achar.
const assert = require('node:assert/strict');
const os = require('node:os');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir() } };
  return originalLoad.call(this, request, parent, isMain);
};

const Settings = require('../src/main/config/settings');
const WindowsPrinterManager = require('../src/main/printer/windows-manager');

Settings.getManualPrinters = () => ['TCP:192.168.0.107:9100', 'POS80', 'TCP:192.168.0.50:9100'];
const manager = new WindowsPrinterManager();
manager.printers = [{ id: 'POS80', name: 'POS80', type: 'WINDOWS' }];
manager.networkPrinters = [{ id: 'TCP:192.168.0.50:9100', name: 'TCP:192.168.0.50:9100', type: 'NETWORK' }];
manager._refreshPromise = Promise.resolve();

const names = manager.getPrinters().map((printer) => printer.name);
assert.deepEqual(names, ['POS80', 'TCP:192.168.0.50:9100', 'TCP:192.168.0.107:9100']);
console.log('manual-network-printer-list: OK');
process.exit(0);
