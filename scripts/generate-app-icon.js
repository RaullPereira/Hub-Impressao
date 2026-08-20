/**
 * Gera app.ico (Windows) e app.png.
 * No Windows, prefere tray-win.svg para evitar ícone invisível no tray.
 * Fallback para trayTemplate.png e, por último, printer.svg.
 * Execute: npm run build:icons
 */
const fs = require('fs');
const path = require('path');

const assetsIcons = path.join(__dirname, '..', 'assets', 'icons');
const trayWinPath = path.join(assetsIcons, 'tray-win.svg');
const trayPath = path.join(assetsIcons, 'trayTemplate.png');
const svgPath = path.join(assetsIcons, 'printer.svg');
const icoPath = path.join(assetsIcons, 'app.ico');
const pngPath = path.join(assetsIcons, 'app.png');

async function main() {
  try {
    require('sharp');
    require('to-ico');
  } catch (e) {
    if (fs.existsSync(icoPath) && fs.existsSync(pngPath)) {
      console.warn('generate-app-icon: sharp/to-ico indisponíveis; reutilizando app.ico e app.png existentes');
      process.exit(0);
    }

    console.warn('generate-app-icon: sharp ou to-ico não instalados. Rode: npm install');
    process.exit(1);
  }

  const sharp = require('sharp');
  const toIco = require('to-ico');

  let inputBuffer;
  let sourceLabel = '';
  if (fs.existsSync(trayWinPath)) {
    inputBuffer = fs.readFileSync(trayWinPath);
    sourceLabel = 'tray-win.svg';
  } else if (fs.existsSync(trayPath)) {
    inputBuffer = fs.readFileSync(trayPath);
    sourceLabel = 'trayTemplate.png';
  } else if (fs.existsSync(svgPath)) {
    inputBuffer = fs.readFileSync(svgPath);
    sourceLabel = 'printer.svg';
  } else {
    console.warn('generate-app-icon: nenhum tray-win.svg, trayTemplate.png nem printer.svg em', assetsIcons);
    process.exit(1);
  }

  console.log(`Usando ${sourceLabel} como fonte`);

  const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const icoBuffers = await Promise.all(
    icoSizes.map((size) => sharp(inputBuffer).resize(size, size).png().toBuffer())
  );
  const png256 = icoBuffers[icoBuffers.length - 1];

  const icoBuffer = await toIco(icoBuffers, { resize: false });
  fs.writeFileSync(icoPath, icoBuffer);
  console.log('Ícone Windows gerado:', icoPath);

  fs.writeFileSync(pngPath, png256);
  console.log('PNG gerado:', pngPath);
}

main().catch((err) => {
  console.error('generate-app-icon erro:', err);
  process.exit(1);
});
