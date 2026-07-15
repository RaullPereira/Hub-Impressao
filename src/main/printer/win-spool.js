const { exec } = require('child_process');
const { promisify } = require('util');
const execP = promisify(exec);
const logger = require('../utils/logger');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  WindowsSpoolWorker,
  SpoolWorkerUnavailableError
} = require('./windows-spool-worker');
const COMMAND_TIMEOUT_MS = 12000;
const REGISTRY_TIMEOUT_MS = 6000;
const PRINT_TIMEOUT_MS = 30000;
const persistentWorker = new WindowsSpoolWorker();

// C# Code for RawPrinterHelper
// IMPORTANT: Using double backslashes for JS string escaping where needed, though template literal helps.
const CS_CODE = `
using System;
using System.IO;
using System.Runtime.InteropServices;

public class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPStr)]
        public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)]
        public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)]
        public string pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA pDocInfo);

    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

    public static bool SendFileToPrinter(string szPrinterName, string szFileName)
    {
        byte[] bytes;
        try 
        {
            bytes = File.ReadAllBytes(szFileName);
        }
        catch (Exception)
        {
            return false;
        }

        IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(bytes.Length);
        Marshal.Copy(bytes, 0, pUnmanagedBytes, bytes.Length);

        bool bSuccess = false;
        IntPtr hPrinter = IntPtr.Zero;
        
        try 
        {
            if (OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero))
            {
                DOCINFOA di = new DOCINFOA();
                di.pDocName = "RAW Document";
                di.pDataType = "RAW";

                if (StartDocPrinter(hPrinter, 1, di))
                {
                    if (StartPagePrinter(hPrinter))
                    {
                        int dwWritten = 0;
                        bSuccess = WritePrinter(hPrinter, pUnmanagedBytes, bytes.Length, out dwWritten);
                        EndPagePrinter(hPrinter);
                    }
                    EndDocPrinter(hPrinter);
                }
                ClosePrinter(hPrinter);
            }
        }
        finally
        {
            Marshal.FreeCoTaskMem(pUnmanagedBytes);
        }
        
        return bSuccess;
    }
}
`;

function getTempFilePath(prefix, ext) {
  return path.join(os.tmpdir(), `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`);
}

function execWithTimeout(command, timeout = COMMAND_TIMEOUT_MS) {
  return execP(command, {
    timeout,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 4
  });
}

function isLegacyWindows() {
  if (process.platform !== 'win32') return false;
  const release = os.release();
  return release.startsWith('6.0') || release.startsWith('6.1') || release.startsWith('6.2') || release.startsWith('6.3');
}

function uniqueStrings(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeCommandOutput(output) {
  return String(output || '')
    .replace(/\u0000/g, '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\r\n/g, '\n');
}

function parsePrinterList(stdout) {
  const printers = normalizeCommandOutput(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const valueMatch = line.match(/^(?:name|nome)\s*=\s*(.+)$/i);
      return valueMatch ? valueMatch[1].trim() : line;
    })
    .filter(Boolean)
    .filter((line) => {
      const normalized = line.toLowerCase();
      return normalized !== 'name' && normalized !== 'nome';
    });

  return uniqueStrings(printers);
}

function parseRegistryPrinters(stdout) {
  const printers = normalizeCommandOutput(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^(.+?)\s+REG_\w+\s+(.+)$/i);
      if (!match) return null;

      const printerName = match[1].trim();
      const value = match[2].trim().toLowerCase();
      return value.includes('winspool') ? printerName : null;
    })
    .filter(Boolean);

  return uniqueStrings(printers);
}

function parseRegistryPrinterKeys(stdout) {
  const printers = normalizeCommandOutput(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^HKEY_/i.test(line))
    .map((line) => line.split('\\').pop().trim())
    .filter(Boolean)
    .filter((name) => name.toLowerCase() !== 'printers');

  return uniqueStrings(printers);
}

function parseDefaultPrinterFromRegistry(stdout) {
  const line = normalizeCommandOutput(stdout)
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => /^device\s+REG_\w+\s+/i.test(entry));

  if (!line) return null;

  const match = line.match(/^device\s+REG_\w+\s+(.+)$/i);
  const value = match ? match[1].trim() : '';
  return value ? value.split(',')[0].trim() || null : null;
}

