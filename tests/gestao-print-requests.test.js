// Comandas do app do garçom (hub_gestao_print_requests) consumidas pelo Hub:
//  - exatamente uma impressão por comanda, mesmo com 3 consumidores disputando;
//  - falha de rede volta para a fila e sai na próxima varredura;
//  - sem impressora da via: 'failed' com o motivo (o app mostra para o garçom);
//  - bebida vai para o bar só com impressora de bar configurada.
const assert = require('node:assert/strict');
const os = require('node:os');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir() } };
  return originalLoad.call(this, request, parent, isMain);
};
const PairedPrintListener = require('../src/main/supabase/paired-print-listener');

// Banco falso com UPDATE ... WHERE status='pending' atômico (como o Postgres).
function createDb(requests) {
  const rows = new Map(requests.map((r) => [r.id, { ...r }]));
  const tick = () => new Promise((r) => setImmediate(r));
  const table = () => {
    let patch = null; let filters = []; let wantsSingle = false; let selectOnly = false;
    const q = {
      update(p) { patch = p; return q; },
      select() { if (!patch) selectOnly = true; return q; },
      eq(k, v) { filters.push((row) => row[k] === v); return q; },
      in(k, vs) { filters.push((row) => vs.includes(row[k])); return q; },
      gte() { return q; }, order() { return q; }, limit() { return q; },
      maybeSingle() { wantsSingle = true; return q.run(); },
      then(resolve, reject) { return q.run().then(resolve, reject); },
      async run() {
        await tick();
        const match = [...rows.values()].filter((row) => filters.every((f) => f(row)));
        if (selectOnly) return { data: match.map((row) => ({ ...row })), error: null };
        for (const row of match) Object.assign(row, patch);
        const data = match.map((row) => ({ id: row.id }));
        return { data: wantsSingle ? (data[0] || null) : data, error: null };
      }
    };
    return q;
  };
  return { rows, client: { from: (name) => (name === 'hub_gestao_print_requests' ? table() : null) } };
}

function createHub(db, { printers, renderFails = new Set(), name }) {
  const hub = Object.create(PairedPrintListener.prototype);
  const printed = [];
  Object.assign(hub, {
    supabase: db.client,
    currentPairing: { adminClientId: 'loja' },
    printSettings: {},
    gestaoInFlight: new Set(),
    gestaoAttempts: new Map(),
    gestaoBusinessIds: ['biz'],
    gestaoBusinessIdsAt: Date.now(),
    isStopping: false,
    getLogContext: () => `[${name}]`,
    isAutoPrintStation: () => true,
    refreshPrintersIfNeeded: async () => {},
    resolveAutoPrintPrinterId: async (route) => printers[route] || null,
    resolveAvailablePrinterId: async () => null,
    requestOfficialRender: async ({ gestaoPrintRequestId, hasBarRoute }) => {
      if (renderFails.has(gestaoPrintRequestId)) {
        renderFails.delete(gestaoPrintRequestId);
        throw new Error('fetch failed');
      }
      const row = db.rows.get(gestaoPrintRequestId);
      const routes = row.print_type === 'items'
        ? (row.hasDrink && hasBarRoute ? ['kitchen', 'bar'] : ['kitchen'])
        : [row.route || 'counter'];
      return { gestaoPrintJobs: routes.map((route) => ({ route, encoding: 'base64', rawContent: Buffer.from(`${gestaoPrintRequestId}:${route}`).toString('base64') })) };
    },
    runPrintActionWithRetry: async (fn) => fn(),
    printRawPayload: async (printer, payload) => { printed.push(`${printer}|${Buffer.from(payload.rawContent, 'base64').toString()}`); },
    isRetriablePrintError: (error) => /fetch failed|timeout/i.test(String(error?.message || error))
  });
  Settings.getStorePrinters = () => ({});
  return { hub, printed };
}
const Settings = require('../src/main/config/settings');

(async () => {
  // 300 comandas de pico: itens novos de mesa (metade com bebida) e fechamentos.
  const requests = [];
  for (let i = 0; i < 300; i += 1) {
    const isClose = i % 5 === 0;
    requests.push({
      id: `r${i}`, business_id: 'biz', status: 'pending',
      print_type: isClose ? 'order' : 'items', route: isClose ? 'counter' : undefined,
      hasDrink: !isClose && i % 2 === 0
    });
  }
  const db = createDb(requests);
  const printers = { kitchen: 'TCP:192.168.0.107:9100', attendance: 'caixa' };
  const failOnce = new Set(['r7', 'r42', 'r199']);
  const hubs = [
    createHub(db, { printers, renderFails: failOnce, name: 'hub-caixa' }),
    createHub(db, { printers, name: 'hub-2' }),
    createHub(db, { printers, name: 'aba-web' })
  ];

  const started = Date.now();
  // Cada comanda chega pelo tempo real nos três ao mesmo tempo.
  await Promise.all(requests.map((r) => Promise.all(hubs.map(({ hub }) => hub.processGestaoPrintRequest({ ...r }, 'realtime_insert')))));
  // As que falharam na rede voltaram para 'pending': a varredura pega.
  await hubs[0].hub.sweepGestaoPrintRequests();
  const elapsedMs = Date.now() - started;

  const all = hubs.flatMap(({ printed }) => printed);
  const perRequest = new Map();
  for (const line of all) {
    const key = line.split('|')[1];
    perRequest.set(key, (perRequest.get(key) || 0) + 1);
  }
  const expectedTickets = requests.reduce((n, r) => n + 1, 0); // sem bar: 1 via por comanda
  assert.equal(all.length, expectedTickets, `vias impressas ${all.length} != ${expectedTickets}`);
  assert.ok([...perRequest.values()].every((count) => count === 1), 'alguma via saiu duas vezes');
  assert.ok([...db.rows.values()].every((row) => row.status === 'printed'), 'sobrou comanda sem imprimir');
  // Cozinha só com itens; fechamento só no caixa.
  assert.ok(all.filter((l) => l.includes(':counter')).every((l) => l.startsWith('caixa|')));
  assert.ok(all.filter((l) => l.includes(':kitchen')).every((l) => l.startsWith('TCP:192.168.0.107:9100|')));
  console.log(`  300 comandas, 3 consumidores: ${all.length} vias, nenhuma duplicada, ${elapsedMs} ms`);

  // Com impressora de bar: bebida separada.
  const db2 = createDb([{ id: 'b1', business_id: 'biz', status: 'pending', print_type: 'items', hasDrink: true }]);
  const withBar = createHub(db2, { printers: { kitchen: 'COZINHA', attendance: 'caixa', bar: 'BAR' }, name: 'hub-bar' });
  await withBar.hub.processGestaoPrintRequest({ ...db2.rows.get('b1') });
  assert.deepEqual(withBar.printed.sort(), ['BAR|b1:bar', 'COZINHA|b1:kitchen']);

  // Sem impressora de caixa: falha com o motivo, sem tentar de novo.
  const db3 = createDb([{ id: 'c1', business_id: 'biz', status: 'pending', print_type: 'order', route: 'counter' }]);
  const noCounter = createHub(db3, { printers: { kitchen: 'COZINHA' }, name: 'hub-sem-caixa' });
  await noCounter.hub.processGestaoPrintRequest({ ...db3.rows.get('c1') });
  const row = db3.rows.get('c1');
  assert.equal(row.status, 'failed');
  assert.match(row.error, /Sem impressora de caixa/);
  assert.equal(noCounter.printed.length, 0);

  console.log('gestao-print-requests: OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
