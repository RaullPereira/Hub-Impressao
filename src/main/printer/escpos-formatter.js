const CMD = {
  RESET: '\x1B@',
  FONT_A: '\x1BM\x00',
  TXT_NORMAL: '\x1D\x21\x00',
  TXT_DOUBLE_H: '\x1D\x21\x10',
  TXT_DOUBLE_W: '\x1D\x21\x20',
  TXT_BIG: '\x1D\x21\x11',
  ALIGN_LEFT: '\x1Ba\x00',
  ALIGN_CENTER: '\x1Ba\x01',
  ALIGN_RIGHT: '\x1Ba\x02',
  BOLD_ON: '\x1BE\x01',
  BOLD_OFF: '\x1BE\x00',
  INVERSE_ON: '\x1DB\x01',
  INVERSE_OFF: '\x1DB\x00',
  CUT_FULL: '\x1DV\x41\x00'
};

function normalizeText(text) {
  if (!text) return '';
  const map = {
    'á': 'a', 'à': 'a', 'ã': 'a', 'â': 'a',
    'é': 'e', 'è': 'e', 'ê': 'e',
    'í': 'i', 'ì': 'i', 'î': 'i',
    'ó': 'o', 'ò': 'o', 'õ': 'o', 'ô': 'o',
    'ú': 'u', 'ù': 'u', 'û': 'u',
    'Á': 'A', 'À': 'A', 'Ã': 'A', 'Â': 'A',
    'É': 'E', 'È': 'E', 'Ê': 'E',
    'Í': 'I', 'Ì': 'I', 'Î': 'I',
    'Ó': 'O', 'Ò': 'O', 'Õ': 'O', 'Ô': 'O',
    'Ú': 'U', 'Ù': 'U', 'Û': 'U'
  };
  return text.split('').map(c => map[c] || c).join('');
}

function generateOrderPrintData(order, printType = 'counter') {
  const data = [];
  data.push(CMD.RESET);
  data.push(CMD.ALIGN_CENTER);
  data.push(CMD.TXT_BIG);
  data.push(CMD.BOLD_ON);
  
  const orderNum = String(order.order_number || order.orderNumber || order.id || '0').padStart(3, '0');
  data.push(`PEDIDO #${orderNum}\n`);
  data.push(CMD.BOLD_OFF);
  data.push(CMD.TXT_NORMAL);
  data.push('\n');
  
  data.push(CMD.ALIGN_LEFT);
  const customerName = normalizeText(order.customer_name || order.customerName || 'Cliente');
  data.push(`CLIENTE: ${customerName}\n`);
  
  const items = order.items || [];
  data.push('\n');
  data.push('ITENS:\n');
  data.push('================================\n');
  
  items.forEach(item => {
    const qty = item.quantity || 1;
    const name = normalizeText(item.product_name || item.name || 'Item');
    const price = (item.total_price || item.price || 0).toFixed(2);
    data.push(`${qty}x ${name}\n`);
    if (printType !== 'kitchen') {
      data.push(`   R$ ${price}\n`);
    }
    if (item.observations) {
      data.push(`   OBS: ${normalizeText(item.observations)}\n`);
    }
    data.push('--------------------------------\n');
  });
  
  if (printType !== 'kitchen') {
    data.push('\n');
    data.push(CMD.ALIGN_CENTER);
    data.push(CMD.TXT_BIG);
    data.push(CMD.INVERSE_ON);
    const total = (order.total || 0).toFixed(2).replace('.', ',');
    data.push(` TOTAL: R$ ${total} \n`);
    data.push(CMD.INVERSE_OFF);
    data.push(CMD.TXT_NORMAL);
  }
  
  data.push('\n\n\n');
  data.push(CMD.CUT_FULL);
  
  return data;
}

module.exports = { generateOrderPrintData, CMD, normalizeText };
