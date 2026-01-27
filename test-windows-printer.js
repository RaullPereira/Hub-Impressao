const printer = require('printer');

// Lista todas as impressoras instaladas no Windows
console.log('Impressoras instaladas:', printer.getPrinters());

// Exemplo de impressão de texto simples
const texto = 'Teste de impressão via spooler do Windows';
const impressoraPadrao = printer.getDefaultPrinterName();

printer.printDirect({
  data: texto,
  printer: impressoraPadrao, // ou o nome da impressora térmica
  type: 'RAW',
  success: function(jobID) {
    console.log('Impressão enviada! JobID:', jobID);
  },
  error: function(err) {
    console.error('Erro ao imprimir:', err);
  }
});