function skipEscPosCommand(bytes, index, commandSet) {
  const command = bytes[index + 1];
  if (command === undefined) return index;

  const oneByteCommands = commandSet === 0x1B
    ? new Set([0x21, 0x2D, 0x33, 0x45, 0x4D, 0x61, 0x64, 0x74])
    : new Set([0x21, 0x42, 0x48, 0x56, 0x68, 0x77]);

  if (oneByteCommands.has(command)) {
    return Math.min(index + 2, bytes.length - 1);
  }

  return index + 1;
}

function bufferToPrintableText(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''), 'latin1');
  let text = '';

  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];

    if (byte === 0x1B || byte === 0x1D) {
      index = skipEscPosCommand(bytes, index, byte);
      continue;
    }

    if (byte === 0x0A || byte === 0x0D || byte === 0x09 || byte >= 0x20) {
      text += String.fromCharCode(byte);
    }
  }

  return text
    .replace(/[ \t]+\r?\n/g, '\r\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trimEnd() + '\r\n';
}

async function listPrintersViaRegistry() {
  const printers = [];

  try {
    const { stdout } = await execWithTimeout(
      'reg query "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Devices"',
      REGISTRY_TIMEOUT_MS
    );
    printers.push(...parseRegistryPrinters(stdout));
  } catch (err) {
    logger.warn('[win-spool] listPrinters - HKCU registry failed: ' + (err && err.message ? err.message : String(err)));
  }

  try {
    const { stdout } = await execWithTimeout(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Print\\Printers"',
      REGISTRY_TIMEOUT_MS
    );
    printers.push(...parseRegistryPrinterKeys(stdout));
  } catch (err) {
    logger.warn('[win-spool] listPrinters - HKLM registry failed: ' + (err && err.message ? err.message : String(err)));
  }

  const uniquePrinters = uniqueStrings(printers);
  logger.info('[win-spool] listPrinters - registry printers=' + uniquePrinters.length);
  return uniquePrinters;
}

async function listPrinters() {
  const legacyWindows = isLegacyWindows();

  if (legacyWindows) {
    logger.info('[win-spool] Windows legado detectado; priorizando Registro do Windows para listar impressoras.');
    const registryPrinters = await listPrintersViaRegistry();
    if (registryPrinters.length > 0) {
      return registryPrinters;
    }
  }

  try {
    if (legacyWindows) {
      throw new Error('LEGACY_WINDOWS_SKIP_POWERSHELL');
    }

    const { stdout } = await execWithTimeout('powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"');
    logger.info('[win-spool] listPrinters - powershell stdout length=' + String((stdout||'').length));
    return parsePrinterList(stdout);
  } catch (err) {
    logger.warn('[win-spool] listPrinters - powershell failed: ' + (err && err.message ? err.message : String(err)));
    try {
      const { stdout } = await execWithTimeout('wmic printer get Name /value');
      logger.info('[win-spool] listPrinters - wmic stdout length=' + String((stdout||'').length));
      return parsePrinterList(stdout);
    } catch (e) {
      logger.warn('[win-spool] listPrinters - wmic failed: ' + (e && e.message ? e.message : String(e)));
      try {
        const { stdout } = await execWithTimeout('powershell -NoProfile -Command "Get-WmiObject Win32_Printer | Select-Object -ExpandProperty Name"');
        logger.info('[win-spool] listPrinters - Get-WmiObject stdout length=' + String((stdout || '').length));
        return parsePrinterList(stdout);
      } catch (fallbackError) {
        logger.error('[win-spool] listPrinters - Get-WmiObject failed: ' + (fallbackError && fallbackError.message ? fallbackError.message : String(fallbackError)));
        return [];
      }
    }
  }
}

async function getDefaultPrinterViaWmic() {
  try {
    const { stdout } = await execWithTimeout('wmic printer where default=true get Name /value');
    logger.info('[win-spool] getDefaultPrinter - stdout length=' + String((stdout||'').length));
    const p = parsePrinterList(stdout)[0];
    return p || null;
  } catch (err) {
    logger.warn('[win-spool] getDefaultPrinterViaWmic failed: ' + (err && err.message ? err.message : String(err)));
    return null;
  }
}

