'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function readScalar(source, name) {
  const match = source.match(new RegExp(`^${name}:\\s*["']?([^\\s"']+)["']?\\s*$`, 'm'));
  return match ? match[1] : null;
}

function readInstallerUrl(source) {
  const pathValue = readScalar(source, 'path');
  if (pathValue) return pathValue;
  const match = source.match(/^\s*-\s+url:\s*["']?([^\s"']+)["']?\s*$/m);
  return match ? match[1] : null;
}

function fileSha512(filePath) {
  return crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64');
}

function verifyUpdateArtifacts(directory, expectedVersion) {
  const artifactDirectory = path.resolve(directory);
  const manifestPath = path.join(artifactDirectory, 'latest.yml');
  if (!fs.existsSync(manifestPath)) throw new Error('latest.yml manifest is missing');

  const manifest = fs.readFileSync(manifestPath, 'utf8');
  const manifestVersion = readScalar(manifest, 'version');
  if (manifestVersion !== expectedVersion) {
    throw new Error(`Manifest version ${manifestVersion || 'missing'} does not match ${expectedVersion}`);
  }

  const expectedInstaller = `Hub-Impressao-Setup-${expectedVersion}.exe`;
  const installerFromManifest = path.basename(readInstallerUrl(manifest) || '');
  if (installerFromManifest !== expectedInstaller) {
    throw new Error(`Manifest installer ${installerFromManifest || 'missing'} does not match ${expectedInstaller}`);
  }

  const installerPath = path.join(artifactDirectory, expectedInstaller);
  const blockmapName = `${expectedInstaller}.blockmap`;
  const blockmapPath = path.join(artifactDirectory, blockmapName);
  if (!fs.existsSync(installerPath)) throw new Error(`Installer is missing: ${expectedInstaller}`);
  if (!fs.existsSync(blockmapPath)) throw new Error(`Blockmap is missing: ${blockmapName}`);

  const expectedSha512 = readScalar(manifest, 'sha512');
  if (!expectedSha512 || fileSha512(installerPath) !== expectedSha512) {
    throw new Error('Installer SHA-512 does not match latest.yml');
  }

  return {
    version: expectedVersion,
    installer: expectedInstaller,
    blockmap: blockmapName,
    manifest: 'latest.yml',
    sha512Verified: true,
  };
}

if (require.main === module) {
  const directory = process.argv[2] || path.join(process.cwd(), 'dist');
  const expectedVersion = process.argv[3] || require('../package.json').version;
  try {
    const result = verifyUpdateArtifacts(directory, expectedVersion);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { verifyUpdateArtifacts };
