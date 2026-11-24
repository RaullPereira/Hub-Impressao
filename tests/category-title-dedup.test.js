// Título da categoria não se repete quando o item já diz o mesmo: "PIZZA PEQUENA" (caixa)
// ou "PIZZA: PEQUENA" (cozinha) sai uma única vez, no item, no layout oficial do web.
// Rodar: node tests/category-title-dedup.test.js
const assert = require('assert');
const { generateOrderPrintData } = require('../src/main/printer/pedidoshub-formatter');

const base = { id: 'o1', order_number: '7', created_at: '2026-11-23T12:00:00Z', order_type: 'delivery', customer_name: 'Cliente', total: 80, payment_method: 'PIX' };
const pizza = { name: 'Pizza', category: 'Pizza Pequena', quantity: 1, sizeLabel: 'Pequena', flavors: [{ name: 'Calabresa' }], unitPrice: 40, totalPrice: 40 };
const count = (text, needle) => text.split(needle).length - 1;
const pizzaLines = (text) => count(text, 'PIZZA PEQUENA') + count(text, 'PIZZA: PEQUENA');

const printed = generateOrderPrintData({ ...base, items: [pizza] }, 'counter').join('').toUpperCase();
assert.strictEqual(pizzaLines(printed), 1, 'item sumiu ou título duplicado');

const mixed = generateOrderPrintData({ ...base, items: [{ name: 'Coca', category: 'Bebidas', quantity: 1, sizeLabel: '2L', unitPrice: 10, totalPrice: 10 }] }, 'counter').join('').toUpperCase();
assert.ok(mixed.includes('BEBIDAS'), 'título de categoria normal sumiu');
for (const order_type of ['dine_in', 'pickup']) {
  for (const type of ['counter', 'kitchen', 'both']) {
    const out = generateOrderPrintData({ ...base, order_type, table_number: '4', items: [pizza] }, type).join('').toUpperCase();
    assert.strictEqual(pizzaLines(out), type === 'both' ? 2 : 1, `${order_type}/${type} duplicado`);
  }
}
console.log('category-title-dedup: OK');
