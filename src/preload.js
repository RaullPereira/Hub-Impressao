const { contextBridge, ipcRenderer, clipboard } = require('electron');


contextBridge.exposeInMainWorld('api', {
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  testPrinter: (printerName) => ipcRenderer.invoke('test-printer', printerName),
  getLogs: (options) => ipcRenderer.invoke('get-logs', options),
  getPairingStatus: () => ipcRenderer.invoke('get-pairing-status'),
  getAutoPrintAttention: () => ipcRenderer.invoke('get-auto-print-attention'),
  resolveAutoPrintIntent: (intentId, action) =>
    ipcRenderer.invoke('resolve-auto-print-intent', { intentId, action }),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  manualPrint: (payload) => ipcRenderer.invoke('manual-print', payload),
  addManualPrinter: (payload) => ipcRenderer.invoke('add-manual-printer', payload),
  getWssToken: () => ipcRenderer.invoke('get-wss-token'),
  on: (channel, listener) => ipcRenderer.on(channel, (event, ...args) => listener(...args)),
  // Permite acesso ao clipboard para colar
  readClipboard: () => clipboard.readText(),
  writeClipboard: (text) => clipboard.writeText(text),
});

console.log('src/preload: API exposed to renderer');
