const { execSync } = require('child_process');
const os = require('os');
const platform = process.platform;

console.log(`postinstall: detected platform ${platform}`);

// On non-Windows platforms, remove optional dependencies to avoid native build failures
if (platform !== 'win32') {
  try {
    console.log('postinstall: pruning optionalDependencies (non-Windows platform)');
    // Use npm prune to remove optional deps (no-optional)
    execSync('npm prune --no-optional', { stdio: 'inherit' });
  } catch (err) {
    console.warn('postinstall: npm prune failed:', err && err.message ? err.message : err);
  }
} else {
  console.log('postinstall: Windows detected, leaving optional dependencies (printer) installed');
}
