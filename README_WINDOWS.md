Windows Setup — Hub Impressao

This project supports printing on Windows via the Windows spooler using the `printer` native module.

Prerequisites (Windows machine):

1) Install Chocolatey (optional, but convenient)
   - Open an *Administrator* PowerShell and run:
     Set-ExecutionPolicy Bypass -Scope Process -Force; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

2) Install Visual Studio Build Tools (required for compiling native modules)
   - Using Chocolatey (Admin PowerShell):
     choco install visualstudio2022-workload-vctools -y
   - Or download directly from Microsoft: https://visualstudio.microsoft.com/downloads/
   - Make sure you have the "C++ build tools" / "MSVC" components installed.

3) (Optional) Install NSIS (for building installers)
   - choco install nsis -y

4) (Optional) If you want to use `escpos-usb` (direct USB ESC/POS) you may need to replace the printer USB driver with WinUSB via Zadig:
   - Download Zadig: https://zadig.akeo.ie/
   - Select your USB thermal printer and install the `WinUSB` driver.

Install dependencies for the app

- Open an Administrator command prompt (or developer command prompt) and run:

```powershell
# in the project directory
npm ci
```

Notes:
- `printer` is an optional native dependency. If it fails to build on other platforms it's skipped. On Windows, after installing the Build Tools, `npm ci` should compile it.
- If `npm ci` fails for `printer`, try:

```powershell
npm install --global windows-build-tools --vs2015
# or reinstall Visual Studio Build Tools
npm install
```

Quick test script (save as `test-print.js` in project root and run `node test-print.js`):

```javascript
const WindowsPrinterManager = require('./src/main/printer/windows-manager');
const pm = new WindowsPrinterManager();
pm = pm;
pm.refreshPrinters();
console.log('Detected printers:', pm.getPrinters());
(async () => {
  const printers = pm.getPrinters();
  if (!printers || printers.length === 0) return console.error('No printers found.');
  try {
    const name = printers[0].name;
    console.log('Testing print to', name);
    const res = await pm.testPrint(name);
    console.log('Test print result:', res);
  } catch (err) {
    console.error('Test print error:', err);
  }
})();
```

Troubleshooting
- If `printer` fails to compile: ensure the Visual Studio Build Tools are installed and you have restarted your terminal/PC after install. Also ensure Python 3 is available (node-gyp requirement).
- If using `escpos-usb` and no output: ensure Zadig installed `WinUSB` on the device.

If you want, I can add these steps to the main `README.md` instead of a separate file. Let me know.