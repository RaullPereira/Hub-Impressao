$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$source = @'
using System;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Printing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class HubWindowsSpoolWorker
{
    private static readonly object OutputLock = new object();

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFO
    {
        [MarshalAs(UnmanagedType.LPWStr)]
        public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)]
        public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)]
        public string pDataType;
    }

    private sealed class PrintJob
    {
        public string JobId;
        public string Mode;
        public string Printer;
        public byte[] Bytes;
    }

    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool OpenPrinter(string printerName, out IntPtr printerHandle, IntPtr defaults);

    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr printerHandle);

    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern int StartDocPrinter(IntPtr printerHandle, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO docInfo);

    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr printerHandle);

    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr printerHandle);

    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr printerHandle);

    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr printerHandle, IntPtr bytes, int count, out int written);

    public static void QueuePrint(string jobId, string mode, string printer, byte[] bytes)
    {
        PrintJob job = new PrintJob();
        job.JobId = jobId;
        job.Mode = mode;
        job.Printer = printer;
        job.Bytes = bytes;

        bool queued = ThreadPool.QueueUserWorkItem(new WaitCallback(ProcessJob), job);
        if (!queued)
        {
            WriteError(jobId, "The print job could not be queued");
        }
    }

    public static void WriteError(string jobId, string message)
    {
        string safeMessage = String.IsNullOrEmpty(message) ? "Unknown print error" : message;
        string encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(safeMessage));
        WriteProtocol("ERR\t" + jobId + "\t" + encoded);
    }

    private static void ProcessJob(object state)
    {
        PrintJob job = (PrintJob)state;
        try
        {
            if (job.Mode == "RAW")
            {
                PrintRaw(job.Printer, job.Bytes);
            }
            else if (job.Mode == "TEXT")
            {
                PrintText(job.Printer, job.Bytes);
            }
            else
            {
                throw new InvalidOperationException("Unsupported print mode");
            }

            WriteProtocol("OK\t" + job.JobId);
        }
        catch (Exception error)
        {
            WriteError(job.JobId, error.Message);
        }
    }

    private static void PrintRaw(string printerName, byte[] bytes)
    {
        IntPtr printerHandle = IntPtr.Zero;
        IntPtr unmanagedBytes = IntPtr.Zero;
        bool documentStarted = false;
        bool pageStarted = false;

        try
        {
            if (!OpenPrinter(printerName, out printerHandle, IntPtr.Zero))
            {
                ThrowLastWin32Error("OpenPrinter");
            }

            DOCINFO docInfo = new DOCINFO();
            docInfo.pDocName = "Hub Impressao RAW";
            docInfo.pDataType = "RAW";

            if (StartDocPrinter(printerHandle, 1, docInfo) == 0)
            {
                ThrowLastWin32Error("StartDocPrinter");
            }
            documentStarted = true;

            if (!StartPagePrinter(printerHandle))
            {
                ThrowLastWin32Error("StartPagePrinter");
            }
            pageStarted = true;

            unmanagedBytes = Marshal.AllocCoTaskMem(bytes.Length);
            if (bytes.Length > 0)
            {
                Marshal.Copy(bytes, 0, unmanagedBytes, bytes.Length);
            }

            int written;
            if (!WritePrinter(printerHandle, unmanagedBytes, bytes.Length, out written))
            {
                ThrowLastWin32Error("WritePrinter");
            }
            if (written != bytes.Length)
            {
                throw new IOException("WritePrinter wrote only " + written + " of " + bytes.Length + " bytes");
            }

            if (!EndPagePrinter(printerHandle))
            {
                ThrowLastWin32Error("EndPagePrinter");
            }
            pageStarted = false;

            if (!EndDocPrinter(printerHandle))
            {
                ThrowLastWin32Error("EndDocPrinter");
            }
            documentStarted = false;
        }
        finally
        {
            if (pageStarted && printerHandle != IntPtr.Zero)
            {
                EndPagePrinter(printerHandle);
            }
            if (documentStarted && printerHandle != IntPtr.Zero)
            {
                EndDocPrinter(printerHandle);
            }
            if (printerHandle != IntPtr.Zero)
            {
                ClosePrinter(printerHandle);
            }
            if (unmanagedBytes != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(unmanagedBytes);
            }
        }
    }

    private static void PrintText(string printerName, byte[] bytes)
    {
        string text = Encoding.UTF8.GetString(bytes);
        PrintDocument printDocument = null;
        Font font = null;

        try
        {
            printDocument = new PrintDocument();
            printDocument.PrinterSettings.PrinterName = printerName;
            printDocument.DocumentName = "Hub Impressao";
            printDocument.PrintController = new StandardPrintController();
            if (!printDocument.PrinterSettings.IsValid)
            {
                throw new InvalidOperationException("INVALID_PRINTER");
            }

            font = new Font("Consolas", 9);
            Font printFont = font;
            printDocument.PrintPage += delegate(object sender, PrintPageEventArgs eventArgs)
            {
                eventArgs.Graphics.DrawString(text, printFont, Brushes.Black, eventArgs.MarginBounds);
                eventArgs.HasMorePages = false;
            };
            printDocument.Print();
        }
        finally
        {
            if (font != null)
            {
                font.Dispose();
            }
            if (printDocument != null)
            {
                printDocument.Dispose();
            }
        }
    }

    private static void ThrowLastWin32Error(string operation)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }

    private static void WriteProtocol(string line)
    {
        lock (OutputLock)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies "System.Drawing.dll"

[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()

while (($line = [Console]::In.ReadLine()) -ne $null) {
    $jobId = "0"
    try {
        $fields = $line.Split([char]9)
        if ($fields.Length -ne 4) {
            throw (New-Object System.ArgumentException -ArgumentList "Expected four protocol fields")
        }

        $jobId = $fields[0]
        $mode = $fields[1]
        if ([String]::IsNullOrEmpty($jobId) -or $jobId -notmatch '^[A-Za-z0-9_-]+$') {
            $jobId = "0"
            throw (New-Object System.ArgumentException -ArgumentList "Invalid job ID")
        }
        if ($mode -ne "RAW" -and $mode -ne "TEXT") {
            throw (New-Object System.ArgumentException -ArgumentList "Invalid print mode")
        }

        $printerBytes = [Convert]::FromBase64String($fields[2])
        $payloadBytes = [Convert]::FromBase64String($fields[3])
        $printer = [Text.Encoding]::UTF8.GetString($printerBytes)
        if ([String]::IsNullOrEmpty($printer)) {
            throw (New-Object System.ArgumentException -ArgumentList "Printer name is required")
        }

        [HubWindowsSpoolWorker]::QueuePrint($jobId, $mode, $printer, $payloadBytes)
    }
    catch {
        [HubWindowsSpoolWorker]::WriteError($jobId, $_.Exception.Message)
    }
}
