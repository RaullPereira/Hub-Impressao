// Draft orders must wait for completion before entering Hub Impressao auto-print.
// Run with: node tests/incomplete-order-draft-auto-print.test.js

const os = require('os');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir() } };
  return originalLoad.call(this, request, parent, isMain);
};

const PairedPrintListener = require('../src/main/supabase/paired-print-listener');
const { didCompleteIncompleteOrderDraft } = PairedPrintListener;

let pass = 0;
let fail = 0;
function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

function makeListener() {
  const listener = new PairedPrintListener(null, {
    adminClientId: 'store-1',
    pairingStore: {
      getPairing: () => ({ adminClientId: 'store-1', enabled: true }),
      savePairing: () => {},
      updatePairing: () => {},
      clearPairing: () => {},
    },
  });
  listener.currentPairing = { adminClientId: 'store-1' };
  listener.printSettings = {
    ...listener.printSettings,
    autoPrintEnabled: true,
    autoPrintOnAcceptEnabled: true,
    autoPrintType: 'counter',
  };
  listener.touchHeartbeat = () => {};
  return listener;
}

function makeOrderRecoverySupabase({ created = [], updated = [] } = {}) {
  return {
    from(table) {
      const state = { table, timestampColumn: null };
      const query = {
        select() { return query; },
        eq() { return query; },
        gte(column) { state.timestampColumn = column; return query; },
        order() { return query; },
        limit() { return query; },
        then(resolve, reject) {
          try {
            const data = state.timestampColumn === 'updated_at' ? updated : created;
            resolve({ data, error: null });
          } catch (error) {
            if (reject) reject(error);
            else throw error;
          }
        },
      };
      return query;
    },
  };
}

(async () => {
  const listener = makeListener();
  let claimCalls = 0;
  let printCalls = 0;
  listener.hasPendingOrPrintedPrintJob = async () => false;
  listener.claimAutoPrintLedger = async () => { claimCalls += 1; return { id: 'claim-1' }; };
  listener.printWithRouting = async () => { printCalls += 1; };

  const activeDraft = {
    id: 'draft-1',
    order_number: 1,
    status: 'awaiting',
    custom_data: '{"incomplete_draft":true,"manual_print_only":true}',
  };
  await listener.handleAutoPrintOrder(activeDraft, 'realtime_insert');
  check('rascunho nao reivindica ledger', claimCalls, 0);
  check('rascunho nao imprime', printCalls, 0);
  check('rascunho nao entra no cache de processados', listener.processedOrderIds.has('draft-1'), false);

  check('transicao ativa para concluida e detectada', didCompleteIncompleteOrderDraft(
    { custom_data: { incomplete_draft: true } },
    { custom_data: { incomplete_draft_completed_at: new Date().toISOString() } },
  ), true);
  check('sem data de conclusao nao e transicao de rascunho', didCompleteIncompleteOrderDraft(
    { custom_data: { incomplete_draft: true } },
    { custom_data: {} },
  ), false);

  const recentlyCompleted = {
    id: 'completed-draft',
    order_number: 2,
    status: 'awaiting',
    payment_method: 'cash',
    created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    updated_at: new Date().toISOString(),
    custom_data: { incomplete_draft_completed_at: new Date().toISOString() },
  };
  const stillIncomplete = {
    id: 'still-draft',
    status: 'awaiting',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    custom_data: { incomplete_draft: true, manual_print_only: true },
  };
  listener.currentPairing.lastSeenAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  listener.supabase = makeOrderRecoverySupabase({ created: [], updated: [recentlyCompleted, stillIncomplete] });
  listener.printSettings.autoPrintOnAcceptEnabled = false;
  const recovered = [];
  listener.handleAutoPrintOrder = async (order, source) => { recovered.push({ id: order.id, source }); };
  await listener.recoverMissedOrders();
  check('recupera conclusao recente mesmo com created_at antigo', recovered, [
    { id: 'completed-draft', source: 'recovery' },
  ]);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
