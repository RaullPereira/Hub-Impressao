param([string]$printerName = 'EPSON20')

# Mensagem de teste + comando de corte ESC/POS (GS V 0)
$txt = "TESTE RAW DO POWERSHELL`r`n"
$cut = [byte[]](0x1D,0x56,0x00)
$bytes = [System.Text.Encoding]::ASCII.GetBytes($txt) + $cut

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public struct DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFOA pDocInfo);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  public static bool SendBytesToPrinter(string szPrinterName, byte[] bytes) {
    IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(bytes.Length);
    Marshal.Copy(bytes, 0, pUnmanagedBytes, bytes.Length);
    IntPtr hPrinter;
    DOCINFOA di = new DOCINFOA();
    di.pDocName = "RAW Document";
    di.pDataType = "RAW";
    if(!OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) {
      Marshal.FreeCoTaskMem(pUnmanagedBytes);
      return false;
    }
    if(!StartDocPrinter(hPrinter, 1, ref di)) {
      ClosePrinter(hPrinter);
      Marshal.FreeCoTaskMem(pUnmanagedBytes);
      return false;
    }
    int dwWritten = 0;
    bool bSuccess = WritePrinter(hPrinter, pUnmanagedBytes, bytes.Length, out dwWritten);
    EndDocPrinter(hPrinter);
    ClosePrinter(hPrinter);
    Marshal.FreeCoTaskMem(pUnmanagedBytes);
    return bSuccess;
  }
}
"@

$result = [RawPrinterHelper]::SendBytesToPrinter($printerName, $bytes)
Write-Host "Resultado do envio RAW: $result"
if (-not $result) { Write-Host "Erro ao enviar RAW. Verifique driver/porta e privilégios." -ForegroundColor Red }
