const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('module');
const load = Module._load;
Module._load = function (name, parent, main) {
  if (name === 'electron') return { app: { getPath: () => require('os').tmpdir() } };
  return load.call(this, name, parent, main);
};
const Listener = require(process.env.HUB_LISTENER || '../src/main/supabase/paired-print-listener');
function listener(supabase) {
  const l = Object.create(Listener.prototype);
  l.supabase = supabase;
  l.currentPairing = { adminClientId: 'store-1' };
  return l;
}
test('missing session never queries print_jobs', async () => {
  let queries = 0;
  const l = listener({ auth: { getSession: async () => ({ data: { session: null } }) }, from() { queries++; } });
  await assert.rejects(l.processPendingJobs(), /Sessão do serviço indisponível/);
  assert.equal(queries, 0);
});
test('auth failure never queries print_jobs', async () => {
  const error = new Error('refresh failed');
  const l = listener({ auth: { getSession: async () => ({ data: {}, error }) }, from() { throw new Error('unexpected query'); } });
  await assert.rejects(l.processPendingJobs(), error);
});
test('competing claims return one winner and never insert directly', async () => {
  let claimed = false;
  const l = listener({ async rpc(name, params) {
    assert.equal(name, 'claim_auto_print_job');
    assert.deepEqual(params, { p_admin_client_id: 'store-1', p_order_id: 'order-1', p_printer_type: 'counter' });
    const data = claimed ? [] : [{ id: 'winner' }]; claimed = true;
    return { data, error: null };
  }, from() { throw new Error('direct insert forbidden'); } });
  assert.deepEqual(await Promise.all([l.claimAutoPrintLedger('order-1','counter'), l.claimAutoPrintLedger('order-1','counter')]), [{ id: 'winner' }, null]);
});
test('RPC permission errors propagate without legacy insert fallback', async () => {
  const error = { code: '42501' };
  const l = listener({ rpc: async () => ({ error }), from() { throw new Error('direct insert forbidden'); } });
  await assert.rejects(l.claimAutoPrintLedger('order-1','counter'), e => e === error);
});
test('WebSocket notification reuses a printed route without updating or inserting', async () => {
  const winner = { id: 'winner', printer_type: 'counter', status: 'printed' };
  const filters = [];
  const q = {
    select() { return this; },
    eq(k,v) { filters.push([k,v]); return this; },
    in() { return this; },
    order() { return this; },
    update() { throw new Error('update forbidden'); },
    async limit() { return { data: [winner], error: null }; },
  };
  const l = listener({ from: () => q, rpc() { throw new Error('insert forbidden'); } });
  assert.equal(await l.markOrderPrinted('order-1','counter'), winner);
  assert.ok(filters.some(([k,v]) => k === 'printer_type' && v === 'counter'));
});
