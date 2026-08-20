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
  const winSpool = require('../src/main/printer/win-spool');
  const {
    parsePrinterList,
    parseRegistryPrinters,
    parseRegistryPrinterKeys,
    parseDefaultPrinterFromRegistry,
    bufferToPrintableText
  } = winSpool.__private;

  assert.deepStrictEqual(
    parsePrinterList('Name\r\r\nPOS-58\r\r\nIMPRESSORA PIZZA DE 20\r\r\n'),
    ['POS-58', 'IMPRESSORA PIZZA DE 20']
  );

  assert.deepStrictEqual(
    parsePrinterList('Name=POS-58\r\r\n\r\r\nName=IMPRESSORA PIZZA DE 20\r\r\n'),
    ['POS-58', 'IMPRESSORA PIZZA DE 20']
  );

  const utf16Like = 'N\u0000a\u0000m\u0000e\u0000\r\u0000\r\u0000\n\u0000P\u0000O\u0000S\u0000-\u00005\u00008\u0000\r\u0000\r\u0000\n\u0000';
  assert.deepStrictEqual(parsePrinterList(utf16Like), ['POS-58']);

  assert.deepStrictEqual(
    parseRegistryPrinters(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Devices
    IMPRESSORA PIZZA DE 20    REG_SZ    winspool,Ne01:
    POS-58    REG_SZ    winspool,Ne02:
`),
    ['IMPRESSORA PIZZA DE 20', 'POS-58']
  );

  assert.deepStrictEqual(
    parseRegistryPrinterKeys(`
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Print\\Printers
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Print\\Printers\\IMPRESSORA PIZZA DE 20
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Print\\Printers\\POS-58
`),
    ['IMPRESSORA PIZZA DE 20', 'POS-58']
  );

  assert.strictEqual(
    parseDefaultPrinterFromRegistry(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows
    Device    REG_SZ    POS-58,winspool,Ne02:
`),
    'POS-58'
  );

  const printable = bufferToPrintableText(Buffer.concat([
    Buffer.from([0x1B, 0x40, 0x1B, 0x61, 0x01]),
    Buffer.from('Hub Impressao\r\nTeste OK\r\n', 'latin1'),
    Buffer.from([0x1D, 0x56, 0x00])
  ]));
  assert.strictEqual(printable, 'Hub Impressao\r\nTeste OK\r\n');

  console.log('win-spool parser tests passed');
} finally {
  Module._load = originalLoad;
}
