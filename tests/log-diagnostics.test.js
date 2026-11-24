// Logs mais leves e exportaveis: mascara de segredos, leitura so do final do
// arquivo, compactacao de log antigo gigante, relatorio de diagnostico e
// cache das configuracoes (sem regravar o settings.json quando nada mudou).
//
// Rodar: node tests/log-diagnostics.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-log-diag-'));
const logsDir = path.join(userData, 'logs');
fs.mkdirSync(logsDir, { recursive: true });

// Log antigo gigante (Hubs ate 1.9.12 nao giravam o arquivo).
const hugeLine = `2026-11-07T10:00:00.000Z [info]: ${'x'.repeat(200)}\n`;
const hugeLog = path.join(logsDir, 'app.log');
const fd = fs.openSync(hugeLog, 'w');
for (let index = 0; index < 60000; index += 1) fs.writeSync(fd, hugeLine);
fs.writeSync(fd, '2026-11-07T23:59:59.000Z [info]: ULTIMA LINHA ANTIGA\n');
fs.closeSync(fd);
const hugeSize = fs.statSync(hugeLog).size;

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => userData } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const logger = require('../src/main/utils/logger');
const Settings = require('../src/main/config/settings');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

(async () => {
  console.log('--- log diagnostics ---');

  await test('compacta log antigo gigante ao iniciar e guarda o final', async () => {
    assert.ok(hugeSize > 10 * 1024 * 1024, `fixture deveria passar de 10 MB (${hugeSize})`);
    const size = fs.statSync(hugeLog).size;
    assert.ok(size <= 5 * 1024 * 1024 + 1024, `log deveria cair para ~5 MB, ficou ${size}`);
    const tail = fs.readFileSync(hugeLog, 'utf8');
    assert.ok(tail.includes('ULTIMA LINHA ANTIGA'));
    assert.ok(tail.startsWith(new Date().toISOString().slice(0, 4)));
  });

  await test('mascara tokens, chaves e JWT em qualquer formato', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstu';
    const raw = [
      '{"access_token":"segredo-acesso-123","refresh_token":"segredo-refresh-456"}',
      '{"raw":"{\\"type\\":\\"print\\",\\"token\\":\\"123456\\"}"}',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      `anonKey=${jwt}`,
      `sessao ${jwt}`
    ].join('\n');
    const masked = logger.redactSecrets(raw);
    for (const secret of ['segredo-acesso-123', 'segredo-refresh-456', '123456', 'abcdefghijklmnopqrstuvwxyz', jwt]) {
      assert.ok(!masked.includes(secret), `vazou ${secret}: ${masked}`);
    }
    assert.ok(masked.includes('"type\\":\\"print'), 'nao deve mascarar campos comuns');
  });

  await test('getRecentLogs devolve as ultimas linhas sem ler o arquivo todo', async () => {
    const printLog = path.join(logsDir, 'print.log');
    const lines = Array.from({ length: 50 }, (_, index) => `2026-11-07T20:00:${String(index).padStart(2, '0')}.000Z [info]: [PRINT] linha ${index}`);
    fs.writeFileSync(printLog, `${lines.join('\n')}\n`);
    const recent = logger.getRecentLogs({ type: 'print', limit: 3 });
    assert.deepStrictEqual(recent, lines.slice(-3));
    assert.deepStrictEqual(logger.getRecentLogs({ type: 'qualquer', limit: 1 }), lines.slice(-1));
  });

  await test('relatorio de diagnostico tem cabecalho, lojas, logs e nenhum segredo', async () => {
    fs.appendFileSync(path.join(logsDir, 'error.log'), '2026-11-07T21:00:00.000Z [error]: falha {"access_token":"vazou-no-erro"}\n');
    const report = logger.buildDiagnosticReport({
      appVersion: '9.9.9',
      statuses: [{ storeName: 'Casa da Pizza', active: true, adminClientId: '52a037e8' }],
      settingsSummary: { impressorasPorLoja: { '52a037e8': { attendance: 'EPSON' } } }
    });
    assert.ok(report.includes('Versão: 9.9.9'));
    assert.ok(report.includes('Casa da Pizza'));
    assert.ok(report.includes('=== error.log'));
    assert.ok(report.includes('=== print.log'));
    assert.ok(report.includes('=== app.log'));
    assert.ok(report.includes('[PRINT] linha 49'));
    assert.ok(!report.includes('vazou-no-erro'));
    assert.ok(Buffer.byteLength(report) < 6 * 1024 * 1024, 'relatorio deve ficar abaixo de 6 MB');
  });

  await test('configuracoes: le do disco uma vez, devolve copia e nao regrava sem mudanca', async () => {
    Settings.resetCacheForTests();
    const originalWrite = fs.writeFileSync;
    const originalRead = fs.readFileSync;
    let settingsWrites = 0;
    let settingsReads = 0;
    const settingsFile = path.join(userData, 'settings.json');
    fs.writeFileSync = function (file, ...rest) {
      if (file === settingsFile) settingsWrites += 1;
      return originalWrite.call(this, file, ...rest);
    };
    fs.readFileSync = function (file, ...rest) {
      if (file === settingsFile) settingsReads += 1;
      return originalRead.call(this, file, ...rest);
    };
    try {
      Settings.savePairing({ adminClientId: 'store-1', storeName: 'Loja 1', lastSeenAt: '2026-11-07T20:00:00.000Z' });
      const writesAfterFirstSave = settingsWrites;
      assert.strictEqual(writesAfterFirstSave >= 1, true);

      const copy = Settings.getAll();
      copy.pairings['store-1'].storeName = 'ALTERADA FORA';
      assert.strictEqual(Settings.getPairing('store-1').storeName, 'Loja 1', 'getAll deve devolver copia');

      Settings.updatePairing('store-1', { storeName: 'Loja 1' });
      assert.strictEqual(settingsWrites, writesAfterFirstSave, 'sem mudanca nao deve gravar');

      Settings.updatePairing('store-1', { lastSeenAt: '2026-11-07T20:01:00.000Z' });
      assert.strictEqual(settingsWrites, writesAfterFirstSave + 1, 'mudanca real grava uma vez');

      for (let index = 0; index < 20; index += 1) Settings.getStorePrinters('store-1');
      assert.ok(settingsReads <= 1, `deveria ler o arquivo no maximo 1x, leu ${settingsReads}`);

      Settings.resetCacheForTests();
      assert.strictEqual(Settings.getPairing('store-1').lastSeenAt, '2026-11-07T20:01:00.000Z', 'o disco tem a ultima versao');
    } finally {
      fs.writeFileSync = originalWrite;
      fs.readFileSync = originalRead;
    }
  });

  await test('heartbeat grava no disco no maximo 1x por minuto e mantem a memoria atual', async () => {
    const PairedPrintListener = require('../src/main/supabase/paired-print-listener');
    let persisted = 0;
    let stored = { adminClientId: 'store-1', enabled: true, lastSeenAt: null };
    const listener = new PairedPrintListener(null, {
      adminClientId: 'store-1',
      pairingStore: {
        getPairing: () => ({ ...stored }),
        savePairing: () => {},
        updatePairing: (partial) => { persisted += 1; stored = { ...stored, ...partial }; },
        clearPairing: () => {}
      }
    });
    listener.currentPairing = { ...stored };
    listener.touchHeartbeat();
    listener.touchHeartbeat();
    listener.touchHeartbeat();
    assert.strictEqual(persisted, 1);
    assert.ok(listener.currentPairing.lastSeenAt, 'memoria deve ter o heartbeat atual');
    listener.lastHeartbeatPersistAt = Date.now() - 61 * 1000;
    listener.touchHeartbeat();
    assert.strictEqual(persisted, 2);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(userData, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
})();
