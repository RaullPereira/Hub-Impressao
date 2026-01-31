const { exec } = require('child_process');
const { promisify } = require('util');
const execP = promisify(exec);
const logger = require('../utils/logger');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

async function listPrinters() {
  try {
    const { stdout } = await execP('powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"');
    logger.info('[win-spool] listPrinters - powershell stdout length=' + String((stdout||'').length));
    return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (err) {
    logger.warn('[win-spool] listPrinters - powershell failed: ' + (err && err.message ? err.message : String(err)));
    try {
      const { stdout } = await execP('wmic printer get name');
      logger.info('[win-spool] listPrinters - wmic stdout length=' + String((stdout||'').length));
      return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(1);
    } catch (e) {
      logger.error('[win-spool] listPrinters - wmic failed: ' + (e && e.message ? e.message : String(e)));
      return [];
    }
  }
}

async function getDefaultPrinter() {
  try {
    const { stdout } = await execP('powershell -NoProfile -Command "(Get-Printer | Where-Object {$_.Default -eq $true}).Name"');
    logger.info('[win-spool] getDefaultPrinter - stdout length=' + String((stdout||'').length));
    const p = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    return p || null;
  } catch (err) {
    logger.warn('[win-spool] getDefaultPrinter failed: ' + (err && err.message ? err.message : String(err)));
    return null;
  }
}

async function listPnpDevices() {
  try {
    const { stdout } = await execP('powershell -NoProfile -Command "Get-PnpDevice -PresentOnly | Select-Object InstanceId, FriendlyName | ConvertTo-Json -Compress"');
    let parsed;
    try { parsed = JSON.parse(stdout); } catch (e) { return []; }
    if (!Array.isArray(parsed)) return [parsed];
    return parsed;
  } catch (err) {
    return [];
  }
}

async function printFile(printerName, filePath) {
  const cmd = `print /D:"${printerName.replace(/"/g, '"')}" "${filePath.replace(/"/g, '"')}"`;
  return execP(cmd);
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

async function printRaw(printerName, buffer) {
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
    Add-Type -TypeDefinition (Get-Content -Path "${safeCsPath}" -Raw) -Language CSharp
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
    const { stdout, stderr } = await execP(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`);

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

module.exports = {
  listPrinters,
  getDefaultPrinter,
  getPreferredPrinter,
  listPnpDevices,
  printFile,
  printRaw
};
