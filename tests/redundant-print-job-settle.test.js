const assert = require('assert');
const Module = require('module');
const os = require('os');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }

  return originalLoad.call(this, request, parent, isMain);
};

// Supabase mínimo: SELECT devolve `printedRows`; UPDATE registra o payload.
function createSupabase(printedRows) {
  const updates = [];
  return {
    updates,
    from() {
      const state = { op: 'select', payload: null, filters: {} };
      const builder = {
        select() { return builder; },
        update(payload) { state.op = 'update'; state.payload = payload; return builder; },
        eq(column, value) { state.filters[column] = value; return builder; },
        neq() { return builder; },
        limit() { return Promise.resolve({ data: printedRows, error: null }); },
        then(resolve, reject) {
          if (state.op === 'update') updates.push({ payload: state.payload, filters: state.filters });
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

function createListener(PairedPrintListener, supabase) {
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
  listener.supabase = supabase;
  return listener;
}

(async () => {
  try {
    const PairedPrintListener = require('../src/main/supabase/paired-print-listener');
    const job = { id: 'job-dup', order_id: 'order-1', printer_type: 'kitchen', status: 'pending' };

    // Via já impressa no ledger: o job duplicado sai da fila como 'failed' sem tentar o UPDATE para 'printed'.
    {
      const supabase = createSupabase([{ id: 'ledger-1', content: null }]);
      const listener = createListener(PairedPrintListener, supabase);
      let claimed = false;
      listener.claimPrintJob = async () => { claimed = true; return { id: job.id }; };

      const result = await listener.settleRedundantPrintJob(job);
      assert.strictEqual(result, null);
      assert.strictEqual(claimed, false);
      assert.deepStrictEqual(supabase.updates, [{ payload: { status: 'failed' }, filters: { id: 'job-dup', status: 'pending' } }]);
    }

    // Só existem jobs do KDS impressos (fora do ledger): o job é promovido normalmente.
    {
      const supabase = createSupabase([
        { id: 'kds-1', content: { trigger: 'kds_station' } },
        { id: 'kds-2', content: { trigger: 'kds_ready' } },
      ]);
      const listener = createListener(PairedPrintListener, supabase);
      listener.claimPrintJob = async (id) => ({ id });

      const result = await listener.settleRedundantPrintJob(job);
      assert.deepStrictEqual(result, { id: 'job-dup' });
      assert.deepStrictEqual(supabase.updates, []);
    }

    console.log('redundant print job settle tests passed');
  } finally {
    Module._load = originalLoad;
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
