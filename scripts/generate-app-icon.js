/**
 * Gera app.ico (Windows) e app.png a partir de trayTemplate.png.
 * Usa trayTemplate.png como fonte em tudo; fallback para printer.svg se não existir.
 * Execute: npm run build:icons
 */
const fs = require('fs');
const path = require('path');

const assetsIcons = path.join(__dirname, '..', 'assets', 'icons');
const trayPath = path.join(assetsIcons, 'trayTemplate.png');
const svgPath = path.join(assetsIcons, 'printer.svg');
const icoPath = path.join(assetsIcons, 'app.ico');
const pngPath = path.join(assetsIcons, 'app.png');

async function main() {
  try {
    require('sharp');
    require('to-ico');
  } catch (e) {
    console.warn('generate-app-icon: sharp ou to-ico não instalados. Rode: npm install');
    process.exit(1);
  }

  const sharp = require('sharp');
  const toIco = require('to-ico');

  let inputBuffer;
  if (fs.existsSync(trayPath)) {
    inputBuffer = fs.readFileSync(trayPath);
    console.log('Usando trayTemplate.png como fonte');
  } else if (fs.existsSync(svgPath)) {
    inputBuffer = fs.readFileSync(svgPath);
    console.log('Usando printer.svg como fallback');
  } else {
    console.warn('generate-app-icon: nenhum trayTemplate.png nem printer.svg em', assetsIcons);
    process.exit(1);
  }

  const png256 = await sharp(inputBuffer).resize(256, 256).png().toBuffer();

  const icoBuffer = await toIco([png256], { resize: true });
  fs.writeFileSync(icoPath, icoBuffer);
  console.log('Ícone Windows gerado:', icoPath);

  fs.writeFileSync(pngPath, png256);
  console.log('PNG gerado:', pngPath);
}

main().catch((err) => {
  console.error('generate-app-icon erro:', err);
  process.exit(1);
});
