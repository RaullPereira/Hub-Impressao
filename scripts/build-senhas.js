const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const TEMP_ROOT = path.join(ROOT_DIR, '.build', 'senhas');
const OUTPUT_DIR = path.join(ROOT_DIR, 'dist-senhas');
const ELECTRON_WIN7_VERSION = '22.3.27';
const NODE_FETCH_VERSION = '^2.7.0';
const USE_WIN7 = process.argv.includes('--win7');
const BUILD_MAC = process.argv.includes('--mac') || process.argv.includes('--all');
const BUILD_WIN = !process.argv.includes('--mac') || process.argv.includes('--all') || USE_WIN7;

const COPY_TARGETS = [
  'src',
  'assets',
  'scripts',
  'package.json',
  'package-lock.json'
];

function log(message) {
  console.log(`[build:senhas] ${message}`);
}

function run(command, cwd) {
  execSync(command, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_package_lock: 'true'
    }
  });
}

function removeIfExists(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function copyTarget(relativePath) {
  const sourcePath = path.join(ROOT_DIR, relativePath);
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  const destinationPath = path.join(TEMP_ROOT, relativePath);
  fs.cpSync(sourcePath, destinationPath, { recursive: true });
}

function patchPackageJson() {
  const packageJsonPath = path.join(TEMP_ROOT, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  packageJson.name = 'hub-impressao-senhas';
  packageJson.description = 'Servico local de impressao para senhas';
  packageJson.author = 'Servico Local';
  packageJson.main = 'src/main/senhas-entry.js';
  packageJson.build = packageJson.build || {};
  packageJson.build.appId = 'com.seuprojeto.hubimpressao.senhas';
  packageJson.build.productName = 'Hub Impressao Senhas';
  packageJson.build.publish = [];
  packageJson.build.mac = {
    ...(packageJson.build.mac || {}),
    identity: null,
    target: ['zip']
  };
  packageJson.build.nsis = {
    ...(packageJson.build.nsis || {}),
    artifactName: '${productName}-${version}-${arch}.${ext}'
  };

  if (USE_WIN7) {
    packageJson.devDependencies = packageJson.devDependencies || {};
    packageJson.dependencies = packageJson.dependencies || {};
    packageJson.devDependencies.electron = ELECTRON_WIN7_VERSION;
    packageJson.dependencies['node-fetch'] = packageJson.dependencies['node-fetch'] || NODE_FETCH_VERSION;
  }

  if (packageJson.dependencies) {
    delete packageJson.dependencies['@supabase/supabase-js'];
  }

  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function createVariantEntry() {
  const entryPath = path.join(TEMP_ROOT, 'src', 'main', 'senhas-entry.js');
  const content = `process.env.HUB_VARIANT_NAME = process.env.HUB_VARIANT_NAME || 'senhas';
process.env.HUB_DISABLE_PAIRING = process.env.HUB_DISABLE_PAIRING || '1';
process.env.HUB_HTTP_PORT = process.env.HUB_HTTP_PORT || '3002';
process.env.HUB_WS_PORT = process.env.HUB_WS_PORT || '3001';

require('./index');
`;

  fs.writeFileSync(entryPath, content);
}

function patchMainProcess() {
  const indexPath = path.join(TEMP_ROOT, 'src', 'main', 'index.js');
  let source = fs.readFileSync(indexPath, 'utf8');

  source = source.replace(
    "const MultiPairedPrintListener = require('./supabase/multi-paired-print-listener');",
    'let MultiPairedPrintListener = null;'
  );
  source = source.replace(
    'this.pairedPrintListener = new MultiPairedPrintListener(this.printerManager);',
    [
      "if (!MultiPairedPrintListener) {",
      "          MultiPairedPrintListener = require('./supabase/multi-paired-print-listener');",
      '        }',
      '        this.pairedPrintListener = new MultiPairedPrintListener(this.printerManager);'
    ].join('\n        ')
  );

  fs.writeFileSync(indexPath, source);
  removeIfExists(path.join(TEMP_ROOT, 'src', 'main', 'supabase'));
}

function patchRenderer() {
  const htmlPath = path.join(TEMP_ROOT, 'src', 'renderer', 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');

  html = html
    .replace(/<title>Hub Impressão<\/title>/g, '<title>Hub Impressao Senhas</title>')
    .replace(/<h2>Hub Impressão<\/h2>/g, '<h2>Hub Impressao Senhas</h2>')
    .replace(/<div class="version">v1\.0\.0<\/div>/g, '<div class="version">versao senhas</div>')
    .replace(/<span class="value">Porta 3001<\/span>/g, '<span class="value">WebSocket 3001</span>')
    .replace(/\n        <div class="support-block">[\s\S]*?\n        <\/div>/, '');

  fs.writeFileSync(htmlPath, html);
}

function copyBuildOutputs() {
  const builtDistPath = path.join(TEMP_ROOT, 'dist');
  if (!fs.existsSync(builtDistPath)) {
    throw new Error('Build de senhas concluido sem gerar a pasta dist.');
  }

  removeIfExists(OUTPUT_DIR);
  fs.cpSync(builtDistPath, OUTPUT_DIR, { recursive: true });
}

function main() {
  const targetLabel = BUILD_MAC && BUILD_WIN ? 'Windows e Mac' : BUILD_MAC ? 'Mac' : 'Windows';
  log(`Preparando workspace temporario para ${targetLabel}${USE_WIN7 ? ' com Electron compativel com Windows 7' : ''}...`);

  log('Garantindo icones a partir da linha principal do projeto...');
  run('npm run build:icons', ROOT_DIR);

  removeIfExists(TEMP_ROOT);
  ensureDir(TEMP_ROOT);

  for (const target of COPY_TARGETS) {
    copyTarget(target);
  }

  patchPackageJson();
  createVariantEntry();
  patchMainProcess();
  patchRenderer();

  log('Instalando dependencias da variante...');
  run('npm install', TEMP_ROOT);

  if (BUILD_WIN) {
    log('Gerando instalador Windows da variante de senhas...');
    run('npx electron-builder --win --x64 --ia32', TEMP_ROOT);
  }

  if (BUILD_MAC) {
    log('Gerando build Mac da variante de senhas...');
    run('npx electron-builder --mac --x64 --arm64', TEMP_ROOT);
  }

  copyBuildOutputs();

  log(`Build de senhas pronta em: ${OUTPUT_DIR}`);
  log('A linha principal do projeto nao foi alterada.');
}

try {
  main();
} catch (error) {
  console.error(`[build:senhas] Falha: ${error && error.message ? error.message : error}`);
  process.exit(1);
}
