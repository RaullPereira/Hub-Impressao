// Cada impressora imprime no automático só os tipos de pedido escolhidos no cadastro.
// Pizza & Cia: mesa só na cozinha; o caixa fica com balcão e delivery.
const assert = require('node:assert/strict');
const os = require('node:os');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir() } };
  return originalLoad.call(this, request, parent, isMain);
};
const { buildAutoPrintRoutesForOrder, normalizeAutoPrintMap } = require('../src/main/print-routes');
const Settings = require('../src/main/config/settings');

const map = {
  kitchen: 'TCP:192.168.0.107:9100',
  attendance: 'caixa',
  orderTypes: { attendance: ['balcao', 'delivery'] }
};
const routesFor = (order_type) => buildAutoPrintRoutesForOrder(map, { order_type }).map((r) => r.route);

assert.deepEqual(routesFor('mesa'), ['kitchen']);
assert.deepEqual(routesFor('balcao'), ['kitchen', 'attendance']);
assert.deepEqual(routesFor('delivery'), ['kitchen', 'attendance']);
// Sem tipos escolhidos (ou todos) = imprime tudo, como antes.
assert.deepEqual(buildAutoPrintRoutesForOrder({ kitchen: 'K', attendance: 'C' }, { order_type: 'mesa' }).map((r) => r.route), ['kitchen', 'attendance']);
assert.equal(normalizeAutoPrintMap({ kitchen: 'K', orderTypes: { kitchen: ['mesa', 'balcao', 'delivery'] } }).orderTypes, undefined);
// O filtro sobrevive ao salvar as impressoras da loja no Hub.
Settings.setStorePrinters('loja-teste', { kitchen: 'K', autoPrint: map }, { replace: true });
assert.deepEqual(Settings.getStorePrinters('loja-teste').autoPrint.orderTypes, { attendance: ['balcao', 'delivery'] });
// Mesa lançada pelo garçom no app: só cozinha no automático, mesmo sem filtro de tipo
// (a comanda completa sai no caixa quando o garçom pede o fechamento).
const appTable = { order_type: 'mesa', hub_gestao_order_id: 'h1' };
assert.deepEqual(buildAutoPrintRoutesForOrder({ kitchen: 'K', attendance: 'C' }, appTable).map((r) => r.route), ['kitchen']);
assert.deepEqual(buildAutoPrintRoutesForOrder({ kitchen: 'K', attendance: 'C' }, { order_type: 'delivery', hub_gestao_order_id: 'h2' }).map((r) => r.route), ['kitchen', 'attendance']);
console.log('auto-print-order-types: OK');
process.exit(0);
