const { exec } = require('child_process');
const { promisify } = require('util');
const execP = promisify(exec);

async function listPrinters() {
  try {
    // Use PowerShell Get-Printer to list printer names (works on Windows 8/10+)
    const { stdout } = await execP('powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"');
    return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (err) {
    // Fallback: try 'wmic printer get name'
    try {
      const { stdout } = await execP('wmic printer get name');
      return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(1);
    } catch (e) {
      return [];
    }
  }
}

async function getDefaultPrinter() {
  try {
    const { stdout } = await execP('powershell -NoProfile -Command "(Get-Printer | Where-Object {$_.Default -eq $true}).Name"');
    const p = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    return p || null;
  } catch (err) {
    return null;
  }
}

async function listPnpDevices() {
  try {
    // Return InstanceId and FriendlyName for present PnP devices
    const { stdout } = await execP('powershell -NoProfile -Command "Get-PnpDevice -PresentOnly | Select-Object InstanceId, FriendlyName | ConvertTo-Json -Compress"');
    const parsed = JSON.parse(stdout);
    // Normalize single-object responses
    if (!Array.isArray(parsed)) return [parsed];
    return parsed;
  } catch (err) {
    return [];
  }
}

async function printFile(printerName, filePath) {
  // Use the built-in print command; it sends a file to the specified printer
  // Note: printerName should match the installed printer display name
  const cmd = `print /D:"${printerName.replace(/"/g, '"')}" "${filePath.replace(/"/g, '"')}"`;
  return execP(cmd);
}

async function getPreferredPrinter() {
  const printers = await listPrinters();
  if (!printers || printers.length === 0) return null;
  const exclude = [
    'onenote',
    'pdf',
    'fax',
    'xps',
    'microsoft print to pdf'
  ];
  // prefer first printer whose name doesn't match exclude list
  for (const p of printers) {
    const lower = p.toLowerCase();
    let bad = false;
    for (const ex of exclude) {
      if (lower.includes(ex)) {
        bad = true;
        break;
      }
    }
    if (!bad) return p;
  }
  // fallback to default if all are excluded
  return printers[0] || null;
}

module.exports = {
  listPrinters,
  getDefaultPrinter,
  getPreferredPrinter,
  listPnpDevices,
  printFile,
  async printRaw(printerName, buffer) {
    // escreve buffer em base64 temporário e chama PowerShell para enviar bytes via WinAPI
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = path.join(os.tmpdir(), `hubimpressao_raw_${Date.now()}.b64`);
    try {
      fs.writeFileSync(tmp, buffer.toString('base64'), { encoding: 'utf8' });
      const ps = `powershell -NoProfile -Command "Add-Type -TypeDefinition @\"using System; using System.Runtime.InteropServices; using System.Text; public class RawPrinterHelper { [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)] public struct DOCINFOA { [MarshalAs(UnmanagedType.LPStr)] public string pDocName; [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPStr)] public string pDataType; } [DllImport(\"winspool.Drv\", EntryPoint=\"OpenPrinterA\", SetLastError=true, CharSet=CharSet.Ansi)] public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd); [DllImport(\"winspool.Drv\", EntryPoint=\"StartDocPrinterA\", SetLastError=true, CharSet=CharSet.Ansi)] public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFOA pDocInfo); [DllImport(\"winspool.Drv\", EntryPoint=\"WritePrinter\", SetLastError=true)] public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten); [DllImport(\"winspool.Drv\", EntryPoint=\"EndDocPrinter\", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr hPrinter); [DllImport(\"winspool.Drv\", EntryPoint=\"ClosePrinter\", SetLastError=true)] public static extern bool ClosePrinter(IntPtr hPrinter); public static bool SendBytesToPrinter(string szPrinterName, byte[] bytes) { IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(bytes.Length); Marshal.Copy(bytes, 0, pUnmanagedBytes, bytes.Length); IntPtr hPrinter; DOCINFOA di = new DOCINFOA(); di.pDocName = \"RAW Document\"; di.pDataType = \"RAW\"; if(!OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) { Marshal.FreeCoTaskMem(pUnmanagedBytes); return false; } if(!StartDocPrinter(hPrinter, 1, ref di)) { ClosePrinter(hPrinter); Marshal.FreeCoTaskMem(pUnmanagedBytes); return false; } int dwWritten = 0; bool bSuccess = WritePrinter(hPrinter, pUnmanagedBytes, bytes.Length, out dwWritten); EndDocPrinter(hPrinter); ClosePrinter(hPrinter); Marshal.FreeCoTaskMem(pUnmanagedBytes); return bSuccess; } }\"; $b = [System.Convert]::FromBase64String((Get-Content -Raw -Encoding UTF8 \"${tmp}\")); [RawPrinterHelper]::SendBytesToPrinter(\"${printerName.replace(/"/g, '\\"')}\", $b)"`;
      const { exec } = require('child_process');
      const execP = require('util').promisify(exec);
      const { stdout, stderr } = await execP(ps);
      // cleanup
      try { fs.unlinkSync(tmp); } catch (e) {}
      if (stderr && stderr.length) throw new Error(stderr);
      return stdout;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (e) {}
      throw err;
    }
  }
};
