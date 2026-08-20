'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

function read(relativePath) {
  return readFileSync(resolve(__dirname, '..', relativePath), 'utf8');
}

function check(label, actual, expected) {
  assert.equal(actual, expected, label);
}

const preload = read('src/preload.js');
const main = read('src/main/index.js');
const html = read('src/renderer/index.html');
const app = read('src/renderer/app.js');
const client = read('src/main/supabase/auto-print-intent-client.js');
const listener = read('src/main/supabase/paired-print-listener.js');

check('preload exposes attention list', preload.includes('getAutoPrintAttention'), true);
check('preload exposes resolution', preload.includes('resolveAutoPrintIntent'), true);
check('renderer offers retry', html.includes('Reimprimir agora') || app.includes('Reimprimir agora'), true);
check('renderer offers dismiss', html.includes('Dispensar') || app.includes('Dispensar'), true);
check('main registers attention IPC', main.includes("ipcMain.handle('get-auto-print-attention'"), true);
check('main registers validated resolution IPC', main.includes("ipcMain.handle('resolve-auto-print-intent'"), true);
check('client lists only operational attention fields', client.includes("select('id,order_id,status,eligibility_reason,attempt_count,last_error,attention_reason,operator_retry_at,created_at,updated_at,orders(order_number)')"), true);
check('client includes stale pending intents by effective retry time and migration fallback', client.includes('operator_retry_at.is.null,created_at.lt.${staleCutoff}') && client.includes('operator_retry_at.lt.${staleCutoff}') && client.includes("error?.code === '42P01' || error?.code === 'PGRST205'"), true);
check('listener exposes attention list and resolution', listener.includes('getAutoPrintAttention') && listener.includes('resolveAutoPrintIntent'), true);
check('renderer mounts the compact attention panel', html.includes('id="auto-print-attention"'), true);
check('renderer keeps attention actions load-aware', app.includes('resolveAttention') && app.includes("button.disabled = true"), true);
