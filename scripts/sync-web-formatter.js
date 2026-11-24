// Gera src/main/printer/web-formatter.generated.js a partir do formatador
// oficial da comanda no Pedidos Hub web (src/utils/printer.ts).
//
// O Hub usa esse arquivo quando o render oficial esta fora do ar, para a
// comanda de reserva sair IGUAL a do web. Rode de novo sempre que o layout da
// comanda mudar no web:
//
//   node scripts/sync-web-formatter.js [caminho do repo web]
//
// Padrao do caminho: ../Sistemadegerenciamentodepedidos (ou PEDIDOSHUB_WEB_REPO).

const fs = require('fs');
const path = require('path');

const webRepo = path.resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) || process.env.PEDIDOSHUB_WEB_REPO || path.join(__dirname, '..', '..', 'Sistemadegerenciamentodepedidos')
);
const outFile = path.join(__dirname, '..', 'src', 'main', 'printer', 'web-formatter.generated.js');

for (const file of ['src/utils/printer.ts', 'src/utils/normalize-order-for-print.ts', 'src/utils/print-settings.ts']) {
  if (!fs.existsSync(path.join(webRepo, file))) {
    console.error(`Repo web nao encontrado em ${webRepo} (faltou ${file}).`);
    process.exit(1);
  }
}

const esbuild = require(require.resolve('esbuild', { paths: [webRepo, path.join(__dirname, '..')] }));

const entry = `
import { generateOrderPrintData } from './src/utils/printer';
import { normalizeOrderForPrint } from './src/utils/normalize-order-for-print';
import { DEFAULT_SETTINGS, mapPrintSettingsFromDB, normalizePrintSettings, setPrintSettingsCache } from './src/utils/print-settings';
export { generateOrderPrintData, normalizeOrderForPrint, DEFAULT_SETTINGS, mapPrintSettingsFromDB, normalizePrintSettings, setPrintSettingsCache };
`;

// --check: so confere se o arquivo gerado esta em dia com o web (nao grava).
const checkOnly = process.argv.includes('--check');

esbuild.build({
  write: !checkOnly,
  stdin: { contents: entry, resolveDir: webRepo, sourcefile: 'hub-web-formatter-entry.ts', loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // Electron 22 (build legado do Windows 7) roda Node 16.
  target: 'node16',
  outfile: outFile,
  legalComments: 'none',
  logLevel: 'error',
  banner: {
    js: '// ARQUIVO GERADO por scripts/sync-web-formatter.js a partir do Pedidos Hub web.\n// Nao edite a mao: mude o layout no web (src/utils/printer.ts) e gere de novo.\n/* eslint-disable */'
  }
}).then((result) => {
  if (checkOnly) {
    const fresh = Buffer.from(result.outputFiles[0].contents).toString('utf8');
    const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
    if (fresh !== current) {
      console.error('DESATUALIZADO: o layout da comanda mudou no web. Rode node scripts/sync-web-formatter.js');
      process.exit(1);
    }
    console.log('ok: formatador do Hub em dia com o web');
    return;
  }
  const size = fs.statSync(outFile).size;
  console.log(`ok: ${path.relative(process.cwd(), outFile)} (${Math.round(size / 1024)} KB)`);
}).catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
