'use strict';

const assert = require('node:assert/strict');
const os = require('os');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { fetchRecoveryOrders } = require('../src/main/supabase/recovery-orders');
const PairedPrintListener = require('../src/main/supabase/paired-print-listener');

function makeRangeSupabaseMock(sourceOrders, options = {}) {
  const ranges = [];
  const queries = [];

  return {
    ranges,
    queries,
    from(table) {
      assert.equal(table, 'orders');
      const filters = [];
      const ordering = [];

      const query = {
        select() {
          return query;
        },
        eq(column, value) {
          filters.push({ operator: 'eq', column, value });
          return query;
        },
        gte(column, value) {
          filters.push({ operator: 'gte', column, value });
          return query;
        },
        lte(column, value) {
          filters.push({ operator: 'lte', column, value });
          return query;
        },
        order(column, options) {
          ordering.push({ column, ascending: options?.ascending !== false });
          return query;
        },
        range(from, to) {
          if (typeof options.onRange === 'function') {
            options.onRange({ from, to, rangeCall: ranges.length + 1 });
          }
          ranges.push([from, to]);
          queries.push({
            sinceIso: filters.find((filter) => filter.operator === 'gte' && filter.column === 'created_at')?.value,
            untilIso: filters.find((filter) => filter.operator === 'lte' && filter.column === 'created_at')?.value
          });
          let data = sourceOrders.filter((order) => filters.every((filter) => {
            const actual = order[filter.column];
            if (filter.operator === 'eq') return actual === filter.value;
            if (filter.operator === 'gte') return String(actual) >= String(filter.value);
            return String(actual) <= String(filter.value);
          }));

          data.sort((left, right) => {
            for (const { column, ascending } of ordering) {
              const comparison = String(left[column]).localeCompare(String(right[column]));
              if (comparison !== 0) return ascending ? comparison : -comparison;
            }
            return 0;
          });

          return Promise.resolve({
            data: data.slice(from, to + 1).map((order) => ({ ...order })),
            error: null
          });
        }
      };

      return query;
    }
  };
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
    lastSeenAt: '2026-08-20T11:59:55.000Z'
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

(async () => {
  {
    const orders = Array.from({ length: 125 }, (_, index) => ({
      id: `order-${String(index).padStart(3, '0')}`,
      admin_client_id: 'store-1',
      created_at: new Date(Date.parse('2026-08-20T11:55:00.000Z') + index * 1000).toISOString()
    }));
    const supabase = makeRangeSupabaseMock(orders);

    const result = await fetchRecoveryOrders({
      supabase,
      adminClientId: 'store-1',
      sinceIso: '2026-08-20T11:55:00.000Z',
      untilIso: '2026-08-20T12:00:00.000Z',
      pageSize: 50
    });

    assert.equal(result.orders.length, 125);
    assert.equal(result.pageCount, 3);
    assert.equal(new Set(result.orders.map(({ id }) => id)).size, 125);
    assert.deepEqual(supabase.ranges, [[0, 49], [50, 99], [100, 149]]);
  }

  {
    const realNow = Date.now;
    Date.now = () => Date.parse('2026-08-20T12:00:00.000Z');
    try {
      const supabase = makeRangeSupabaseMock([{
        id: 'missed-realtime-order',
        admin_client_id: 'store-1',
        order_number: 1001,
        status: 'preparing',
        payment_method: 'cash',
        created_at: '2026-08-20T11:56:00.000Z'
      }]);
      const listener = makeListener(supabase);
      const handled = [];
      listener.handleAutoPrintOrder = async (order, source) => {
        handled.push({ id: order.id, source });
        return { outcome: 'printed' };
      };

      await listener.recoverMissedOrders({ forceLookbackMs: 30 * 60_000 });

      assert.deepEqual(handled, [{ id: 'missed-realtime-order', source: 'recovery' }]);
      assert.equal(supabase.queries[0].sinceIso, '2026-08-20T11:55:00.000Z');
      assert.equal(supabase.queries[0].untilIso, '2026-08-20T12:00:00.000Z');
    } finally {
      Date.now = realNow;
    }
  }

  {
    const realNow = Date.now;
    let nowMs = Date.parse('2026-08-20T12:00:00.000Z');
    Date.now = () => nowMs;
    try {
      const supabase = makeRangeSupabaseMock([{
        id: 'snapshot-boundary-order',
        admin_client_id: 'store-1',
        order_number: 1002,
        status: 'preparing',
        payment_method: 'cash',
        created_at: '2026-08-20T11:55:00.001Z'
      }], {
        onRange: () => {
          nowMs += 10_000;
        }
      });
      const listener = makeListener(supabase);
      const handled = [];
      listener.handleAutoPrintOrder = async (order, source) => {
        handled.push({ id: order.id, source });
        return { outcome: 'printed' };
      };

      await listener.recoverMissedOrders({ forceLookbackMs: 30 * 60_000 });

      assert.deepEqual(handled, [{ id: 'snapshot-boundary-order', source: 'recovery' }]);
    } finally {
      Date.now = realNow;
    }
  }

  console.log('auto-print recovery pagination: 125 orders in 3 pages');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
