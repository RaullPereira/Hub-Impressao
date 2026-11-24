// Render oficial fora do ar (rede, timeout, 5xx): o Hub usa o layout local
// para a comanda nao deixar de sair. 4xx e pedido sem itens continuam falhando.
//
// Run: node tests/render-local-fallback.test.js

const assert = require('assert');
const os = require('os');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const PairedPrintListener = require('../src/main/supabase/paired-print-listener');

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

function response(status, raw) {
  return { ok: status >= 200 && status < 300, status, json: async () => raw };
}

function makeListener(fetchImpl) {
  const listener = new PairedPrintListener(null, {
    adminClientId: 'store-1',
    fetchImpl,
    pairingStore: {
      getPairing: () => ({ adminClientId: 'store-1', enabled: true }),
      savePairing: () => {},
      updatePairing: () => {},
      clearPairing: () => {}
    }
  });
  listener.currentPairing = {
    adminClientId: 'store-1',
    appBaseUrl: 'https://app.pedidoshub.com/',
    session: { access_token: 'token-1', refresh_token: 'refresh-token' }
  };
  listener.ensureSessionFresh = async () => {};
  return listener;
}

const order = {
  id: 'order-1',
  order_number: 20,
  order_type: 'delivery',
  customer_name: 'Cliente',
  total: 32.99,
  items: [{ name: 'Pizza Pequena', quantity: 1, unitPrice: 29.99, totalPrice: 29.99 }]
};

function decode(payload) {
  return Buffer.from(payload.rawContent, 'base64').toString('binary');
}

(async () => {
  console.log('--- render local fallback ---');

  await test('HTTP 500 usa layout local com os itens do pedido', async () => {
    const listener = makeListener(async () => response(500, { error: 'ERR_MODULE_NOT_FOUND' }));
    const payload = await listener.resolvePrintPayload('order-1', 'counter', null, order);
    assert.strictEqual(payload.localFallback, true);
    assert.ok(decode(payload).toUpperCase().includes('PIZZA PEQUENA'));
  });

  await test('falha de rede usa layout local', async () => {
    const listener = makeListener(async () => { throw new TypeError('fetch failed'); });
    const payload = await listener.resolvePrintPayload('order-1', 'kitchen', null, order);
    assert.strictEqual(payload.localFallback, true);
  });

  await test('itens em JSON texto tambem funcionam', async () => {
    const listener = makeListener(async () => response(503, {}));
    const payload = await listener.resolvePrintPayload('order-1', 'counter', null, {
      ...order,
      items: JSON.stringify(order.items)
    });
    assert.strictEqual(payload.localFallback, true);
  });

  await test('varias vias caem juntas no layout local', async () => {
    const listener = makeListener(async () => response(502, {}));
    const payloads = await listener.fetchRenderedPayloads('order-1', ['kitchen', 'counter'], order);
    assert.strictEqual(payloads.kitchen.localFallback, true);
    assert.strictEqual(payloads.counter.localFallback, true);
  });

  await test('HTTP 404 continua falhando', async () => {
    const listener = makeListener(async () => response(404, { error: 'Pedido nao encontrado' }));
    await assert.rejects(
      () => listener.resolvePrintPayload('order-1', 'counter', null, order),
      /Pedido nao encontrado/
    );
  });

  await test('pedido sem itens continua falhando', async () => {
    const listener = makeListener(async () => response(500, {}));
    await assert.rejects(
      () => listener.resolvePrintPayload('order-1', 'counter', null, { id: 'order-1' }),
      /HTTP 500/
    );
  });

  await test('render ok nao usa layout local', async () => {
    const listener = makeListener(async () => response(200, { payload: { rawContent: 'b2s=' } }));
    const payload = await listener.resolvePrintPayload('order-1', 'counter', null, order);
    assert.strictEqual(payload.rawContent, 'b2s=');
    assert.strictEqual(payload.localFallback, undefined);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  Module._load = originalLoad;
  process.exit(failed > 0 ? 1 : 0);
})();
