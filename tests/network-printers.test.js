// Teste standalone: impressora de rede (TCP:IP:porta) encontrada na busca e recebendo bytes.
const net = require('net');
const assert = require('assert');
const np = require('../src/main/printer/network-printers');

(async () => {
  assert.deepStrictEqual(np.parseNetworkPrinterName('TCP:192.168.0.107:9100'), { host: '192.168.0.107', port: 9100 });
  assert.deepStrictEqual(np.parseNetworkPrinterName('tcp://192.168.0.50'), { host: '192.168.0.50', port: 9100 });
  assert.strictEqual(np.parseNetworkPrinterName('POS80 Printer'), null);

  const received = [];
  const server = net.createServer((socket) => socket.on('data', (d) => received.push(d)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const found = await np.scanNetworkPrinters({ prefixes: ['127.0.0'], port, timeoutMs: 300, concurrency: 8 });
  assert.ok(found.includes(`TCP:127.0.0.1:${port}`), `busca não achou: ${found}`);

  const result = await np.sendRawToNetworkPrinter(`TCP:127.0.0.1:${port}`, Buffer.from('ola'));
  assert.strictEqual(result.success, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(Buffer.concat(received).toString(), 'ola');

  await assert.rejects(np.sendRawToNetworkPrinter('TCP:127.0.0.1:1', Buffer.from('x'), { timeoutMs: 500 }));
  server.close();
  console.log('network-printers: OK');
})().catch((e) => { console.error(e); process.exit(1); });
