// Vias de cozinha/bar sem itens, roteamento do bar e queda para o formato antigo.
//
// Run: node tests/production-via-routing.test.js

const assert = require('assert');
const os = require('os');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// Copia do pacote do web com as funcoes trocaveis (o pacote exporta getters):
// o formatador carrega o pacote pelo require.cache na primeira comanda.
const webPath = require.resolve('../src/main/printer/web-formatter.generated');
const web = { ...require(webPath) };
require.cache[webPath].exports = web;

const PairedPrintListener = require('../src/main/supabase/paired-print-listener');
const formatter = require('../src/main/printer/pedidoshub-formatter');
const CUPSPrinterManager = require('../src/main/printer/cups-manager');
const { buildPrintPerformanceRecord } = require('../src/main/utils/print-telemetry');

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

const order = {
  id: 'o-1',
  order_number: 41,
  order_type: 'delivery',
  customer_name: 'Cliente Teste',
  total: 100,
  payment_method: 'pix',
  items: [{ name: 'Pizza Grande', category: 'Pizzas', quantity: 1, unitPrice: 100, totalPrice: 100 }]
};

function makeListener() {
  const printed = [];
  const resolved = [];
  const listener = new PairedPrintListener({ refreshPrinters: async () => {}, print: async (job) => { printed.push(job); } }, {
    adminClientId: 'store-1',
    pairingStore: { getPairing: () => ({ adminClientId: 'store-1', enabled: true }), savePairing() {}, updatePairing() {}, clearPairing() {} }
  });
  listener.currentPairing = { adminClientId: 'store-1', appBaseUrl: 'http://x' };
  listener.resolveAvailablePrinterId = async (type) => { resolved.push(type); return ({ counter: 'Caixa', kitchen: 'Cozinha' })[type] || null; };
  listener.requestOfficialRender = async (req) => ({
    printType: req.printType,
    encoding: 'base64',
    rawContent: Buffer.from(`OFICIAL-${req.printType}`).toString('base64')
  });
  return { listener, printed, resolved };
}

