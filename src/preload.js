const { contextBridge, ipcRenderer, clipboard } = require('electron');


contextBridge.exposeInMainWorld('api', {
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  testPrinter: (printerName) => ipcRenderer.invoke('test-printer', printerName),
  getWssToken: () => ipcRenderer.invoke('get-wss-token'),
  on: (channel, listener) => ipcRenderer.on(channel, (event, ...args) => listener(...args)),
  // Permite acesso ao clipboard para colar
  readClipboard: () => clipboard.readText(),
  writeClipboard: (text) => clipboard.writeText(text),
});

console.log('src/preload: API exposed to renderer');
