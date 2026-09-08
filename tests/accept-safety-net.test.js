// Teste standalone da rede de seguranca "imprimir somente ao aceitar".
// Valida recoverDeferredAcceptOrders: imprime pedidos adiados que ja foram
// aceitos (sem depender de created_at nem do evento UPDATE do Realtime) e
// mantem os que ainda aguardam aceite.
//
// Rodar: node tests/accept-safety-net.test.js

// Mock do modulo 'electron' (o logger usa app.getPath) para rodar fora do Electron.
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
  if (got === want) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

// Cria um listener com dependencias minimas mockadas.
function makeListener(ordersById, options = {}) {
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
  listener.printSettings = Object.assign({}, listener.printSettings, {
    autoPrintEnabled: true,
    autoPrintOnAcceptEnabled: true,
    autoPrintType: 'counter'
  });

  // Mock do supabase: select().eq().in() resolve com os pedidos pedidos por ID.
  listener.supabase = {
    from() {
      const ctx = { _ids: null };
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        in(_col, ids) { ctx._ids = ids; return builder; },
        then(resolve) {
          const data = (ctx._ids || []).map((id) => ordersById[id]).filter(Boolean);
          resolve({ data, error: null });
        }
      };
      return builder;
    }
  };

  // Captura quais pedidos foram enviados para impressao.
  listener.printed = [];
  if (options.stubHandleAutoPrintOrder !== false) {
    listener.handleAutoPrintOrder = async (order) => {
      listener.printed.push(String(order.id));
      // espelha o comportamento real: ao imprimir, sai da rede de seguranca
      listener.deferredAcceptOrderIds.delete(String(order.id));
    };
  }

  return listener;
}

(async () => {
  console.log('--- recoverDeferredAcceptOrders ---');

  // Cenario 1: pedido aceito (saiu de awaiting) deve imprimir.
  {
    const orders = {
      'o1': { id: 'o1', order_number: 1, source: 'digital_menu', status: 'preparing' }
    };
    const l = makeListener(orders);
    l.deferredAcceptOrderIds.add('o1');
    await l.recoverDeferredAcceptOrders();
    check('aceito (preparing) imprime', l.printed.includes('o1'), true);
    check('aceito sai da rede de seguranca', l.deferredAcceptOrderIds.has('o1'), false);
  }

  // Cenario 2: pedido ainda aguardando NAO imprime e permanece na rede.
  {
    const orders = {
      'o2': { id: 'o2', order_number: 2, source: 'online', status: 'awaiting' }
    };
    const l = makeListener(orders);
    l.deferredAcceptOrderIds.add('o2');
    await l.recoverDeferredAcceptOrders();
    check('aguardando NAO imprime', l.printed.includes('o2'), false);
    check('aguardando permanece na rede', l.deferredAcceptOrderIds.has('o2'), true);
  }

  // Cenario 3: pedido cancelado sai da rede sem imprimir.
  {
    const orders = {
      'o3': { id: 'o3', order_number: 3, source: 'online', status: 'canceled' }
    };
    const l = makeListener(orders, { stubHandleAutoPrintOrder: false });
    l.deferredAcceptOrderIds.add('o3');
    await l.recoverDeferredAcceptOrders();
    check('cancelado NAO imprime', l.printed.includes('o3'), false);
    check('cancelado sai da rede', l.deferredAcceptOrderIds.has('o3'), false);
  }

  // Cenario 4: opcao de aceite desligada -> nao faz nada.
  {
    const orders = {
      'o4': { id: 'o4', order_number: 4, source: 'online', status: 'preparing' }
    };
    const l = makeListener(orders);
    l.printSettings.autoPrintOnAcceptEnabled = false;
    l.deferredAcceptOrderIds.add('o4');
    await l.recoverDeferredAcceptOrders();
    check('aceite desligado -> nao imprime', l.printed.includes('o4'), false);
  }

  // Cenario 5: chegada automatica desligada + aceite ligado ainda imprime ao aceitar.
  {
    const orders = {
      'o5': { id: 'o5', order_number: 5, source: 'online', status: 'preparing' }
    };
    const l = makeListener(orders);
    l.printSettings.autoPrintEnabled = false;
    l.printSettings.autoPrintOnAcceptEnabled = true;
    l.deferredAcceptOrderIds.add('o5');
    await l.recoverDeferredAcceptOrders();
    check('somente aceite ligado -> imprime aceito', l.printed.includes('o5'), true);
  }

  // Cenario 6: Set vazio -> no-op sem erro.
  {
    const l = makeListener({});
    await l.recoverDeferredAcceptOrders();
    check('set vazio -> nada impresso', l.printed.length, 0);
  }

  // Cenario 7: iFood aguardando aceite entra na rede de seguranca.
  {
    const orders = {
      'o6-ifood': { id: 'o6-ifood', order_number: 6, order_origin: 'ifood', status: 'awaiting' }
    };
    const l = makeListener(orders, { stubHandleAutoPrintOrder: false });
    l.printSettings.autoPrintEnabled = false;
    l.printSettings.autoPrintOnAcceptEnabled = true;
    await l.handleAutoPrintOrder(orders['o6-ifood'], 'test-ifood-insert');
    check('ifood aguardando aceite NAO imprime na chegada', l.printed.includes('o6-ifood'), false);
    check('ifood aguardando aceite fica na rede de seguranca', l.deferredAcceptOrderIds.has('o6-ifood'), true);
  }

  // Cenario 8: pedido aguardou aceite por tempo demais -> nao imprime backlog antigo.
  {
    const orders = {
      'o7': { id: 'o7', order_number: 7, source: 'online', status: 'preparing' }
    };
    const l = makeListener(orders);
    l.deferredAcceptOrderIds.add('o7');
    l.deferredAcceptOrderTimes.set('o7', Date.now() - 10 * 60 * 1000);
    await l.recoverDeferredAcceptOrders();
    check('aceite antigo NAO imprime backlog', l.printed.includes('o7'), false);
    check('aceite antigo sai da rede de seguranca', l.deferredAcceptOrderIds.has('o7'), false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
