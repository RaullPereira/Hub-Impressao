// test-usb-info.js
// Lista dispositivos USB com informações detalhadas
const usb = require('usb');

console.log('Dispositivos USB detalhados:');
usb.getDeviceList().forEach(device => {
  const desc = device.deviceDescriptor;
  console.log('-----------------------------');
  console.log(`VendorId: ${desc.idVendor.toString(16)}`);
  console.log(`ProductId: ${desc.idProduct.toString(16)}`);
  console.log(`Bus: ${device.busNumber}, Address: ${device.deviceAddress}`);
  try {
    device.open();
    const manufacturer = device.getStringDescriptor(desc.iManufacturer, (err, data) => {
      if (!err) console.log('Fabricante:', data);
    });
    const product = device.getStringDescriptor(desc.iProduct, (err, data) => {
      if (!err) console.log('Produto:', data);
    });
    device.close();
  } catch (e) {
    // Pode não conseguir abrir todos os dispositivos
  }
});
