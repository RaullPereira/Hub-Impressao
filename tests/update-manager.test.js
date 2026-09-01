const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const UpdateManager = require('../src/main/update/update-manager');

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = false;
    this.autoInstallOnAppQuit = false;
    this.checkCalls = 0;
    this.quitCalls = 0;
    this.pendingCheck = null;
  }

  checkForUpdates() {
    this.checkCalls += 1;
    this.pendingCheck = {};
    this.pendingCheck.promise = new Promise((resolve, reject) => {
      this.pendingCheck.resolve = resolve;
      this.pendingCheck.reject = reject;
    });
    return this.pendingCheck.promise;
  }

  quitAndInstall() {
    this.quitCalls += 1;
  }
}

(async () => {
  const updater = new FakeUpdater();
  const scheduled = [];
  const cleared = [];
  const states = [];
  const manager = new UpdateManager({
    autoUpdater: updater,
    isPackaged: true,
    platform: 'win32',
    initialDelayMs: 1_000,
    intervalMs: 60_000,
    retryDelayMs: 10_000,
    setTimeoutImpl: (callback, delay) => {
      const token = { callback, delay };
      scheduled.push(token);
      return token;
    },
    clearTimeoutImpl: (token) => cleared.push(token),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    onStatus: (status) => states.push(status)
  });

  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);

  const startStatus = manager.start();
  assert.equal(startStatus.state, 'idle');
  assert.equal(updater.checkCalls, 0, 'startup must not wait for the network');
  assert.equal(scheduled[0].delay, 1_000);

  scheduled.shift().callback();
  assert.equal(updater.checkCalls, 1);
  assert.equal(manager.getStatus().state, 'checking');

  updater.emit('update-available', { version: '1.9.6' });
  assert.equal(manager.getStatus().state, 'available');
  assert.equal(manager.getStatus().availableVersion, '1.9.6');

  updater.emit('download-progress', { percent: 42.25, transferred: 42, total: 100 });
  assert.deepEqual(manager.getStatus(), {
    state: 'downloading',
    currentVersion: manager.getStatus().currentVersion,
    availableVersion: '1.9.6',
    readyVersion: null,
    progressPercent: 42.25,
    transferredBytes: 42,
    totalBytes: 100,
    lastCheckedAt: manager.getStatus().lastCheckedAt,
    errorCode: null
  });

  updater.emit('update-downloaded', { version: '1.9.6' });
  assert.equal(manager.getStatus().state, 'ready');
  assert.equal(manager.getStatus().readyVersion, '1.9.6');
  assert.equal(updater.quitCalls, 0, 'download completion must never restart the Hub');

  assert.equal(manager.installNow(), true);
  assert.equal(manager.installNow(), false, 'explicit install is single-shot');
  assert.equal(updater.quitCalls, 1);

  updater.pendingCheck.resolve({ updateInfo: { version: '1.9.6' } });
  await Promise.resolve();
  assert.ok(states.some(({ state }) => state === 'ready'));

  manager.dispose();
  assert.ok(cleared.length >= 1);

  const failingUpdater = new FakeUpdater();
  const retrySchedule = [];
  const failingManager = new UpdateManager({
    autoUpdater: failingUpdater,
    isPackaged: true,
    platform: 'win32',
    retryDelayMs: 5_000,
    setTimeoutImpl: (callback, delay) => {
      retrySchedule.push({ callback, delay });
      return retrySchedule.at(-1);
    },
    clearTimeoutImpl: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });

  const failedCheck = failingManager.checkNow();
  failingUpdater.pendingCheck.reject(Object.assign(new Error('private network details'), { code: 'ERR_UPDATER_OFFLINE' }));
  await failedCheck;
  assert.equal(failingManager.getStatus().state, 'error');
  assert.equal(failingManager.getStatus().errorCode, 'ERR_UPDATER_OFFLINE');
  assert.equal(retrySchedule.at(-1).delay, 5_000);

  console.log('update manager: ok');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
