// Impressoras térmicas de rede (ESC/POS RAW na porta 9100), sem instalar no Windows.
// O nome usado no sistema é "TCP:IP:porta", o mesmo formato de outros PDVs.
const net = require('net');
const os = require('os');

const DEFAULT_PORT = 9100;

function parseNetworkPrinterName(name) {
  const match = /^tcp:(?:\/\/)?([\w.-]+)(?::(\d{1,5}))?$/i.exec(String(name || '').trim());
  if (!match) return null;
  return { host: match[1], port: Number(match[2] || DEFAULT_PORT) };
}

function networkPrinterName(host, port = DEFAULT_PORT) {
  return `TCP:${host}:${port}`;
}

function localIpv4Prefixes() {
  const prefixes = new Set();
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' && address.family !== 4) continue;
      // Só a faixa /24 do próprio IP, qualquer que seja a máscara da rede (sem varrer redes enormes).
      if (address.internal || !/^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(address.address)) continue;
      prefixes.add(address.address.split('.').slice(0, 3).join('.'));
    }
  }
  return Array.from(prefixes);
}

function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Em lotes: 254 conexões de uma vez travam a resolução de endereços do Windows e a impressora escapa.
async function scanNetworkPrinters({ prefixes = localIpv4Prefixes(), port = DEFAULT_PORT, timeoutMs = 1200, concurrency = 48 } = {}) {
  const hosts = [];
  for (const prefix of prefixes) {
    for (let i = 1; i <= 254; i += 1) hosts.push(`${prefix}.${i}`);
  }
  const found = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = hosts[next++];
      if (await probe(host, port, timeoutMs)) found.push(networkPrinterName(host, port));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found.sort();
}

function sendRawToNetworkPrinter(name, buffer, { timeoutMs = 5000 } = {}) {
  const target = parseNetworkPrinterName(name);
  if (!target) return Promise.reject(new Error(`Endereço de impressora de rede inválido: ${name}`));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(target);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`A impressora de rede ${target.host}:${target.port} não respondeu.`));
    });
    socket.once('error', (error) => reject(new Error(`Falha na impressora de rede ${target.host}:${target.port}: ${error.message}`)));
    socket.once('connect', () => socket.end(buffer));
    socket.once('close', (hadError) => { if (!hadError) resolve({ success: true, mode: 'network' }); });
  });
}

module.exports = {
  parseNetworkPrinterName,
  networkPrinterName,
  localIpv4Prefixes,
  scanNetworkPrinters,
  sendRawToNetworkPrinter,
};
