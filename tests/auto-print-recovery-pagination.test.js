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
  const limits = [];
  const queries = [];

  return {
    ranges,
    limits,
    queries,
    from(table) {
      assert.equal(table, 'orders');
      const filters = [];
      const ordering = [];
      let keysetFilter = null;

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
        or(value) {
          keysetFilter = value;
          return query;
        },
        order(column, options) {
          ordering.push({ column, ascending: options?.ascending !== false });
          return query;
        },
        range(from, to) {
          ranges.push([from, to]);
          return resolvePage(from, to - from + 1);
        },
        limit(size) {
          limits.push(size);
          return resolvePage(0, size);
        }
      };

      function resolvePage(offset, size) {
        queries.push({
          sinceIso: filters.find((filter) => filter.operator === 'gte' && filter.column === 'created_at')?.value,
          untilIso: filters.find((filter) => filter.operator === 'lte' && filter.column === 'created_at')?.value,
          keysetFilter
        });
        let data = sourceOrders.filter((order) => filters.every((filter) => {
          const actual = order[filter.column];
          if (filter.operator === 'eq') return actual === filter.value;
          if (filter.operator === 'gte') return String(actual) >= String(filter.value);
          return String(actual) <= String(filter.value);
        }));

        if (keysetFilter) {
          const match = keysetFilter.match(/^created_at\.gt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.gt\.([^\)]+)\)$/);
          assert.ok(match, `unexpected keyset filter: ${keysetFilter}`);
          const [, greaterCreatedAt, equalCreatedAt, greaterId] = match;
          data = data.filter((order) => (
            String(order.created_at) > greaterCreatedAt ||
            (String(order.created_at) === equalCreatedAt && String(order.id) > greaterId)
          ));
        }

        data.sort((left, right) => {
          for (const { column, ascending } of ordering) {
            const comparison = String(left[column]).localeCompare(String(right[column]));
            if (comparison !== 0) return ascending ? comparison : -comparison;
          }
          return 0;
        });

        const page = data.slice(offset, offset + size).map((order) => ({ ...order }));
        if (typeof options.onPageResolved === 'function') {
          options.onPageResolved({ page, pageCall: queries.length });
        }
        return Promise.resolve({ data: page, error: null });
      }

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
    assert.deepEqual(supabase.ranges, []);
    assert.deepEqual(supabase.limits, [50, 50, 50]);
  }

  {
    const orders = Array.from({ length: 100 }, (_, index) => ({
      id: `same-time-${String(index).padStart(3, '0')}`,
      admin_client_id: 'store-1',
      created_at: '2026-08-20T11:55:00.000Z'
    }));
    const supabase = makeRangeSupabaseMock(orders);

    const result = await fetchRecoveryOrders({
      supabase,
      adminClientId: 'store-1',
      sinceIso: '2026-08-20T11:55:00.000Z',
      untilIso: '2026-08-20T12:00:00.000Z',
      pageSize: 50
    });

    assert.equal(result.orders.length, 100);
    assert.equal(result.pageCount, 3);
    assert.equal(new Set(result.orders.map(({ id }) => id)).size, 100);
    assert.deepEqual(supabase.limits, [50, 50, 50]);
  }

  {
    const orders = Array.from({ length: 101 }, (_, index) => ({
      id: `churn-${String(index).padStart(3, '0')}`,
      admin_client_id: 'store-1',
      created_at: new Date(Date.parse('2026-08-20T11:55:00.000Z') + index * 1000).toISOString()
    }));
    const supabase = makeRangeSupabaseMock(orders, {
      onPageResolved: ({ pageCall }) => {
        if (pageCall === 1) orders.shift();
      }
    });

    const result = await fetchRecoveryOrders({
      supabase,
      adminClientId: 'store-1',
      sinceIso: '2026-08-20T11:55:00.000Z',
      untilIso: '2026-08-20T12:00:00.000Z',
      pageSize: 50
    });

    assert.equal(result.orders.length, 101);
    assert.equal(new Set(result.orders.map(({ id }) => id)).size, 101);
    assert.ok(result.orders.some(({ id }) => id === 'churn-050'));
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
        onPageResolved: () => {
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