async function getDefaultPrinterViaRegistry() {
  try {
    const { stdout } = await execWithTimeout(
      'reg query "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows" /v Device',
      REGISTRY_TIMEOUT_MS
    );
    const printer = parseDefaultPrinterFromRegistry(stdout);
    logger.info('[win-spool] getDefaultPrinter - registry=' + (printer || 'nenhuma'));
    return printer || null;
  } catch (err) {
    logger.warn('[win-spool] getDefaultPrinterViaRegistry failed: ' + (err && err.message ? err.message : String(err)));
    return null;
  }
}

async function getDefaultPrinter() {
  if (isLegacyWindows()) {
    return (await getDefaultPrinterViaRegistry()) || getDefaultPrinterViaWmic();
  }

  try {
    const { stdout } = await execWithTimeout('powershell -NoProfile -Command "(Get-Printer | Where-Object {$_.Default -eq $true}).Name"');
    logger.info('[win-spool] getDefaultPrinter - stdout length=' + String((stdout||'').length));
    const p = parsePrinterList(stdout)[0];
    return p || null;
  } catch (err) {
    logger.warn('[win-spool] getDefaultPrinter failed: ' + (err && err.message ? err.message : String(err)));
    return getDefaultPrinterViaWmic();
  }
}

async function listPnpDevices() {
  try {
    const command = isLegacyWindows()
      ? 'powershell -NoProfile -Command "Get-WmiObject Win32_PnPEntity | Select-Object PNPDeviceID, Name | ConvertTo-Json -Compress"'
      : 'powershell -NoProfile -Command "Get-PnpDevice -PresentOnly | Select-Object InstanceId, FriendlyName | ConvertTo-Json -Compress"';
    const { stdout } = await execWithTimeout(command);
    let parsed;
    try { parsed = JSON.parse(stdout); } catch (e) { return []; }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map((entry) => ({
      instanceId: entry?.InstanceId || entry?.PNPDeviceID || '',
      friendlyName: entry?.FriendlyName || entry?.Name || ''
    }));
  } catch (err) {
    return [];
  }
}

async function printFile(printerName, filePath) {
  const cmd = `print /D:"${printerName.replace(/"/g, '"')}" "${filePath.replace(/"/g, '"')}"`;
  return execWithTimeout(cmd, 15000);
}

