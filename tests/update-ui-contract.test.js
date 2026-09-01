const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const main = read('src/main/index.js');
const preload = read('src/preload.js');
const html = read('src/renderer/index.html');
const renderer = read('src/renderer/app.js');
const tray = read('src/main/tray.js');

assert.match(main, /new UpdateManager/);
assert.match(main, /ipcMain\.handle\('get-update-status'/);
assert.match(main, /ipcMain\.handle\('check-for-updates'/);
assert.match(main, /ipcMain\.handle\('install-update-now'/);
assert.match(preload, /getUpdateStatus/);
assert.match(preload, /checkForUpdates/);
assert.match(preload, /installUpdateNow/);
assert.match(preload, /onUpdateStatus/);
assert.match(html, /id="update-status"/);
assert.match(html, /id="install-update-now"/);
assert.match(renderer, /Atualiza[cç][aã]o pronta/i);
assert.match(html, /Reiniciar e atualizar agora/);
assert.match(tray, /Reiniciar e atualizar agora/);
assert.match(tray, /state === 'ready'/);

console.log('update UI contract: ok');
