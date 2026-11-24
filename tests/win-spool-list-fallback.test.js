const assert = require('assert');
const Module = require('module');
const os = require('os');
const path = require('path');

// Cenário da Pizza do 20: PowerShell bloqueado, sem wmic; a impressora só
// aparece no Registro do Windows.
const commands = [];
let responses = {};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => path.join(os.tmpdir(), 'hub-impressao-test-user-data') } };
  }
  if (request === 'child_process') {
    const real = originalLoad.call(this, request, parent, isMain);
    return {
      ...real,
      exec(command, options, callback) {
        commands.push(command);
        const key = Object.keys(responses).find((prefix) => command.includes(prefix));
        const value = key ? responses[key] : new Error('Command failed: ' + command);
        if (value instanceof Error) callback(value);
        else callback(null, { stdout: value, stderr: '' });
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  try {
    const winSpool = require('../src/main/printer/win-spool');

    // Tudo falha menos o Registro.
    responses = {
      'Devices"': `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Devices
    POS-58(copy of 1)    REG_SZ    winspool,Ne01:
`,
      'Print\\Printers"': `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Print\\Printers
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Print\\Printers\\POS-58(copy of 1)
`
    };
    assert.deepStrictEqual(await winSpool.listPrinters(), ['POS-58(copy of 1)']);
    assert.ok(commands.some((c) => c.includes('Get-Printer')), 'tenta PowerShell primeiro');
    assert.ok(commands.some((c) => c.startsWith('reg query')), 'cai no Registro no fim');

    // PowerShell responde vazio: segue para as próximas tentativas.
    commands.length = 0;
    responses = { 'Get-Printer': '\r\n', wmic: 'Name=EPSON TM-T20\r\n' };
    assert.deepStrictEqual(await winSpool.listPrinters(), ['EPSON TM-T20']);
    assert.ok(!commands.some((c) => c.startsWith('reg query')), 'não consulta o Registro quando já achou');

    // PowerShell funcionando: caminho normal, um comando só.
    commands.length = 0;
    responses = { 'Get-Printer': 'POS-80\r\n' };
    assert.deepStrictEqual(await winSpool.listPrinters(), ['POS-80']);
    assert.strictEqual(commands.length, 1);

    console.log('win-spool list fallback tests passed');
  } finally {
    Module._load = originalLoad;
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
