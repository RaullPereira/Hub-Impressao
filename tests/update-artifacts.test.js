const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { verifyUpdateArtifacts } = require('../scripts/verify-update-artifacts');

function createFixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-update-artifacts-'));
  const version = options.manifestVersion || '1.9.6';
  const installerName = `Hub-Impressao-Setup-${version}.exe`;
  const installer = Buffer.from('safe-test-installer');
  const sha512 = crypto.createHash('sha512').update(installer).digest('base64');
  fs.writeFileSync(path.join(directory, installerName), installer);
  if (options.withBlockmap !== false) {
    fs.writeFileSync(path.join(directory, `${installerName}.blockmap`), 'blockmap');
  }
  fs.writeFileSync(path.join(directory, 'latest.yml'), [
    `version: ${version}`,
    'files:',
    `  - url: ${installerName}`,
    `    sha512: ${options.sha512 || sha512}`,
    '    size: 19',
    `path: ${installerName}`,
    `sha512: ${options.sha512 || sha512}`,
    'releaseDate: 2026-09-01T00:00:00.000Z',
  ].join('\n'));
  return directory;
}

const valid = createFixture();
assert.deepEqual(verifyUpdateArtifacts(valid, '1.9.6'), {
  version: '1.9.6',
  installer: 'Hub-Impressao-Setup-1.9.6.exe',
  blockmap: 'Hub-Impressao-Setup-1.9.6.exe.blockmap',
  manifest: 'latest.yml',
  sha512Verified: true,
});

assert.throws(
  () => verifyUpdateArtifacts(createFixture({ withBlockmap: false }), '1.9.6'),
  /blockmap/i,
);
assert.throws(
  () => verifyUpdateArtifacts(createFixture({ manifestVersion: '1.9.4' }), '1.9.6'),
  /version/i,
);
assert.throws(
  () => verifyUpdateArtifacts(createFixture({ sha512: 'invalid-hash' }), '1.9.6'),
  /sha-?512/i,
);

console.log('update artifacts: ok');
