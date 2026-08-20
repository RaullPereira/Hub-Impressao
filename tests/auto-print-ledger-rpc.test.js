// Verifies automatic-print ledger claims prefer the atomic database RPC.
//
// Run: node tests/auto-print-ledger-rpc.test.js

const assert = require('assert');
const os = require('os');
const Module = require('module');

const originalLoad = Module._load;
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

function makeListener(PairedPrintListener, supabase) {
  const listener = new PairedPrintListener(null, {
    adminClientId: 'store-1',
    pairingStore: {
      getPairing: () => ({ adminClientId: 'store-1', enabled: true }),
      savePairing: () => {},
      updatePairing: () => {},
      clearPairing: () => {}
    }
  });
  listener.currentPairing = { adminClientId: 'store-1' };
  listener.supabase = supabase;
  return listener;
}

function makeRpcMissingSupabase({ insertErrorCode = null } = {}) {
  return {
    rpc: async () => ({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find claim_auto_print_job in the schema cache' }
    }),
    from(table) {
      assert.equal(table, 'print_jobs');
      const builder = {
        insert(payload) {
          assert.deepEqual(payload, {
            admin_client_id: 'store-1',
            order_id: 'order-1',
            printer_type: 'attendance',
            status: 'printed',
            printed_at: payload.printed_at
          });
          return builder;
        },
        select() {
          return builder;
        },
        single() {
          return Promise.resolve({
            data: insertErrorCode ? null : { id: 'legacy-job' },
            error: insertErrorCode ? { code: insertErrorCode } : null
          });
        }
      };
      return builder;
    }
  };
}

(async () => {
  console.log('--- auto print ledger rpc ---');

  try {
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') {
        return { app: { getPath: () => os.tmpdir() } };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const PairedPrintListener = require('../src/main/supabase/paired-print-listener');

    await test('returns the row when the RPC wins the claim', async () => {
      const listener = makeListener(PairedPrintListener, {
        rpc: async () => ({ data: [{ id: 'job-1' }], error: null })
      });

      assert.deepEqual(
        await listener.claimAutoPrintLedger('order-1', 'attendance'),
        { id: 'job-1' }
      );
    });

    await test('empty RPC result means another Hub won the claim', async () => {
      const listener = makeListener(PairedPrintListener, {
        rpc: async () => ({ data: [], error: null })
      });

      assert.equal(await listener.claimAutoPrintLedger('order-1', 'attendance'), null);
    });

    await test('a real RPC error never falls back to insert', async () => {
      let insertCalls = 0;
      const rpcError = Object.assign(new Error('permission denied'), { code: '42501' });
      const listener = makeListener(PairedPrintListener, {
        rpc: async () => ({ data: null, error: rpcError }),
        from: () => ({
          insert: () => {
            insertCalls += 1;
          }
        })
      });

      await assert.rejects(
        () => listener.claimAutoPrintLedger('order-1', 'attendance'),
        (error) => error === rpcError
      );
      assert.equal(insertCalls, 0);
    });

    await test('PGRST202 uses legacy insert and treats 23505 as a lost claim', async () => {
      const listener = makeListener(
        PairedPrintListener,
        makeRpcMissingSupabase({ insertErrorCode: '23505' })
      );

      assert.equal(await listener.claimAutoPrintLedger('order-1', 'attendance'), null);
    });

    await test('42883 for another function never falls back to insert', async () => {
      let insertCalls = 0;
      const rpcError = {
        code: '42883',
        message: 'function public.some_other_function(uuid) does not exist'
      };
      const listener = makeListener(PairedPrintListener, {
        rpc: async () => ({ data: null, error: rpcError }),
        from: () => ({
          insert: () => {
            insertCalls += 1;
          }
        })
      });

      await assert.rejects(
        () => listener.claimAutoPrintLedger('order-1', 'attendance'),
        (error) => error === rpcError
      );
      assert.equal(insertCalls, 0);
    });
  } catch (error) {
    failed += 1;
    console.error('FAIL  test setup');
    console.error(error && error.stack ? error.stack : error);
  } finally {
    Module._load = originalLoad;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
