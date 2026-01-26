const escpos = require('escpos');
const USB = require('escpos-usb');

console.log('Buscando impressoras USB...');
const devices = USB.findPrinter();
console.log(`Encontradas ${devices.length} impressoras`);

if (devices.length === 0) {
  console.log('Nenhuma impressora encontrada!');
  process.exit(1);
}

const device = new USB(devices[0]);

console.log('Abrindo impressora...');
device.open(function(error) {
  if (error) {
    console.error('Erro ao abrir:', error);
    process.exit(1);
  }

  console.log('Impressora aberta! Imprimindo...');
  const printer = new escpos.Printer(device);

  printer
    .font('a')
    .align('ct')
    .style('bu')
    .size(2, 2)
    .text('TESTE DIRETO')
    .size(1, 1)
    .text('Funcionou!')
    .feed(3)
    .cut()
    .close(function() {
      console.log('Impressão concluída!');
      process.exit(0);
    });
});
