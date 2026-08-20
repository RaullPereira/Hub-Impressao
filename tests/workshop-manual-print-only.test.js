const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'supabase', 'paired-print-listener.js'),
  'utf8'
);

test('workshop orders are excluded from every automatic print entry point', () => {
  assert.match(source, /function isManualPrintOnlyOrder\(order\)/);
  assert.match(source, /customData\.manual_print_only === true/);
  assert.match(source, /customData\.workshop_vehicle/);
  assert.match(source, /async handleAutoPrintOrder\(order, source\)[\s\S]*?if \(isManualPrintOnlyOrder\(order\)\)/);
  assert.match(source, /const eligibleOrders = \(recentOrders \|\| \[\]\)\.filter\(\(order\) => \{[\s\S]*?if \(isManualPrintOnlyOrder\(order\)\) return false/);
});

test('manual print jobs remain available', () => {
  assert.match(source, /async processPrintJob\(job, source\)/);
  const processPrintJob = source.slice(source.indexOf('async processPrintJob(job, source)'));
  assert.doesNotMatch(processPrintJob.slice(0, 1200), /isManualPrintOnlyOrder/);
});
