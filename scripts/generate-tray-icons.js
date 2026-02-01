const fs = require('fs');
const path = require('path');

// Tiny transparent PNG (1x1) base64 — used as safe placeholder/template
const PNG_1x_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
const PNG_2x_BASE64 = PNG_1x_BASE64; // same placeholder for @2x

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeIfMissing(filePath, base64) {
  if (fs.existsSync(filePath)) return false;
  try {
    const buf = Buffer.from(base64, 'base64');
    fs.writeFileSync(filePath, buf);
    return true;
  } catch (e) {
    // ignore
    return false;
  }
}

function main() {
  const base = path.join(__dirname, '..', 'assets', 'icons');
  ensureDir(base);

  const created = [];
  const p1 = path.join(base, 'trayTemplate.png');
  const p2 = path.join(base, 'trayTemplate@2x.png');
  const p3 = path.join(base, 'tray.png');

  if (writeIfMissing(p1, PNG_1x_BASE64)) created.push(p1);
  if (writeIfMissing(p2, PNG_2x_BASE64)) created.push(p2);
  if (writeIfMissing(p3, PNG_1x_BASE64)) created.push(p3);

  if (created.length) {
    console.log('generate-tray-icons: created', created);
  }
}

if (require.main === module) main();

module.exports = { main };
