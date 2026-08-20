const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const TEMP_ROOT = path.join(ROOT_DIR, '.build', 'win7-legacy');
const OUTPUT_DIR = path.join(ROOT_DIR, 'dist-win7');
const ELECTRON_WIN7_VERSION = '22.3.27';
const NODE_FETCH_VERSION = '^2.7.0';

const COPY_TARGETS = [
  'src',
  'assets',
  'scripts',
  'package.json',
  'package-lock.json'
];

function log(message) {
  console.log(`[build:win7] ${message}`);
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

  packageJson.devDependencies = packageJson.devDependencies || {};
  packageJson.dependencies = packageJson.dependencies || {};
  packageJson.devDependencies.electron = ELECTRON_WIN7_VERSION;
  packageJson.dependencies['node-fetch'] = packageJson.dependencies['node-fetch'] || NODE_FETCH_VERSION;

  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function copyBuildOutputs() {
  const builtDistPath = path.join(TEMP_ROOT, 'dist');
  if (!fs.existsSync(builtDistPath)) {
    throw new Error('Build Win7 concluído sem gerar a pasta dist.');
  }

  removeIfExists(OUTPUT_DIR);
  fs.cpSync(builtDistPath, OUTPUT_DIR, { recursive: true });
}

function main() {
  log('Preparando workspace temporário para build legado do Windows 7...');

  log('Garantindo ícones a partir da linha principal do projeto...');
  run('npm run build:icons', ROOT_DIR);

  removeIfExists(TEMP_ROOT);
  ensureDir(TEMP_ROOT);

  for (const target of COPY_TARGETS) {
    copyTarget(target);
  }

  patchPackageJson();

  log(`Instalando dependências com Electron ${ELECTRON_WIN7_VERSION}...`);
  run('npm install', TEMP_ROOT);

  log('Gerando instalador legado do Windows 7...');
  run('npx electron-builder --win --x64 --ia32', TEMP_ROOT);

  copyBuildOutputs();

  log(`Build Win7 pronta em: ${OUTPUT_DIR}`);
  log('A linha principal do projeto não foi alterada.');
}

try {
  main();
} catch (error) {
  console.error(`[build:win7] Falha: ${error && error.message ? error.message : error}`);
  process.exit(1);
}
