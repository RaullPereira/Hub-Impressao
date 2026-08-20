// Static release smoke checks for Hub Impressao 1.8.
//
// Run: node tests/release-1-8-smoke.test.js

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;

function read(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name} -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

console.log('--- release 1.8 smoke ---');

const packageJson = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));
const html = read('src/renderer/index.html');
const appJs = read('src/renderer/app.js');
const preload = read('src/preload.js');
const indexJs = read('src/main/index.js');
const secureWs = read('src/main/websocket/secure-server.js');
const expectedVersion = '1.9.2';

check('package version is 1.9.2', packageJson.version, expectedVersion);
check('package-lock root version is 1.9.2', packageLock.version, expectedVersion);
check('package-lock package version is 1.9.2', packageLock.packages[''].version, expectedVersion);
check('renderer shows version 1.9.2', html.includes(`v${expectedVersion}`), true);
check('renderer has no stale 1.7 UI version', html.includes('v1.7.0') || html.includes('v1.7.2'), false);
check('WebSocket handshake version is 1.9.2', secureWs.includes(`version: '${expectedVersion}'`), true);
check('UI uses Atendimento route wording', html.includes('Atendimento') || appJs.includes('Atendimento'), true);
check('preload exposes pairing status', preload.includes('getPairingStatus'), true);
check('preload exposes settings', preload.includes('getSettings'), true);
check('main process serves pairing status over IPC', indexJs.includes("ipcMain.handle('get-pairing-status'"), true);
check('main process serves settings over IPC', indexJs.includes("ipcMain.handle('get-settings'"), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
