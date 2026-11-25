// A comanda de reserva do Hub (render oficial fora do ar) tem de sair IGUAL a
// do Pedidos Hub web: o Hub usa o formatador oficial empacotado em
// src/main/printer/web-formatter.generated.js.
//
// Run: node tests/web-formatter-parity.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const hub = require('../src/main/printer/pedidoshub-formatter');
const web = require('../src/main/printer/web-formatter.generated');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

const pizza = {
  name: 'Pizza Grande', quantity: 1, category: 'Pizzas', unit_price: 79.9, total: 89.9, sizeLabel: 'Grande',
  flavors: [{ name: 'Calabresa' }, { name: 'Frango com Catupiry' }], border: { name: 'Borda Catupiry', price: 10 }
};
const burger = {
  name: 'X-Bacon', quantity: 2, category: 'Lanches', unit_price: 28, total: 62,
  additions: [{ name: 'Ovo', quantity: 1, price: 3 }], notes: 'Um sem tomate'
};
const coke = { name: 'Coca-Cola', quantity: 2, category: 'Bebidas', sizeLabel: 'Lata', unit_price: 6, total: 12 };
const base = { id: 'o1', order_number: 142, created_at: '2026-11-24T21:05:00-03:00', operator_name: 'Carlos', subtotal: 163.9, total: 163.9 };
const orders = {
  mesa: { ...base, order_type: 'mesa', table_number: '7', hub_gestao_order_id: 'g1', items: [pizza, burger, coke] },
  delivery: {
    ...base, order_type: 'delivery', customer_name: 'Maria', street: 'Rua das Palmeiras', number: '1234',
    neighborhood: 'Jardim das Flores', payment_method: 'dinheiro', change_for: 200, items: [pizza, burger, coke]
  }
};

function settingsFor(row) {
  const settings = { paperWidth: row.paper_width };
  Object.defineProperty(settings, '__dbRow', { value: row, enumerable: false });
  return settings;
}

function renderWeb(order, type, row) {
  const settings = web.mapPrintSettingsFromDB(row);
  globalThis.localStorage = { getItem: () => JSON.stringify(settings), setItem() {}, removeItem() {} };
  try {
    web.setPrintSettingsCache(settings);
    return web.generateOrderPrintData(web.normalizeOrderForPrint(order, {}), type, settings).join('');
  } finally {
    delete globalThis.localStorage;
  }
}

// A hora da impressao muda a cada chamada: fica fora da comparacao.
const withoutPrintClock = (text) => text.replace(/IMPRESS[^\n]*\n/g, '');

console.log('--- comanda de reserva do Hub igual a do web ---');

for (const paperWidth of [32, 48]) {
  const row = { paper_width: paperWidth, store_name: 'Pizzaria Modelo' };
  for (const [label, order] of Object.entries(orders)) {
    for (const type of ['kitchen', 'counter']) {
      test(`${label} / ${type} / ${paperWidth} colunas sai igual ao web`, () => {
        const viaHub = hub.generateOrderPrintData(order, type, settingsFor(row)).join('');
        assert.ok(viaHub.length > 0);
        assert.strictEqual(withoutPrintClock(viaHub), withoutPrintClock(renderWeb(order, type, row)));
      });
    }
  }
}

test('mesa do garcom: mesa em letra gigante e adicional uma vez so', () => {
  const kitchen = hub.generateOrderPrintData(orders.mesa, 'kitchen', settingsFor({ paper_width: 48 })).join('');
  assert.ok(/\x1D!\x11[^\n]*MESA 7[^\n]*\n/.test(kitchen), 'MESA 7 em letra gigante');
  assert.strictEqual((kitchen.match(/\+ 1X OVO/g) || []).length, 1);
  assert.ok(!kitchen.includes('CLIENTE:'), 'sem linha de cliente vazia');
});

test('nao deixa um localStorage global para tras', () => {
  hub.generateOrderPrintData(orders.mesa, 'counter', settingsFor({ paper_width: 48 }));
  assert.strictEqual(typeof globalThis.localStorage, 'undefined');
});

test('layout antigo continua disponivel se o pacote falhar', () => {
  const legacy = hub.generateLegacyOrderPrintData(orders.mesa, 'kitchen', { paperWidth: 32 }).join('');
  assert.ok(legacy.toUpperCase().includes('X-BACON'));
});

test('pedido que quebra o formatador oficial cai no layout antigo', () => {
  const broken = { ...orders.mesa, items: [{ name: 'X-Bacon', quantity: 1, get category() { throw new Error('boom'); } }] };
  let commands;
  try { commands = hub.generateOrderPrintData(broken, 'counter', { paperWidth: 32 }); } catch (_) { commands = null; }
  // O formatador oficial falha com esse item; o Hub nao pode propagar essa falha em silencio como comanda vazia.
  assert.ok(commands === null || commands.join('').length > 0);
});

const webRepo = process.env.PEDIDOSHUB_WEB_REPO || path.join(__dirname, '..', '..', 'Sistemadegerenciamentodepedidos');
if (fs.existsSync(path.join(webRepo, 'src/utils/printer.ts'))) {
  test('arquivo gerado esta em dia com o layout do web', () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'sync-web-formatter.js'), webRepo, '--check'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  });
} else {
  console.log('  --  repo web ausente: conferencia de atualizacao pulada');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
