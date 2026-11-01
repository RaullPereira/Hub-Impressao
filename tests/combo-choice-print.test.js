const test = require('node:test');
const assert = require('node:assert/strict');
const { generateOrderPrintData } = require('../src/main/printer/pedidoshub-formatter');

const order = {
  id: 'combo-choice-regression',
  order_number: 1,
  created_at: '2026-10-16T21:16:00.000Z',
  customer_name: 'Cliente',
  subtotal: 59.99,
  total: 61.99,
  delivery_fee: 2,
  payment_method: 'Pix',
  items: [{
    name: 'COMBO 01',
    quantity: 1,
    totalPrice: 59.99,
    promotionName: 'COMBO 01',
    comboItems: [
      { name: 'Pizza', sizeLabel: 'Grande', flavors: [{ name: '2 Queijos' }, { name: 'Calabresa' }], notes: 'sem cebola' },
      { name: 'Chocolate com Morango' },
      { name: 'Guarana Antarctica 1 Litro' },
    ],
  }],
};

for (const route of ['kitchen', 'counter']) {
  test(`${route} prints every choice inside an AI combo exactly once`, () => {
    const text = generateOrderPrintData(order, route, { paperWidth: 48, highlightBeverages: false }).join('');
    for (const choice of ['2 Queijos / Calabresa', 'Chocolate com Morango', 'Guarana Antarctica 1 Litro']) {
      assert.equal(text.split(choice).length - 1, 1, `${route}: ${choice}`);
    }
    assert.match(text, /sem cebola/);
  });
}
