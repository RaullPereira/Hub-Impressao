// Garante que a recuperacao automatica do Hub Impressao nao despeje backlog
// antigo apos reconexao/watchdog. Apenas jobs e pedidos recentes podem ser
// recuperados automaticamente.
//
// Rodar: node tests/pending-print-recovery-window.test.js

const os = require('os');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const PairedPrintListener = require('../src/main/supabase/paired-print-listener');

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

function makeListener(supabase) {
  const listener = new PairedPrintListener(null, {
    adminClientId: 'store-1',
    pairingStore: {
      getPairing: () => ({ adminClientId: 'store-1', enabled: true }),
      savePairing: () => {},
      updatePairing: () => {},
      clearPairing: () => {}
    }
  });

  listener.currentPairing = {
    adminClientId: 'store-1',
    enabled: true,
    lastSeenAt: new Date(Date.now() - 30 * 60 * 1000).toISOString()
  };
  listener.printSettings = Object.assign({}, listener.printSettings, {
    autoPrintEnabled: true,
    autoPrintOnAcceptEnabled: false,
    autoPrintType: 'counter'
  });
  listener.supabase = supabase;
  listener.touchHeartbeat = () => {};

  return listener;
}

function makeSupabaseMock({ jobs = [], orders = [] } = {}) {
  return {
    from(table) {
      const ctx = {
        table,
        op: 'select',
        patch: null,
        filters: [],
        inFilters: [],
        limit: null,
        orderBy: null
      };

      const builder = {
        select() {
          if (ctx.op !== 'update') ctx.op = 'select';
          return builder;
        },
        update(patch) {
          ctx.op = 'update';
          ctx.patch = patch;
          return builder;
        },
        eq(column, value) {
          ctx.filters.push({ type: 'eq', column, value });
          return builder;
        },
        lt(column, value) {
          ctx.filters.push({ type: 'lt', column, value });
          return builder;
        },
        gte(column, value) {
          ctx.filters.push({ type: 'gte', column, value });
          return builder;
        },
        in(column, values) {
          ctx.inFilters.push({ column, values: values.map(String) });
          return builder;
        },
        order(column, options) {
          ctx.orderBy = { column, ascending: options?.ascending !== false };
          return builder;
        },
        limit(value) {
          ctx.limit = value;
          return builder;
        },
        then(resolve, reject) {
          try {
            resolve(runQuery(ctx, { jobs, orders }));
          } catch (error) {
            if (reject) reject(error);
            else throw error;
          }
        }
      };

      return builder;
    }
  };
}

function runQuery(ctx, state) {
  const rows = ctx.table === 'print_jobs' ? state.jobs : state.orders;

  if (ctx.op === 'update') {
    const matched = rows.filter((row) => matches(row, ctx));
    for (const row of matched) {
      Object.assign(row, ctx.patch);
    }
    return { data: matched.map((row) => ({ ...row })), error: null };
  }

  let data = rows.filter((row) => matches(row, ctx)).map((row) => ({ ...row }));
  if (ctx.orderBy) {
    const { column, ascending } = ctx.orderBy;
    data.sort((a, b) => {
      const left = String(a[column] || '');
      const right = String(b[column] || '');
      return ascending ? left.localeCompare(right) : right.localeCompare(left);
    });
  }
  if (Number.isFinite(ctx.limit)) {
    data = data.slice(0, ctx.limit);
  }
  return { data, error: null };
}

function matches(row, ctx) {
  for (const filter of ctx.filters) {
    const value = row[filter.column];
    if (filter.type === 'eq' && value !== filter.value) return false;
    if (filter.type === 'lt' && !(String(value) < String(filter.value))) return false;
    if (filter.type === 'gte' && !(String(value) >= String(filter.value))) return false;
  }

  for (const filter of ctx.inFilters) {
    if (!filter.values.includes(String(row[filter.column]))) return false;
  }

  return true;
}

(async () => {
  console.log('--- pending print recovery window ---');

  {
    const oldJob = {
      id: 'old-job',
      admin_client_id: 'store-1',
      order_id: 'old-order',
      printer_type: 'counter',
      status: 'pending',
      created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    };
    const recentJob = {
      id: 'recent-job',
      admin_client_id: 'store-1',
      order_id: 'recent-order',
      printer_type: 'counter',
      status: 'pending',
      created_at: new Date(Date.now() - 60 * 1000).toISOString()
    };
    const jobs = [oldJob, recentJob];
    const listener = makeListener(makeSupabaseMock({ jobs }));
    const processed = [];
    listener.processPrintJob = async (job, source) => {
      processed.push({ id: job.id, source });
    };

    await listener.processPendingJobs();

    check('processa somente job recente', processed, [{ id: 'recent-job', source: 'pending_recovery' }]);
    check('marca job antigo como failed', oldJob.status, 'failed');
    check('mantem job recente pendente para processamento', recentJob.status, 'pending');
  }

  {
    const listener = makeListener(makeSupabaseMock({ jobs: [] }));
    const updated = [];
    listener.updatePrintJobStatus = async (id, status) => {
      updated.push({ id, status });
    };

    await listener.processPrintJob({
      id: 'old-direct-job',
      admin_client_id: 'store-1',
      order_id: 'old-order',
      status: 'pending',
      created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    }, 'pending_recovery');

    check('defesa interna barra job antigo fora do realtime', updated, [{ id: 'old-direct-job', status: 'failed' }]);
  }

  {
    const listener = makeListener(makeSupabaseMock({ jobs: [] }));
    const updated = [];
    let scheduledReconnect = false;
    listener.refreshPrintSettings = async () => {};
    listener.isOrderAlreadyPrinted = async () => false;
    listener.claimPrintJob = async () => ({ id: 'retry-job' });
    listener.printWithRouting = async () => {
      throw new Error('socket closed');
    };
    listener.updatePrintJobStatus = async (id, status) => {
      updated.push({ id, status });
    };
    listener.scheduleReconnect = () => {
      scheduledReconnect = true;
    };

    await listener.processPrintJob({
      id: 'retry-job',
      admin_client_id: 'store-1',
      order_id: 'recent-order',
      printer_type: 'counter',
      status: 'pending',
      created_at: new Date(Date.now() - 60 * 1000).toISOString()
    }, 'pending_recovery');

    check('falha recuperavel volta para pending', updated, [{ id: 'retry-job', status: 'pending' }]);
    check('falha recuperavel agenda reconexao', scheduledReconnect, true);
  }

  {
    const orders = [
      {
        id: 'old-order',
        admin_client_id: 'store-1',
        order_number: 10,
        status: 'preparing',
        payment_method: 'cash',
        created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString()
      },
      {
        id: 'recent-order',
        admin_client_id: 'store-1',
        order_number: 11,
        status: 'preparing',
        payment_method: 'cash',
        created_at: new Date(Date.now() - 60 * 1000).toISOString()
      }
    ];
    const listener = makeListener(makeSupabaseMock({ jobs: [], orders }));
    const printed = [];
    listener.handleAutoPrintOrder = async (order, source) => {
      printed.push({ id: order.id, source });
    };

    await listener.recoverMissedOrders();

    check('recupera somente pedido recente', printed, [{ id: 'recent-order', source: 'recovery' }]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
