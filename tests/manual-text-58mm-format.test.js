// Regression check for manual text printing on 58mm thermal printers.
//
// Run: node tests/manual-text-58mm-format.test.js

const { formatManualTextPrint } = require('../src/main/printer/manual-text-formatter');

let pass = 0;
let fail = 0;

function check(name, got, want) {
  if (got === want) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name} -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

function stripKnownEscposCommands(value) {
  return value
    .replace(/\x1B@/g, '')
    .replace(/\x1B\x33[\s\S]/g, '')
    .replace(/\x1BM[\s\S]/g, '')
    .replace(/\x1D\x21[\s\S]/g, '')
    .replace(/\x1Ba[\s\S]/g, '')
    .replace(/\x1DV\x41\x00/g, '')
    .replace(/\x1DV\x00/g, '');
}

console.log('--- manual text 58mm format ---');

const input = [
  'COMANDA MANUAL 58MM',
  'Item com descricao grande demais para caber em uma unica linha na bobina estreita',
  'Observacao: pouco sal, sem cebola e retirar o molho separado'
].join('\n');

const buffer = formatManualTextPrint(input, { paperWidth: 32, feedLines: 2 });
const output = buffer.toString('latin1');

check('returns buffer', Buffer.isBuffer(buffer), true);
check('resets printer before manual text', output.startsWith('\x1B@'), true);
check('uses balanced 58mm line spacing', output.includes('\x1B\x33\x0E'), true);
check('does not use overly tight line spacing', output.includes('\x1B\x33\x0C'), false);
check('does not use previous loose line spacing', output.includes('\x1B\x33\x10'), false);
check('does not use older loose compact line spacing', output.includes('\x1B\x33\x18'), false);
check('does not add six trailing feeds', output.includes('\n\n\n\n\n\n'), false);
check('cuts after short feed', output.endsWith('\n\n\x1DV\x41\x00'), true);

const printableLines = stripKnownEscposCommands(output)
  .replace(/\n+$/g, '')
  .split('\n')
  .filter(Boolean);
const widestLine = printableLines.reduce((max, line) => Math.max(max, line.length), 0);

check('wraps text to 32 columns', widestLine <= 32, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
