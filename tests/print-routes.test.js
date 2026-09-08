// Route normalization tests for Hub Impressao automatic printing.
//
// Run: node tests/print-routes.test.js

const routes = require('../src/main/print-routes');

let pass = 0;
let fail = 0;

function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name} -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

console.log('--- print route normalization ---');

check('kitchen stays kitchen', routes.normalizeAutoPrintRoute('kitchen'), 'kitchen');
check('counter normalizes to attendance', routes.normalizeAutoPrintRoute('counter'), 'attendance');
check('balcao normalizes to attendance', routes.normalizeAutoPrintRoute('balcao'), 'attendance');
check('salao normalizes to attendance', routes.normalizeAutoPrintRoute('salao'), 'attendance');
check('delivery normalizes to attendance', routes.normalizeAutoPrintRoute('delivery'), 'attendance');
check('bar stays bar', routes.normalizeAutoPrintRoute('bar'), 'bar');
check('bebidas normalizes to bar', routes.normalizeAutoPrintRoute('bebidas'), 'bar');
check('default is not an automatic route', routes.normalizeAutoPrintRoute('default'), null);
check('unknown type defaults to attendance for receipt layouts', routes.normalizeAutoPrintRoute('whatever'), 'attendance');
check('legacy render type for attendance is counter', routes.getPrintTypeForRoute('attendance'), 'counter');
check('render type for bar is bar', routes.getPrintTypeForRoute('bar'), 'bar');

check('attendance map prefers explicit attendance', routes.normalizeAutoPrintMap({
  kitchen: ' Kitchen ',
  counter: 'Counter',
  delivery: 'Delivery',
  attendance: ' Attendance '
}), {
  kitchen: 'Kitchen',
  attendance: 'Attendance',
  counter: 'Attendance',
  delivery: 'Attendance',
  bar: null
});

check('bar map is preserved', routes.normalizeAutoPrintMap({
  bar: ' Bar '
}), {
  kitchen: null,
  attendance: null,
  counter: null,
  delivery: null,
  bar: 'Bar'
});

check('legacy counter/delivery collapse into attendance preferring counter', routes.normalizeAutoPrintMap({
  kitchen: 'Kitchen',
  counter: 'Counter',
  delivery: 'Delivery'
}), {
  kitchen: 'Kitchen',
  attendance: 'Counter',
  counter: 'Counter',
  delivery: 'Counter',
  bar: null
});

check('all-empty map returns null legacy mode', routes.normalizeAutoPrintMap({
  kitchen: '',
  counter: '',
  delivery: ''
}), null);

check('delivery order uses attendance route once', routes.buildAutoPrintRoutesForOrder({
  kitchen: 'Kitchen',
  attendance: 'Attendance',
  counter: 'Attendance',
  delivery: 'Attendance'
}, {
  id: 'order-1',
  order_type: 'delivery'
}), [
  { route: 'kitchen', printType: 'kitchen', printer: 'Kitchen' },
  { route: 'attendance', printType: 'counter', printer: 'Attendance' }
]);

check('bar route is gated by barPrintEnabled', routes.buildAutoPrintRoutesForOrder({
  kitchen: 'Kitchen',
  attendance: 'Attendance',
  counter: 'Attendance',
  delivery: 'Attendance',
  bar: 'Bar'
}, {
  id: 'order-1',
  order_type: 'delivery'
}, {
  barPrintEnabled: true
}), [
  { route: 'kitchen', printType: 'kitchen', printer: 'Kitchen' },
  { route: 'attendance', printType: 'counter', printer: 'Attendance' },
  { route: 'bar', printType: 'bar', printer: 'Bar' }
]);

check('explicit autoPrintRoutes can select only bar', routes.buildAutoPrintRoutesForOrder({
  kitchen: 'Kitchen',
  attendance: 'Attendance',
  counter: 'Attendance',
  delivery: 'Attendance',
  bar: 'Bar'
}, {
  id: 'order-1',
  order_type: 'delivery'
}, {
  barPrintEnabled: true,
  autoPrintRoutes: ['bar']
}), [
  { route: 'bar', printType: 'bar', printer: 'Bar' }
]);

check('legacy route selection supports bar-only', routes.buildLegacyAutoPrintRoutes({
  autoPrintType: 'both',
  autoPrintRoutes: ['bar'],
  barPrintEnabled: true
}), [
  { route: 'bar', printType: 'bar', ledgerType: 'bar' }
]);

check('attendance-only order skips kitchen when missing', routes.buildAutoPrintRoutesForOrder({
  kitchen: null,
  attendance: 'Attendance',
  counter: 'Attendance',
  delivery: 'Attendance'
}, {
  id: 'order-2',
  order_type: 'balcao'
}), [
  { route: 'attendance', printType: 'counter', printer: 'Attendance' }
]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
