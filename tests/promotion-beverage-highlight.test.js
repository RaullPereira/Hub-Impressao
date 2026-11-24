// Valida que bebidas dentro de promocao continuam indo para o destaque do motoboy
// (layout oficial do web: a bebida sai so no bloco ATENCAO MOTOBOY, depois da promocao).
//
// Rodar: node tests/promotion-beverage-highlight.test.js

const { generateOrderPrintData } = require('../src/main/printer/pedidoshub-formatter');

let pass = 0;
let fail = 0;

function checkContains(name, text, needle) {
  if (text.includes(needle)) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} -> missing ${JSON.stringify(needle)}`);
  }
}

const order = {
  id: 'order-combo-bebida',
  order_number: '123',
  created_at: '2026-06-11T12:00:00Z',
  order_type: 'delivery',
  customer_name: 'Cliente',
  total: 34.99,
  payment_method: 'Dinheiro',
  items: [
    {
      productId: '__combo_choice__',
      product_name: '2x Queijo, 2x Mista, 2x Calabresa, 2x Carne',
      name: '2x Queijo, 2x Mista, 2x Calabresa, 2x Carne',
      category: 'ESFIHAS',
      quantity: 1,
      unitPrice: 34.99,
      totalPrice: 34.99,
      isMarmita: true,
      promotionName: 'COMBO 8 ESFIHAS + REFRI 1 LT',
      promotionType: 'combo',
      marmitaSelections: [
        { stepName: 'Escolha os sabores', option: { name: 'Queijo' } },
        { stepName: 'Escolha os sabores', option: { name: 'Queijo' } },
      ],
    },
    {
      productId: 'pepsi-1l',
      product_name: 'Pepsi 1 Litro',
      name: 'Pepsi 1 Litro',
      category: 'BEBIDAS',
      quantity: 1,
      unitPrice: 0,
      totalPrice: 0,
      promotionName: 'COMBO 8 ESFIHAS + REFRI 1 LT',
      promotionType: 'combo',
    },
  ],
};

const text = generateOrderPrintData(order, 'counter', { highlightBeverages: true }).join('').toUpperCase();

checkContains('promocao impressa', text, 'PROMO: COMBO 8 ESFIHAS + REFRI 1 LT');
checkContains('secao motoboy impressa', text, 'ATENCAO MOTOBOY');
checkContains('bebida no destaque', text.slice(text.indexOf('ATENCAO MOTOBOY')), 'PEPSI 1 LITRO');
checkContains('bebida sai uma unica vez', String(text.split('PEPSI 1 LITRO').length - 1), '1');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
