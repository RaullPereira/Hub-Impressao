const { generateOrderPrintData } = require('./src/main/printer/escpos-formatter');

const orderData = {
  order_number: "001",
  customer_name: "Joao Silva",
  items: [
    {
      quantity: 2,
      product_name: "Pizza Margherita",
      total_price: 70.00
    }
  ],
  total: 70.00
};

const commands = generateOrderPrintData(orderData, 'counter');
console.log('Número de comandos:', commands.length);
console.log('Primeiro comando:', commands[0]);
console.log('Último comando:', commands[commands.length - 1]);

// Salvar para testar diretamente
const fs = require('fs');
const buffer = Buffer.from(commands.join(''), 'binary');
fs.writeFileSync('/tmp/test-order.prn', buffer);
console.log('\nArquivo salvo em /tmp/test-order.prn');
console.log('Tamanho:', buffer.length, 'bytes');