(async () => {
  console.log('--- vias de producao e roteamento do bar ---');

  await test('altura dupla do formato antigo e GS ! 0x01 (largura dupla 0x10)', async () => {
    assert.strictEqual(formatter.CMD.TXT_DOUBLE_H, '\x1D\x21\x01');
    assert.strictEqual(formatter.CMD.TXT_DOUBLE_W, '\x1D\x21\x10');
  });

  await test('formato antigo nunca imprime via completa no bar', async () => {
    assert.deepStrictEqual(formatter.generateLegacyOrderPrintData(order, 'bar', { paperWidth: 32 }), []);
    assert.deepStrictEqual(formatter.generateLegacyOrderPrintData(order, 'bar', { paperWidth: 48 }), []);
  });

  await test('bar sem bebida no layout do web sai vazio, sem cair no formato antigo', async () => {
    const commands = formatter.generateOrderPrintData(order, 'bar', { paperWidth: 32 });
    assert.deepStrictEqual(commands, []);
    assert.strictEqual(formatter.getLastLayout(), 'vazio');
    formatter.generateOrderPrintData(order, 'counter', { paperWidth: 32 });
    assert.strictEqual(formatter.getLastLayout(), 'web');
  });

  await test('erro no layout do web cai no formato antigo, com log e getLastLayout legado', async () => {
    const messages = [];
    const original = web.generateOrderPrintData;
    formatter.setFormatterLogger((message) => messages.push(message));
    web.generateOrderPrintData = () => { throw new Error('quebrou'); };
    try {
      const commands = formatter.generateOrderPrintData(order, 'counter', { paperWidth: 32 });
      assert.ok(commands.join('').toUpperCase().includes('PIZZA'));
      assert.strictEqual(formatter.getLastLayout(), 'legado');
      assert.strictEqual(messages.length, 1);
      assert.ok(messages[0].includes('layout do web falhou; usando formato antigo'));
      assert.ok(messages[0].includes('counter'));
      assert.ok(messages[0].includes('#41'));
      assert.ok(messages[0].includes('quebrou'));
    } finally {
      web.generateOrderPrintData = original;
      formatter.setFormatterLogger(null);
    }
  });

  await test('job com variante bar usa so a variante bar; sem ela nao usa a do caixa', async () => {
    const { listener } = makeListener();
    const b64 = (text) => Buffer.from(text).toString('base64');
    assert.strictEqual(
      listener.getJobPayload({ content: { rawContent: b64('caixa'), variants: { bar: { rawContent: b64('bar') } } } }, 'bar').rawContent,
      b64('bar')
    );
    assert.strictEqual(listener.getJobPayload({ content: { rawContent: b64('caixa'), variants: { counter: { rawContent: b64('caixa') } } } }, 'bar'), null);
    assert.deepStrictEqual(
      listener.getJobPayload({ content: { variants: { kitchen: { rawContent: '' } } } }, 'kitchen'),
      { skip: true, printType: 'kitchen' }
    );
  });

  await test('modo antigo: via bar vai para a impressora do bar', async () => {
    const { listener, printed, resolved } = makeListener();
    listener.resolveGestaoRoutePrinter = async (route) => (route === 'bar' ? 'Bar' : null);
    const outcome = await listener.printWithRouting('o-1', 'bar', null, order);
    assert.strictEqual(outcome, 'printed');
    assert.deepStrictEqual(printed.map((job) => [job.printer, Buffer.from(job.rawContent, 'base64').toString()]), [['Bar', 'OFICIAL-bar']]);
    assert.deepStrictEqual(resolved, []);
  });

  await test('modo antigo: sem impressora de bar nada e impresso no caixa', async () => {
    const { listener, printed, resolved } = makeListener();
    listener.resolveGestaoRoutePrinter = async () => null;
    const outcome = await listener.printWithRouting('o-1', 'bar', null, order);
    assert.strictEqual(outcome, 'skipped');
    assert.deepStrictEqual(printed, []);
    assert.deepStrictEqual(resolved, []);
  });

  await test('via kitchen vazia no roteamento nao manda nada para a impressora', async () => {
    const { listener, printed } = makeListener();
    listener.requestOfficialRender = async (req) => ({ printType: req.printType, encoding: 'base64', rawContent: '' });
    const outcome = await listener.printWithRouting('o-1', 'kitchen', null, order);
    assert.strictEqual(outcome, 'empty');
    assert.deepStrictEqual(printed, []);
  });

  await test('modo antigo: via vazia conta como resolvida e mantem o claim', async () => {
    const { listener } = makeListener();
    const released = [];
    const telemetry = [];
    listener.printSettings = { ...listener.printSettings, autoPrintEnabled: true, autoPrintRoutes: ['kitchen'] };
    listener.hasPendingRoutePrintJob = async () => false;
    listener.claimAutoPrintLedger = async (_orderId, route) => ({ id: `claim-${route}` });
    listener.releaseAutoPrintLedger = async (id) => { released.push(id); };
    listener.emitAutoPrintTelemetry = (_context, details) => { telemetry.push(details); };
    listener.printWithRouting = async () => 'empty';
    await listener.handleAutoPrintOrder({ ...order, status: 'confirmed' }, 'teste');
    assert.deepStrictEqual(released, []);
    assert.deepStrictEqual(telemetry.map((entry) => entry.outcome), ['empty']);
    assert.ok(listener.processedOrderIds.has('o-1'));
  });

  await test('telemetria aceita outcome empty e registra o layout so quando houver', async () => {
    const record = buildPrintPerformanceRecord({ outcome: 'empty', layout: 'legado' }, {});
    assert.strictEqual(record.outcome, 'empty');
    assert.strictEqual(record.layout, 'legado');
    assert.strictEqual('layout' in buildPrintPerformanceRecord({ outcome: 'printed' }, {}), false);
  });

  await test('gerenciador CUPS: buffer vazio retorna sucesso sem chamar lp', async () => {
    const result = await CUPSPrinterManager.prototype._executePrint.call(
      {},
      { name: 'Bar' },
      { ...order, items: [] },
      Buffer.alloc(0),
      true,
      'bar',
      { paperWidth: 32 }
    ).catch((error) => error);
    assert.strictEqual(result instanceof Error, false, String(result));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  Module._load = originalLoad;
  process.exit(failed > 0 ? 1 : 0);
})();
