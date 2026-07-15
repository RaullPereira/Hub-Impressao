class PrinterDispatchQueue {
  constructor() {
    this.tails = new Map();
  }

  static normalizePrinterKey(printerId) {
    return printerId == null
      ? ''
      : String(printerId).trim().toLowerCase();
  }

  enqueue(printerId, task) {
    const printerKey = PrinterDispatchQueue.normalizePrinterKey(printerId);
    if (!printerKey) {
      return Promise.reject(new Error('printerId is required for queued printing'));
    }
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('Queued printer task must be a function'));
    }

    const previousTail = this.tails.get(printerKey) || Promise.resolve();
    const execution = previousTail
      .catch(() => undefined)
      .then(() => task());

    let currentTail;
    currentTail = execution.finally(() => {
      if (this.tails.get(printerKey) === currentTail) {
        this.tails.delete(printerKey);
      }
    });

    this.tails.set(printerKey, currentTail);
    return currentTail;
  }
}

module.exports = PrinterDispatchQueue;
