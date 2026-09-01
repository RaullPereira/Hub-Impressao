const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const websocket = fs.readFileSync(path.join(root, 'src/main/websocket/secure-server.js'), 'utf8');
const listener = fs.readFileSync(path.join(root, 'src/main/supabase/paired-print-listener.js'), 'utf8');

assert.match(websocket, /version:\s*'1\.9\.5'/);
assert.match(websocket, /durablePrintIntents:\s*true/);
assert.match(websocket, /safeActivationCutoff:\s*true/);
assert.match(websocket, /backgroundUpdates:\s*true/);
assert.match(listener, /safeActivationAt/);
assert.match(listener, /safeActivationVersion/);

console.log('handshake capabilities: ok');
