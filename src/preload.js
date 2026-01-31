const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  testPrinter: (printerName) => ipcRenderer.invoke('test-printer', printerName),
  getWssToken: () => ipcRenderer.invoke('get-wss-token'),
  on: (channel, listener) => ipcRenderer.on(channel, (event, ...args) => listener(...args)),
});

console.log('src/preload: API exposed to renderer');
