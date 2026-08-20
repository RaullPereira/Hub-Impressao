const assert = require('node:assert/strict');
const os = require('node:os');
const Module = require('node:module');
const AutoPrintIntentClient = require('../src/main/supabase/auto-print-intent-client');

const originalLoad = Module._load;
const suppliedSupabaseClients = [];
Module._load = function loadElectronStub(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  if (request === '@supabase/supabase-js') {
    return {
      createClient: () => {
        const nextClient = suppliedSupabaseClients.shift();
        if (!nextClient) throw new Error('missing test Supabase instance');
        return nextClient;
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const PairedPrintListener = require('../src/main/supabase/paired-print-listener');

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
    console.error(error?.stack || error);
  }
}

(async () => {
  console.log('--- auto print intent consumer ---');

  await test('claim sends consumer identity and bounded lease arguments', async () => {
    const calls = [];
    const client = new AutoPrintIntentClient({
      rpc: async (name, args) => {
        calls.push({ name, args });
        return { data: [{ id: 'intent-1', lease_token: 'lease-1' }], error: null };
      }
    });

    const rows = await client.claim('store-1', 'hub-1', 10, 90);

    assert.deepEqual(rows, [{ id: 'intent-1', lease_token: 'lease-1' }]);
    assert.deepEqual(calls, [{
      name: 'claim_auto_print_intents',
      args: {
        p_admin_client_id: 'store-1',
        p_claimed_by: 'hub-1',
        p_limit: 10,
        p_lease_seconds: 90
      }
    }]);
  });

  await test('only a missing RPC disables the durable consumer', async () => {
    for (const code of ['PGRST202', '42883']) {
      let calls = 0;
      const client = new AutoPrintIntentClient({
        rpc: async () => {
          calls += 1;
          return {
            data: null,
            error: { code, message: `function ${'claim_auto_print_intents'} not found in schema cache` }
          };
        }
      });

      assert.deepEqual(await client.claim('store-1', 'hub-1'), []);
      assert.equal(client.available, false);
      assert.deepEqual(await client.claim('store-1', 'hub-1'), []);
      assert.equal(calls, 1);
    }
  });

  await test('ordinary RPC failures remain visible to the caller', async () => {
    const rpcError = Object.assign(new Error('permission denied'), { code: '42501' });
    const client = new AutoPrintIntentClient({
      rpc: async () => ({ data: null, error: rpcError })
    });

    await assert.rejects(() => client.claim('store-1', 'hub-1'), rpcError);
    assert.equal(client.available, true);
  });

  await test('a missing error for another symbol never disables this RPC consumer', async () => {
    const rpcError = {
      code: '42883',
      message: 'function public.some_other_function(uuid) does not exist'
    };
    const client = new AutoPrintIntentClient({
      rpc: async () => ({ data: null, error: rpcError })
    });

    await assert.rejects(() => client.claim('store-1', 'hub-1'), (error) => error === rpcError);
    assert.equal(client.available, true);
  });

  await test('a similarly named helper is not the missing RPC requested by this client', async () => {
    const rpcError = {
      code: '42883',
      message: 'function public.claim_auto_print_intents_helper(uuid) does not exist'
    };
    const client = new AutoPrintIntentClient({
      rpc: async () => ({ data: null, error: rpcError })
    });

    await assert.rejects(() => client.claim('store-1', 'hub-1'), (error) => error === rpcError);
    assert.equal(client.available, true);
  });

  await test('reconnect binds an internal intent client to each new Supabase session', async () => {
    const pairing = {
      adminClientId: 'store-1',
      supabaseUrl: 'https://example.supabase.co',
      anonKey: 'anon-key',
      enabled: true,
      session: { access_token: 'access-token', refresh_token: 'refresh-token', expires_at: 9999999999 }
    };
    const makeSupabase = (id) => ({
      id,
      auth: {
        setSession: async () => ({ data: { session: pairing.session }, error: null }),
        stopAutoRefresh: () => {}
      },
      realtime: { setAuth: async () => {} }
    });
    const firstSupabase = makeSupabase('first');
    const secondSupabase = makeSupabase('second');
    suppliedSupabaseClients.push(firstSupabase, secondSupabase);

    const listener = new PairedPrintListener(null, {
      adminClientId: 'store-1',
      pairingStore: {
        getPairing: () => pairing,
        updatePairing: (patch) => Object.assign(pairing, patch),
        clearPairing: () => {}
      }
    });
    listener.refreshPrintSettings = async () => {};
    listener.subscribeChannels = async () => {};
    listener.startHeartbeat = () => {};
    listener.startWatchdog = () => {};
    listener.touchHeartbeat = () => {};
    listener.processPendingJobs = async () => {};

    await listener.startWithPairing(pairing, { recoverMissedOrders: false });
    const firstIntentClient = listener.autoPrintIntentClient;
    await listener.startWithPairing(pairing, { recoverMissedOrders: false });

    assert.notEqual(listener.autoPrintIntentClient, firstIntentClient);
    assert.equal(firstIntentClient.supabase, firstSupabase);
    assert.equal(listener.autoPrintIntentClient.supabase, secondSupabase);
  });

  await test('reconnect preserves an explicitly injected intent client', async () => {
    const pairing = {
      adminClientId: 'store-1',
      supabaseUrl: 'https://example.supabase.co',
      anonKey: 'anon-key',
      enabled: true,
      session: { access_token: 'access-token', refresh_token: 'refresh-token', expires_at: 9999999999 }
    };
    const makeSupabase = (id) => ({
      id,
      auth: {
        setSession: async () => ({ data: { session: pairing.session }, error: null }),
        stopAutoRefresh: () => {}
      },
      realtime: { setAuth: async () => {} }
    });
    const firstSupabase = makeSupabase('injected-first');
    const secondSupabase = makeSupabase('injected-second');
    suppliedSupabaseClients.push(firstSupabase, secondSupabase);
    const injectedClient = { claim: async () => [], settle: async () => [] };
    const listener = new PairedPrintListener(null, {
      adminClientId: 'store-1',
      autoPrintIntentClient: injectedClient,
      pairingStore: {
        getPairing: () => pairing,
        updatePairing: (patch) => Object.assign(pairing, patch),
        clearPairing: () => {}
      }
    });
    listener.refreshPrintSettings = async () => {};
    listener.subscribeChannels = async () => {};
    listener.startHeartbeat = () => {};
    listener.startWatchdog = () => {};
    listener.touchHeartbeat = () => {};
    listener.processPendingJobs = async () => {};

    await listener.startWithPairing(pairing, { recoverMissedOrders: false });
    await listener.startWithPairing(pairing, { recoverMissedOrders: false });

    assert.equal(listener.autoPrintIntentClient, injectedClient);
    assert.equal(listener.supabase, secondSupabase);
  });

  await test('settles retry only before the third attempt and sanitizes durable outcomes', async () => {
    const settlements = [];
    const client = {
      claim: async () => [
        { id: 'retry-1', order_id: 'order-retry', lease_token: 'lease-1', attempt_count: 2 },
        { id: 'retry-3', order_id: 'order-max', lease_token: 'lease-3', attempt_count: 3 },
        { id: 'uncertain', order_id: 'order-uncertain', lease_token: 'lease-u', attempt_count: 1 }
      ],
      settle: async (id, token, outcome, lastError) => {
        settlements.push({ id, token, outcome, lastError });
        return [];
      }
    };
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
    listener.autoPrintIntentClient = client;
    listener.loadOrderById = async (orderId) => ({ id: orderId });
    listener.handleAutoPrintOrder = async (order) => {
      if (order.id === 'order-uncertain') {
        const error = new Error('dados do cliente nunca podem persistir');
        error.printOutcomeUncertain = true;
        return { outcome: 'attention', error };
      }
      return { outcome: 'retry', error: new Error('socket closed para cliente') };
    };

    await listener.processAutoPrintIntents();

    assert.deepEqual(settlements.map(({ id, outcome }) => ({ id, outcome })), [
      { id: 'retry-1', outcome: 'retry' },
      { id: 'retry-3', outcome: 'attention' },
      { id: 'uncertain', outcome: 'attention' }
    ]);
    assert.equal(settlements[0].lastError, 'network');
    assert.equal(settlements[1].lastError, 'network');
    assert.equal(settlements[2].lastError, 'spool_uncertain');
    assert.ok(settlements.every(({ lastError }) => !String(lastError).includes('cliente')));
  });

  await test('two listeners print a durable intent at most once after the shared claim', async () => {
    let claimCalls = 0;
    const printedIntentIds = [];
    const client = {
      claim: async () => {
        claimCalls += 1;
        return claimCalls === 1
          ? [{ id: 'intent-once', order_id: 'order-once', lease_token: 'lease-once', attempt_count: 1 }]
          : [];
      },
      settle: async () => []
    };
    const makeListener = () => {
      const listener = new PairedPrintListener(null, {
        adminClientId: 'store-1',
        pairingStore: { getPairing: () => ({ adminClientId: 'store-1', enabled: true }) }
      });
      listener.currentPairing = { adminClientId: 'store-1' };
      listener.autoPrintIntentClient = client;
      listener.loadOrderById = async () => ({ id: 'order-once' });
      listener.handleAutoPrintOrder = async () => {
        printedIntentIds.push('intent-once');
        return { outcome: 'printed' };
      };
      return listener;
    };

    const firstListener = makeListener();
    const secondListener = makeListener();
    assert.equal(firstListener.consumerId, secondListener.consumerId);

    await Promise.all([firstListener.processAutoPrintIntents(), secondListener.processAutoPrintIntents()]);

    assert.equal(claimCalls, 2);
    assert.equal(new Set(printedIntentIds).size, printedIntentIds.length);
    assert.deepEqual(printedIntentIds, ['intent-once']);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
