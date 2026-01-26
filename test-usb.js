// test-usb.js
// Lista todos os dispositivos USB detectados pelo libusb
const usb = require('usb');

console.log('Dispositivos USB detectados:');
usb.getDeviceList().forEach(device => {
  const desc = device.deviceDescriptor;
  console.log(`VendorId: ${desc.idVendor.toString(16)}, ProductId: ${desc.idProduct.toString(16)}`);
});