async function printTextOneShot(printerName, text) {
  const printerFile = getTempFilePath('hub_printer_name', 'txt');
  const textFile = getTempFilePath('hub_print_text', 'txt');
  const psFile = getTempFilePath('hub_text_print_script', 'ps1');

  fs.writeFileSync(printerFile, String(printerName || ''), { encoding: 'utf8' });
  fs.writeFileSync(textFile, String(text || ''), { encoding: 'utf8' });

  const safePrinterFile = printerFile.replace(/\\/g, '\\\\');
  const safeTextFile = textFile.replace(/\\/g, '\\\\');

  const psCommand = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$printerName = [System.IO.File]::ReadAllText("${safePrinterFile}", [System.Text.Encoding]::UTF8).Trim()
$script:hubPrintText = [System.IO.File]::ReadAllText("${safeTextFile}", [System.Text.Encoding]::UTF8)

$printDoc = New-Object System.Drawing.Printing.PrintDocument
$printDoc.PrinterSettings.PrinterName = $printerName
$printDoc.DocumentName = "Hub Impressao"
$printDoc.PrintController = New-Object System.Drawing.Printing.StandardPrintController

if (-not $printDoc.PrinterSettings.IsValid) {
    Write-Error "INVALID_PRINTER"
    exit 2
}

$script:hubFont = New-Object System.Drawing.Font("Consolas", 9)
$printDoc.add_PrintPage({
    param($sender, $eventArgs)
    $eventArgs.Graphics.DrawString($script:hubPrintText, $script:hubFont, [System.Drawing.Brushes]::Black, $eventArgs.MarginBounds)
    $eventArgs.HasMorePages = $false
})

$printDoc.Print()
Write-Output "SUCCESS"
`;

  fs.writeFileSync(psFile, psCommand, { encoding: 'utf8' });

  try {
    const { stdout, stderr } = await execWithTimeout(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, PRINT_TIMEOUT_MS);
    if (stdout.includes('SUCCESS')) {
      return true;
    }

    throw new Error(stderr || stdout || 'Text printing finished without success marker');
  } finally {
    try { fs.unlinkSync(printerFile); } catch (_) { }
    try { fs.unlinkSync(textFile); } catch (_) { }
    try { fs.unlinkSync(psFile); } catch (_) { }
  }
}

async function getPreferredPrinter() {
  const printers = await listPrinters();
  if (!printers || printers.length === 0) return null;
  const exclude = ['onenote', 'pdf', 'fax', 'xps', 'microsoft print to pdf'];
  for (const p of printers) {
    const lower = p.toLowerCase();
    if (!exclude.some(ex => lower.includes(ex))) return p;
  }
  return printers[0] || null;
}

async function printRawOneShot(printerName, buffer) {
  const csFile = path.join(os.tmpdir(), 'HubImpressao_RawHelper.cs');
  try {
    fs.writeFileSync(csFile, CS_CODE, { encoding: 'utf8' });
  } catch (e) {
    console.warn('Warning writing CS file:', e);
  }

  const dataFile = getTempFilePath('hub_raw_data', 'bin');
  fs.writeFileSync(dataFile, buffer);

  // Use a cleaner path for PS
  // IMPORTANT: Double escape backslashes for PowerShell double-quoted string interpolation
  const safeCsPath = csFile.replace(/\\/g, '\\\\');
  const safeDataPath = dataFile.replace(/\\/g, '\\\\');
  const safePrinterName = printerName.replace(/"/g, '\\"');

  const psCommand = `
try {
    $source = [System.IO.File]::ReadAllText("${safeCsPath}")
    Add-Type -TypeDefinition $source -Language CSharp
} catch {
    # Ignore if type already exists
}

$res = [RawPrinterHelper]::SendFileToPrinter("${safePrinterName}", "${safeDataPath}")
if ($res) { 
    Write-Output "SUCCESS" 
} else { 
    Write-Error "FAILED_TO_SEND" 
}
`;

  const psFile = getTempFilePath('hub_print_script', 'ps1');
  fs.writeFileSync(psFile, psCommand, { encoding: 'utf8' });

  try {
    const { stdout, stderr } = await execWithTimeout(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, PRINT_TIMEOUT_MS);

    // Check for success marker first
    if (stdout.includes('SUCCESS')) {
      return true;
    }

    if (stderr || stdout.includes('FAILED_TO_SEND')) {
      const errorMsg = stderr || 'Printer signaled failure';
      throw new Error('Raw printing failed: ' + errorMsg);
    }

    // If no output but no error? Assume success? No, better safe.
    throw new Error('No successful output from printing script. STDOUT: ' + stdout);

  } catch (err) {
    throw err;
  } finally {
    try { fs.unlinkSync(dataFile); } catch (_) { }
    try { fs.unlinkSync(psFile); } catch (_) { }
  }
}

async function printRaw(printerName, buffer) {
  try {
    return await persistentWorker.printRaw(printerName, buffer);
  } catch (error) {
    if (!(error instanceof SpoolWorkerUnavailableError)) throw error;
    return printRawOneShot(printerName, buffer);
  }
}

async function printText(printerName, text) {
  try {
    return await persistentWorker.printText(printerName, text);
  } catch (error) {
    if (!(error instanceof SpoolWorkerUnavailableError)) throw error;
    return printTextOneShot(printerName, text);
  }
}

function stopPersistentWorker() {
  return persistentWorker.stop();
}

module.exports = {
  listPrinters,
  getDefaultPrinter,
  getPreferredPrinter,
  listPnpDevices,
  printFile,
  printRaw,
  printText,
  stopPersistentWorker,
  bufferToPrintableText,
  __private: {
    parsePrinterList,
    parseRegistryPrinters,
    parseRegistryPrinterKeys,
    parseDefaultPrinterFromRegistry,
    bufferToPrintableText
  }
};
