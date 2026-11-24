// Atualizacao automatica: so no Hub principal do Windows; baixa sozinho, mas so
// instala com clique e depois que a impressao em andamento terminar.
//
// Rodar: node tests/updater.test.js
const assert = require('assert');
const { EventEmitter } = require('events');
const os = require('os');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { HubUpdater, isAutoUpdateSupported } = require('../src/main/updater');

const SUPPORTED_ENV = {
  platform: 'win32',
  isPackaged: true,
  variantName: undefined,
  electronVersion: '28.3.3',
  currentVersion: '1.9.17'
};

function createFakeAutoUpdater() {
  const fake = new EventEmitter();
  fake.checks = 0;
  fake.installs = [];
  fake.checkForUpdates = async () => { fake.checks += 1; return null; };
  fake.quitAndInstall = (...args) => { fake.installs.push(args); };
  return fake;
}

function createUpdater({ isBusy, env = SUPPORTED_ENV } = {}) {
  const fake = createFakeAutoUpdater();
  const timers = {
    setTimeout: () => 1,
    setInterval: () => 2,
    clearTimeout: () => {},
    clearInterval: () => {}
  };
  const updater = new HubUpdater({ isBusy, loadAutoUpdater: () => fake, environment: env, timers });
  return { updater, fake };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('only the packaged main Windows build updates itself', () => {
  assert.strictEqual(isAutoUpdateSupported(SUPPORTED_ENV), true);
  assert.strictEqual(isAutoUpdateSupported({ ...SUPPORTED_ENV, platform: 'darwin' }), false);
  assert.strictEqual(isAutoUpdateSupported({ ...SUPPORTED_ENV, isPackaged: false }), false);
  assert.strictEqual(isAutoUpdateSupported({ ...SUPPORTED_ENV, variantName: 'senhas' }), false);
  assert.strictEqual(isAutoUpdateSupported({ ...SUPPORTED_ENV, electronVersion: '22.3.27' }), false);
});

test('unsupported build never loads electron-updater', () => {
  let loaded = false;
  const updater = new HubUpdater({
    loadAutoUpdater: () => { loaded = true; return createFakeAutoUpdater(); },
    environment: { ...SUPPORTED_ENV, platform: 'darwin' }
  });
  assert.strictEqual(updater.start(), false);
  assert.strictEqual(loaded, false);
  assert.strictEqual(updater.getState().status, 'disabled');
});

test('downloads in background but never installs on quit by itself', async () => {
  const { updater, fake } = createUpdater();
  assert.strictEqual(updater.start(), true);
  assert.strictEqual(fake.autoDownload, true);
  assert.strictEqual(fake.autoInstallOnAppQuit, false);
  assert.strictEqual(fake.allowDowngrade, false);

  await updater.checkNow();
  assert.strictEqual(fake.checks, 1);
  fake.emit('update-available', { version: '1.9.18' });
  assert.strictEqual(updater.getState().status, 'downloading');
  fake.emit('download-progress', { percent: 42.4 });
  assert.strictEqual(updater.getState().percent, 42);
  fake.emit('update-downloaded', { version: '1.9.18' });
  assert.strictEqual(updater.getState().status, 'ready');
  assert.strictEqual(updater.getState().version, '1.9.18');
  assert.strictEqual(fake.installs.length, 0);

  await updater.checkNow();
  assert.strictEqual(fake.checks, 1, 'nao verifica de novo com atualizacao pronta');
});

test('install waits for printing to finish, then installs silently and reopens', async () => {
  let busy = true;
  const { updater, fake } = createUpdater({ isBusy: () => busy });
  updater.start();
  fake.emit('update-downloaded', { version: '1.9.18' });
  setTimeout(() => { busy = false; }, 600);
  const result = await updater.installNow();
  assert.deepStrictEqual(result, { success: true });
  assert.deepStrictEqual(fake.installs, [[true, true]]);
});

test('install gives up while printing stays busy and keeps the update ready', async () => {
  const { updater, fake } = createUpdater({ isBusy: () => true });
  updater.start();
  fake.emit('update-downloaded', { version: '1.9.18' });
  const realWait = updater.waitUntilIdle.bind(updater);
  updater.waitUntilIdle = () => realWait(50);
  const result = await updater.installNow();
  assert.strictEqual(result.success, false);
  assert.strictEqual(fake.installs.length, 0);
  assert.strictEqual(updater.getState().status, 'ready');
});

test('install without a downloaded update does nothing', async () => {
  const { updater, fake } = createUpdater();
  updater.start();
  const result = await updater.installNow();
  assert.strictEqual(result.success, false);
  assert.strictEqual(fake.installs.length, 0);
});

test('feed errors keep the Hub running and a ready update stays ready', async () => {
  const { updater, fake } = createUpdater();
  updater.start();
  fake.emit('error', new Error('HttpError: 404\nlatest.yml'));
  assert.strictEqual(updater.getState().status, 'idle');
  assert.strictEqual(updater.getState().error, 'HttpError: 404');
  fake.emit('update-downloaded', { version: '1.9.18' });
  fake.emit('error', new Error('rede caiu'));
  assert.strictEqual(updater.getState().status, 'ready');
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL  ${name}`);
      console.log(error);
    }
  }
  console.log(`${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
