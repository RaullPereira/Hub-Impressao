// Regression check for the Hub Impressao fallback counter formatter on 58mm.
//
// Run: node tests/counter-58mm-compact-layout.test.js

const { generateOrderPrintData } = require('../src/main/printer/pedidoshub-formatter');

let pass = 0;
let fail = 0;

function check(name, condition, details = '') {
  if (condition) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${details ? ` -> ${details}` : ''}`);
  }
}

function stripEscPosCommands(value) {
  return value
    .replace(/\x1B[@2]/g, '')
    .replace(/\x1B\x33[\s\S]/g, '')
    .replace(/\x1BM[\s\S]/g, '')
    .replace(/\x1Ba[\s\S]/g, '')
    .replace(/\x1BE[\s\S]/g, '')
    .replace(/\x1D\x21[\s\S]/g, '')
    .replace(/\x1D\x42[\s\S]/g, '')
    .replace(/\x1DV\x41\x00/g, '');
}

function countSeparatorLines(text, width) {
  const separator = '-'.repeat(width);
  return text.split('\n').filter((line) => line === separator).length;
}

const order = {
  id: 'order-58mm-hub-fallback',
  order_number: 2,
  created_at: '2026-06-21T16:38:00.000Z',
  order_type: 'delivery',
  customer_name: 'Raul Teste',
  customer_phone: '85999999999',
  street: 'AAAA',
  number: '72',
  neighborhood: 'Monte',
  complement: 'A',
  subtotal: 43,
  delivery_fee: 3,
  total: 46,
  payment_method: 'Cartao de debito',
  custom_data: {
    estimated_time_text: '20 a 30 minute'
  },
  items: [
    {
      product_name: 'Coca-Cola 1,5 litro e meio',
      name: 'Coca-Cola 1,5 litro e meio',
      category: 'Bebidas',
      quantity: 1,
      unitPrice: 13,
      totalPrice: 13
    },
    {
      product_name: 'Pizza',
      name: 'Pizza',
      category: 'Pizza Pequena',
      quantity: 1,
      size: 'Pequena',
      flavors: [{ name: 'Chocolate com granulado' }],
      unitPrice: 30,
      totalPrice: 30
    }
  ]
};

console.log('--- counter 58mm compact layout ---');

const text = generateOrderPrintData(order, 'counter', {
  paperWidth: 32,
  lineSpacing: 'wide',
  showStoreName: true,
  storeName: 'Casa da Pizza',
  highlightBeverages: false,
  feedLines: 3
}).join('');

const visibleLines = stripEscPosCommands(text).split('\n').filter((line) => line.trim()).length;
const interiorBlankLines = stripEscPosCommands(text)
  .replace(/\n+$/g, '')
  .split('\n')
  .filter((line) => !line.trim()).length;
const separatorCount = countSeparatorLines(text, 32);

check('uses balanced 58mm line spacing command', text.includes('\x1B\x33\x0E'));
check('does not use overly tight line spacing', !text.includes('\x1B\x33\x0C'));
check('does not use previous loose line spacing', !text.includes('\x1B\x33\x10'));
check('does not use older loose compact line spacing', !text.includes('\x1B\x33\x18'));
check('centers compact total with value', text.includes('\x1Ba\x01\x1D\x21\x10\x1BE\x01TOTAL: R$ 46,00\n'));
check('centers compact payment method with height emphasis', text.includes('\x1Ba\x01\x1D\x21\x10\x1BE\x01CARTAO DE DEBITO\n'));
check('does not print a decorative ITENS heading', !/^ITENS$/m.test(stripEscPosCommands(text)));
check('limits separators for 58mm', separatorCount <= 4, `separatorCount=${separatorCount}`);
check('does not leave blank lines between body sections', interiorBlankLines === 0, `blankLines=${interiorBlankLines}`);
check('keeps visible lines short', visibleLines <= 27, `visibleLines=${visibleLines}`);
check('does not print default branding footer on compact 58mm', !text.includes('Pedidos Hub | @pedidoshub'));
check('does not feed three lines before cut on compact 58mm', !text.includes('\n\n\n\x1DV\x41\x00'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
