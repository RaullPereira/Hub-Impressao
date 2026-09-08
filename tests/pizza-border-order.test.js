// Garante a ordem padrao para pizzas internas: tamanho, borda, sabores.
//
// Rodar: node tests/pizza-border-order.test.js

const { generateOrderPrintData } = require('../src/main/printer/pedidoshub-formatter');

let pass = 0;
let fail = 0;

function check(name, condition, details = '') {
  if (condition) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${details ? ` -> ${details}` : ''}`);
  }
}

const order = {
  id: 'order-single-pizza-border',
  order_number: '125',
  created_at: '2026-06-19T12:00:00Z',
  order_type: 'delivery',
  customer_name: 'Cliente',
  total: 59.9,
  payment_method: 'PIX',
  items: [
    {
      productId: 'custom-pizza-single',
      name: 'Pizza',
      product_name: 'Pizza',
      category: 'Pizzas',
      quantity: 1,
      sizeLabel: 'Grande',
      flavors: [{ id: 'calabresa', name: 'Calabresa' }],
      borderName: 'Chocolate',
      borderPrice: 8,
      unitPrice: 59.9,
      totalPrice: 59.9
    }
  ]
};

function assertOrder(printType) {
  const printed = generateOrderPrintData(order, printType).join('').toUpperCase();
  const borderLabelIndex = printed.indexOf('BORDA:');
  const borderValueIndex = printed.indexOf('CHOCOLATE');
  const flavorIndex = printed.indexOf('CALABRESA');

  check(`${printType} contem PIZZA: GRANDE`, printed.includes('PIZZA: GRANDE'));
  check(`${printType} contem borda`, borderLabelIndex >= 0 && borderValueIndex >= 0);
  check(`${printType} contem sabor`, flavorIndex >= 0);
  check(
    `${printType} imprime borda antes do sabor`,
    borderLabelIndex >= 0 &&
      borderValueIndex >= 0 &&
      flavorIndex >= 0 &&
      borderLabelIndex < borderValueIndex &&
      borderValueIndex < flavorIndex,
    `borderLabel=${borderLabelIndex}, borderValue=${borderValueIndex}, flavor=${flavorIndex}`
  );
}

console.log('--- pizza border order ---');
assertOrder('counter');
assertOrder('kitchen');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
