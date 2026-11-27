// Comanda do app (hub_gestao_print_requests) que falha no meio: a via que já
// saiu não sai de novo, e o Hub não apaga o resultado gravado pelo banco ou
// por outro computador.
//
// Rodar: node tests/gestao-print-request-failure.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gestao-fail-'));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  return originalLoad.call(this, request, parent, isMain);
};
const PairedPrintListener = require('../src/main/supabase/paired-print-listener');
const { gestaoFailureOutcome } = PairedPrintListener;

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

// Supabase falso: grava cada update com os filtros usados.
function fakeSupabase(row) {
  const updates = [];
  return {
    updates,
    from() {
      const state = { payload: null, filters: [] };
      const builder = {
        update(payload) { state.payload = payload; return builder; },
        eq(column, value) { state.filters.push(['eq', column, value]); return builder; },
        in(column, values) { state.filters.push(['in', column, values]); return builder; },
        select() { return builder; },
        async maybeSingle() {
          updates.push({ ...state });
          if (state.payload.status === 'printing' && row.status === 'pending') {
            row.status = 'printing';
            return { data: { id: row.id }, error: null };
          }
          return { data: null, error: null };
        },
        then(resolve) {
          updates.push({ ...state });
          const allowed = state.filters.find(([kind, column]) => kind === 'in' && column === 'status');
          if (!allowed || allowed[2].includes(row.status)) Object.assign(row, state.payload);
          resolve({ error: null });
        }
      };
      return builder;
    }
  };
}

function makeListener({ row, failOn }) {
  const listener = new PairedPrintListener(null, { adminClientId: 'store-1' });
  listener.supabase = fakeSupabase(row);
  listener.currentPairing = { adminClientId: 'store-1' };
  listener.isAutoPrintStation = () => true;
  listener.refreshPrintersIfNeeded = async () => {};
  listener.resolveGestaoRoutePrinter = async (route) => `printer-${route}`;
  listener.requestOfficialRender = async () => ({
    gestaoPrintJobs: [{ route: 'kitchen' }, { route: 'bar' }]
  });
  listener.normalizeRenderedPayload = (job) => ({ data: job.route });
  listener.runPrintActionWithRetry = (action) => action();
  const printed = [];
  listener.printRawPayload = async (_printer, payload) => {
    if (payload.data === failOn) throw Object.assign(new Error('timeout na impressora'), { code: 'ETIMEDOUT' });
    printed.push(payload.data);
  };
  listener.isRetriablePrintError = () => true;
  return { listener, printed };
}

(async () => {
  await test('cozinha saiu e o bar falhou: não volta para a fila', async () => {
    const row = { id: 'r1', status: 'pending' };
    const { listener, printed } = makeListener({ row, failOn: 'bar' });
    await listener.processGestaoPrintRequest({ id: 'r1', status: 'pending' });
    assert.deepStrictEqual(printed, ['kitchen']);
    assert.strictEqual(row.status, 'failed');
    assert.match(row.error, /^Saiu só: cozinha\. O resto falhou: timeout/);
  });

  await test('nada saiu e o erro é recuperável: volta para a fila', async () => {
    const row = { id: 'r2', status: 'pending' };
    const { listener, printed } = makeListener({ row, failOn: 'kitchen' });
    await listener.processGestaoPrintRequest({ id: 'r2', status: 'pending' });
    assert.deepStrictEqual(printed, []);
    assert.strictEqual(row.status, 'pending');
  });

  await test('falha não apaga o failed que o banco gravou (expirou)', async () => {
    const row = { id: 'r3', status: 'failed', error: 'Expirou' };
    const listener = new PairedPrintListener(null, { adminClientId: 'store-1' });
    listener.supabase = fakeSupabase(row);
    await listener.setGestaoPrintStatus('r3', 'pending');
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.error, 'Expirou');
  });

  await test('printed vale mesmo se o banco já devolveu para a fila', async () => {
    const row = { id: 'r4', status: 'pending' };
    const listener = new PairedPrintListener(null, { adminClientId: 'store-1' });
    listener.supabase = fakeSupabase(row);
    await listener.setGestaoPrintStatus('r4', 'printed');
    assert.strictEqual(row.status, 'printed');
  });

  await test('regra pura: definitivo, última tentativa e via que saiu', async () => {
    assert.deepStrictEqual(
      gestaoFailureOutcome({ error: new Error('x'), retriable: true }),
      { status: 'pending', error: null }
    );
    assert.strictEqual(
      gestaoFailureOutcome({ error: Object.assign(new Error('sem impressora'), { definitive: true }), retriable: true }).status,
      'failed'
    );
    assert.strictEqual(gestaoFailureOutcome({ error: new Error('x'), retriable: true, lastTry: true }).status, 'failed');
    assert.strictEqual(
      gestaoFailureOutcome({ error: new Error('x'), retriable: true, printedRoutes: ['kitchen', 'counter'] }).error,
      'Saiu só: cozinha, caixa. O resto falhou: x'
    );
  });

  console.log(`\n${passed} ok, ${failed} falha(s)`);
  if (failed > 0) process.exit(1);
})();
