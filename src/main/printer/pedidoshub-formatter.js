const CMD = {
  ESC: '\x1B',
  GS: '\x1D',
  RESET: '\x1B@',
  FONT_A: '\x1BM\x00',
  FONT_B: '\x1BM\x01',
  TXT_NORMAL: '\x1D\x21\x00',
  TXT_DOUBLE_H: '\x1D\x21\x10',
  TXT_DOUBLE_W: '\x1D\x21\x20',
  TXT_BIG: '\x1D\x21\x11',
  ALIGN_LEFT: '\x1Ba\x00',
  ALIGN_CENTER: '\x1Ba\x01',
  ALIGN_RIGHT: '\x1Ba\x02',
  medium_ON: '\x1BE\x01',
  medium_OFF: '\x1BE\x00',
  INVERSE_ON: '\x1D\x42\x01',
  INVERSE_OFF: '\x1D\x42\x00',
  LINE_SPACING_TIGHT_58MM: '\x1B\x33\x0E',
  CUT_FULL: '\x1DV\x41\x00'
};

const DEFAULT_PRINT_SETTINGS = {
  paperWidth: 48,
  marginLeft: 0,
  marginRight: 0,
  lineSpacing: 'normal',
  fontSize: 'normal',
  mediumTitle: true,
  mediumItems: false,
  showStoreName: true,
  storeName: '',
  showStorePhone: '',
  showDateTime: true,
  showItemPrice: true,
  showItemQuantity: true,
  showItemNotes: true,
  groupByCategory: true,
  showTotal: true,
  showPaymentMethod: true,
  showDeliveryInfo: true,
  customFooter: '',
  autoCut: true,
  feedLines: 3,
  separatorChar: '-',
  showCustomerInfo: true,
  showOrderNotes: true,
  showOperator: true,
  logoBase64: '',
  autoPrintEnabled: false,
  autoPrintType: 'counter',
  autoPrintOnAcceptEnabled: false,
  kdsReadyPrintEnabled: false,
  kdsReadyPrintRoutes: [],
  highlightBeverages: true
};

function getNormalizedSettings(printSettings) {
  return Object.assign({}, DEFAULT_PRINT_SETTINGS, printSettings || {});
}

function getPrinterCols(settings) {
  return settings.paperWidth - settings.marginLeft - settings.marginRight;
}

function padPair(settings, left, right) {
  const cols = getPrinterCols(settings);
  const leftClean = left || '';
  const rightClean = right || '';
  const spaces = cols - (leftClean.length + rightClean.length);

  if (spaces > 0) {
    return leftClean + ' '.repeat(spaces) + rightClean + '\n';
  }

  return leftClean + '\n' + rightClean.padStart(cols, ' ') + '\n';
}

function normalizeText(text) {
  if (!text) return '';
  const str = String(text);

  let replaced = str
    .replace(/🏷️/g, '[PROMO]')
    .replace(/🚗/g, '[MOTO]')
    .replace(/🍽️/g, '[MESA]')
    .replace(/🏪/g, '[BALCAO]');

  return replaced
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E\n\r]/g, '')
    .trim();
}

function getComboChoiceLines(item) {
  const children = Array.isArray(item?.comboItems) ? item.comboItems
    : Array.isArray(item?.combo_items) ? item.combo_items
      : Array.isArray(item?.subItems) ? item.subItems : [];

  return children.map((child) => {
    if (!child) return '';
    const flavors = Array.isArray(child.flavors)
      ? child.flavors.map((flavor) => normalizeText(typeof flavor === 'string' ? flavor : flavor?.name)).filter(Boolean)
      : [];
    const name = flavors.length ? flavors.join(' / ') : normalizeText(child.name || child.product_name);
    if (!name) return '';
    const quantity = Number(child.quantity) > 1 ? `${Number(child.quantity)}x ` : '';
    const size = normalizeText(child.sizeLabel || child.sizeId || '');
    const border = normalizeText(child.stuffedCrustFlavor || '');
    const notes = normalizeText(child.notes || '');
    return `${quantity}${name}${size ? ` (${size})` : ''}${border ? ` - borda ${border}` : ''}${notes ? ` - obs: ${notes}` : ''}`;
  }).filter(Boolean);
}

// Mapeia codigos tecnicos de forma de pagamento para rotulos legiveis.
// O formatter imprime o valor cru em maiusculas; sem este mapa, codigos como
// "employee_advance" sairiam como "EMPLOYEE_ADVANCE" na comanda.
const PAYMENT_METHOD_PRINT_LABELS = {
  'employee_advance': 'Vale de funcionario',
  'employee advance': 'Vale de funcionario',
  'vale_funcionario': 'Vale de funcionario',
  'vale de funcionario': 'Vale de funcionario',
  'voucher': 'Vale',
  'vale': 'Vale',
  'pix_online': 'PIX Online',
  'mp_pix': 'PIX Online',
  'paggpix_pix': 'PIX Online',
  'credit_card': 'Cartao de Credito',
  'debit_card': 'Cartao de Debito',
  'money': 'Dinheiro',
  'cash': 'Dinheiro',
  'transfer': 'Transferencia',
};

function mapPaymentMethodPrintLabel(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return raw;
  const key = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return PAYMENT_METHOD_PRINT_LABELS[key] || raw;
}

function getParsedPaymentSplits(order) {
  const rawSplits = order?.payment_split || order?.paymentSplit || [];
  const splits = Array.isArray(rawSplits)
    ? rawSplits
    : (() => {
        try {
          return typeof rawSplits === 'string' ? (JSON.parse(rawSplits) || []) : [];
        } catch {
          return [];
        }
      })();

  return splits.filter((entry) => {
    const name = entry?.method_name?.trim?.() || entry?.methodName?.trim?.() || entry?.method_id || '';
    return name && Number(entry?.amount) > 0;
  });
}

function generateLogoESCPOS(logoJson) {
  if (!logoJson) return [];

  try {
    const payload = JSON.parse(logoJson);
    const width = Number(payload?.width) || 0;
    const height = Number(payload?.height) || 0;
    const data = String(payload?.data || '');
    if (!width || !height || !data) return [];

    const bitmap = Buffer.from(data, 'base64');
    const bytesPerRow = width / 8;
    const xL = bytesPerRow & 0xFF;
    const xH = (bytesPerRow >> 8) & 0xFF;
    const yL = height & 0xFF;
    const yH = (height >> 8) & 0xFF;

    let command = '\x1D\x76\x30\x00';
    command += String.fromCharCode(xL, xH, yL, yH);

    for (let i = 0; i < bitmap.length; i++) {
      command += String.fromCharCode(bitmap[i]);
    }

    return [CMD.ALIGN_CENTER, command, '\n'];
  } catch {
    return [];
  }
}

function generateKitchenPrintData(order, printSettings) {
  const settings = getNormalizedSettings(printSettings);
  const data = [];
  const cols = getPrinterCols(settings);
  const separatorFine = '-'.repeat(cols) + '\n';
  const isIfood = order.origin === 'ifood' || order.order_origin === 'ifood' || order.source === 'ifood';
  const cd = order.customData || order.custom_data;
  const looksLikeTechnicalId = (value) => /^[a-z]{1,4}_|^\d{10,}$|_[0-9a-f]{8,}$/i.test(value || '');

  data.push(CMD.RESET);
  // 58mm (<=32 col) ou config compact: espacamento de linha justo (ESC 3 14) para a comanda nao sair espacada nem grudada.
  if ((settings.paperWidth || 48) <= 32 || settings.lineSpacing === "compact") data.push(CMD.LINE_SPACING_TIGHT_58MM);
  data.push(CMD.FONT_A);

  const orderNum = String(order.order_number || order.orderNumber || order.id || '0').padStart(3, '0');
  const displayId = isIfood ? (cd?.displayId || order.displayId || order.display_id || orderNum) : orderNum;
  const orderType = order.order_type || order.orderType;
  const customerName = normalizeText(order.customer_name || order.customerName || 'Cliente');
  const scheduledAt = order.scheduled_at || order.scheduledAt;

  let typeLabel = 'RETIRADA';
  if (orderType === 'delivery') typeLabel = scheduledAt ? 'ENTREGA AGENDADA' : 'ENTREGA';
  else if (orderType === 'mesa') typeLabel = `MESA ${order.table_number || order.tableNumber || ''}`.trim();
  else if (scheduledAt) typeLabel = 'RETIRADA AGENDADA';

  data.push(CMD.ALIGN_CENTER);
  data.push(CMD.TXT_BIG);
  if (isIfood) {
    data.push(` iFood #${displayId} \n`);
  } else {
    data.push(` #${displayId} ${typeLabel} \n`);
  }
  data.push(CMD.medium_ON);
  data.push(CMD.TXT_NORMAL);
  data.push(CMD.medium_OFF);
  data.push(separatorFine);

  data.push(CMD.ALIGN_LEFT);
  const created = new Date(order.created_at || order.createdAt || Date.now());
  const orderHour = created.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  data.push(CMD.medium_ON);
  data.push(`HORA: ${orderHour}`);

  const deliveryTimeStr = cd?.expectedDeliveryTime;
  if (deliveryTimeStr) {
    const deliveryTime = new Date(deliveryTimeStr);
    const deliveryHour = deliveryTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    data.push(`  ENTREGAR: ${deliveryHour}`);
  }
  data.push('\n');
  data.push(`CLIENTE: ${customerName}\n`);

  if (orderType === 'mesa' && (order.waiter_name || order.waiterName)) {
    data.push(`GARCOM: ${normalizeText(order.waiter_name || order.waiterName)}\n`);
  }

  if (scheduledAt) {
    const scheduleDate = new Date(scheduledAt);
    if (!Number.isNaN(scheduleDate.getTime())) {
      const scheduleLabel = `${scheduleDate.toLocaleDateString('pt-BR')} as ${scheduleDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
      data.push(`AGENDADO: ${scheduleLabel}\n`);
    }
  }
  data.push(CMD.medium_OFF);
  data.push(separatorFine);
  data.push(CMD.ALIGN_LEFT);

  const beverageCategories = ['refrigerantes', 'bebidas', 'sucos', 'vitaminas', 'drinks', 'agua', 'aguas', 'cervejas', 'vinhos', 'chopp', 'doses', 'latas', 'garrafas'];
  const kitchenItems = [];
  const beverageItems = [];

  (order.items || []).forEach((item) => {
    let category = '';
    if (item.category && !looksLikeTechnicalId(item.category)) category = item.category;
    else if (item.category?.name) category = item.category.name;
    else if (item.product?.category_name) category = item.product.category_name;

    const categoryLower = (category || '').toLowerCase().trim();
    if (beverageCategories.some((entry) => categoryLower.includes(entry))) {
      beverageItems.push(item);
    } else {
      kitchenItems.push(item);
    }
  });

  const printKitchenItem = (item) => {
    const quantity = item.quantity || 1;
    let name = normalizeText(item.product_name || item.productName || item.name || 'Item');
    const flavors = Array.isArray(item.flavors) && item.flavors.length > 0
      ? item.flavors
      : (Array.isArray(item.halfFlavors) && item.halfFlavors.length > 0 ? item.halfFlavors : []);
    const hasFlavors = flavors.length > 0;
    const isOrganizedPizzaBlock = hasFlavors;

    let size = item.sizeLabel || item.sizeName || item.size;
    if (size && looksLikeTechnicalId(size)) {
      const cleaned = size.replace(/_\d+$/, '').replace(/_/g, ' ');
      size = cleaned.length < 30 && !cleaned.includes('{') ? cleaned : null;
    }
    const sizeLabel = size ? `[${normalizeText(size).toUpperCase()}] ` : '';

    const weightValue = parseFloat(item.weight || 0);
    const isByWeight = item.unitType === 'weight' || weightValue > 0;
    let quantityLabel = `${quantity}x`;
    if (isByWeight) {
      const itemUnit = String(item.unit || '').toLowerCase();
      const isCustomUnit = itemUnit && !['kg', 'g', 'l', 'ml', 'un'].includes(itemUnit);
      if (isCustomUnit) quantityLabel = `${weightValue}${itemUnit}`;
      else if (weightValue < 1000) quantityLabel = `${weightValue}g`;
      else quantityLabel = `${(weightValue / 1000).toFixed(3).replace('.', ',')}kg`;
    }

    data.push(CMD.medium_ON);
    if (isOrganizedPizzaBlock) {
      const sizeText = size ? `: ${normalizeText(size).toUpperCase()}` : '';
      data.push(`${quantityLabel} PIZZA${sizeText}\n`);
    } else {
      data.push(`${quantityLabel} ${sizeLabel}${name}\n`);
    }
    data.push(CMD.medium_OFF);

    const borderName = item.stuffed_crust_flavor || item.stuffedCrustFlavor || item.borderName || item.border?.name || (typeof item.border === 'string' ? item.border : null);
    if (isOrganizedPizzaBlock && borderName) {
      data.push(CMD.medium_ON);
      data.push(`   BORDA: ${normalizeText(borderName)}\n`);
      data.push(CMD.medium_OFF);
    }

    if (hasFlavors) {
      const count = flavors.length;
      const fraction = count === 2 ? '1/2 ' : (count === 3 ? '1/3 ' : (count > 3 ? `1/${count} ` : ''));
      flavors.forEach((flavor) => {
        const flavorName = typeof flavor === 'string' ? flavor : flavor.name || '';
        data.push(`   ${fraction}${normalizeText(flavorName)}\n`);
      });
    }

    getComboChoiceLines(item).forEach((choice) => {
      data.push(`   + ${choice}\n`);
    });

    if (!isOrganizedPizzaBlock && borderName) {
      data.push(CMD.medium_ON);
      data.push(`   BORDA: ${normalizeText(borderName)}\n`);
      data.push(CMD.medium_OFF);
    }

    if (Array.isArray(item.additions) && item.additions.length > 0) {
      item.additions.forEach((addition) => {
        const additionName = normalizeText(addition.name || addition);
        const additionQuantity = addition.quantity || 1;
        data.push(`   + ${additionQuantity > 1 ? additionQuantity + 'x ' : ''}${additionName}\n`);
      });
    }

    if (Array.isArray(item.options) && item.options.length > 0) {
      item.options.forEach((option) => {
        const optionName = normalizeText(option.name || option);
        const optionQuantity = option.quantity || 1;
        data.push(`   + ${optionQuantity > 1 ? optionQuantity + 'x ' : ''}${optionName}\n`);
      });
    }

    if (item.isMarmita && Array.isArray(item.marmitaSelections)) {
      const selectionsByStep = {};
      item.marmitaSelections.forEach((selection) => {
        const step = normalizeText(selection.step || selection.stepName || 'Etapa');
        let options = [];
        if (Array.isArray(selection.items)) {
          options = selection.items.map((entry) => normalizeText(entry?.name || entry || ''));
        } else if (selection.option) {
          const optionName = selection.option.name || selection.option.label || (typeof selection.option === 'string' ? selection.option : '');
          if (optionName) options = [normalizeText(optionName)];
        }
        if (options.length > 0) {
          if (!selectionsByStep[step]) selectionsByStep[step] = [];
          selectionsByStep[step].push(...options);
        }
      });

      Object.entries(selectionsByStep).forEach(([step, options]) => {
        data.push(CMD.medium_ON);
        data.push(`   ${step}:\n`);
        data.push(CMD.medium_OFF);
        const counted = {};
        options.forEach((entry) => {
          counted[entry] = (counted[entry] || 0) + 1;
        });
        Object.entries(counted).forEach(([nameEntry, count]) => {
          data.push(`   ${count > 1 ? count + 'x ' : '  '}${nameEntry}\n`);
        });
      });
    }

    const pizzaCustomizations = item.pizzaCustomizations || item.pizza_customizations;
    if (Array.isArray(pizzaCustomizations) && pizzaCustomizations.length > 0) {
      pizzaCustomizations.forEach((selection) => {
        const stepName = normalizeText(selection.step || selection.stepName || '');
        const options = Array.isArray(selection.items)
          ? selection.items.map((entry) => normalizeText(entry?.name || entry || ''))
          : [normalizeText(selection.items)].filter(Boolean);
        if (stepName && options.length > 0) {
          data.push(CMD.medium_ON);
          data.push(`   ${stepName}:\n`);
          data.push(CMD.medium_OFF);
          data.push(`   ${options.join(', ')}\n`);
        }
      });
    }

    if (item.observations) {
      data.push(CMD.medium_ON);
      data.push(` OBS: ${normalizeText(item.observations)} \n`);
      data.push(CMD.medium_OFF);
    }

    data.push(separatorFine);
  };

  const groupedPromotions = new Map();
  const standaloneItems = [];
  kitchenItems.forEach((item) => {
    const promotionName = item.promotionName || item.promotion_name;
    if (promotionName) {
      if (!groupedPromotions.has(promotionName)) groupedPromotions.set(promotionName, []);
      groupedPromotions.get(promotionName).push(item);
    } else {
      standaloneItems.push(item);
    }
  });

  standaloneItems.forEach(printKitchenItem);
  groupedPromotions.forEach((items, promotionName) => {
    data.push(CMD.ALIGN_CENTER);
    data.push(CMD.medium_ON);
    data.push(` PROMO: ${normalizeText(promotionName)} \n`);
    data.push(CMD.medium_OFF);
    data.push(CMD.ALIGN_LEFT);
    data.push(separatorFine);
    items.forEach(printKitchenItem);
  });

  if (beverageItems.length > 0) {
    data.push(CMD.ALIGN_CENTER);
    data.push(CMD.medium_ON);
    data.push(' BEBIDAS \n');
    data.push(CMD.medium_OFF);
    data.push(CMD.ALIGN_LEFT);

    beverageItems.forEach((item) => {
      const quantity = item.quantity || 1;
      const name = normalizeText(item.product_name || item.productName || item.name || 'Bebida');
      let size = item.sizeLabel || item.sizeName || item.size;
      if (size && looksLikeTechnicalId(size)) {
        const cleaned = size.replace(/_\d+$/, '').replace(/_/g, ' ');
        size = cleaned.length < 30 && !cleaned.includes('{') ? cleaned : null;
      }
      const sizeLabel = size ? ` (${normalizeText(size)})` : '';
      data.push(CMD.TXT_DOUBLE_H);
      data.push(CMD.medium_ON);
      data.push(`${quantity}x ${name}${sizeLabel}\n`);
      data.push(CMD.medium_OFF);
      data.push(CMD.TXT_NORMAL);
    });

    data.push(separatorFine);
  }

  if (order.notes || order.observations) {
    data.push(CMD.medium_ON);
    data.push(` OBS: ${normalizeText(order.notes || order.observations)} \n`);
    data.push(CMD.medium_OFF);
  }

  data.push(separatorFine);
  data.push(CMD.ALIGN_CENTER);
  const totalKitchenItems = kitchenItems.reduce((sum, item) => sum + (item.quantity || 1), 0);
  data.push(CMD.medium_ON);
  let countLabel = `${totalKitchenItems} ITENS`;
  if (beverageItems.length > 0) {
    const totalBeverages = beverageItems.reduce((sum, item) => sum + (item.quantity || 1), 0);
    countLabel += ` + ${totalBeverages} BEB.`;
  }
  data.push(`${countLabel}\n`);
  data.push(CMD.medium_OFF);

  const operatorName = order.operator_name || order.operatorName || order.mesa_operator || order.mesaOperator;
  if (operatorName) {
    data.push(`Op: ${normalizeText(operatorName)}\n`);
  }

  for (let i = 0; i < settings.feedLines; i++) data.push('\n');
  if (settings.autoCut) data.push(CMD.CUT_FULL);

  return data;
}

function generateIfoodPrintData(order, printSettings) {
  const settings = getNormalizedSettings(printSettings);
  const data = [];
  const cols = getPrinterCols(settings);
  const separatorEqual = '='.repeat(cols) + '\n';
  const separatorHifen = '-'.repeat(cols) + '\n';
  const emptyLine = () => data.push('\n');
  const fmtMoney = (value) => (value || 0).toFixed(2).replace('.', ',');

  const orderNum = String(order.order_number || order.orderNumber || order.id || '0').padStart(4, '0');
  const cd = order.customData || order.custom_data;
  const displayId = cd?.displayId || order.displayId || order.display_id || orderNum;
  const orderType = order.order_type || order.orderType;

  let typeLabel = 'Delivery';
  if (orderType === 'balcao') typeLabel = 'Pra Retirar';
  else if (orderType === 'mesa') typeLabel = 'Na Mesa';

  const customerName = normalizeText(order.customer_name || order.customerName || 'Cliente');
  const customerPhone = order.customer_phone || order.customerPhone || '';
  const created = new Date(order.created_at || order.createdAt || Date.now());
  const deliveryTimeStr = cd?.expectedDeliveryTime;
  const deliveryTime = deliveryTimeStr ? new Date(deliveryTimeStr) : new Date(created.getTime() + 40 * 60000);

  data.push(CMD.RESET);
  // 58mm (<=32 col) ou config compact: espacamento de linha justo (ESC 3 14) para a comanda nao sair espacada nem grudada.
  if ((settings.paperWidth || 48) <= 32 || settings.lineSpacing === "compact") data.push(CMD.LINE_SPACING_TIGHT_58MM);
  data.push(CMD.FONT_A);
  data.push('\n');
  data.push(CMD.FONT_A);
  data.push(CMD.ALIGN_CENTER);
  data.push(CMD.TXT_BIG);
  data.push(CMD.medium_ON);
  data.push(`  iFood #${displayId}  \n`);
  data.push(CMD.medium_OFF);
  data.push(CMD.TXT_NORMAL);
  data.push(`iFood - ${typeLabel}\n`);
  emptyLine();

  if (settings.storeName) {
    data.push(CMD.TXT_DOUBLE_H);
    data.push(`${normalizeText(settings.storeName).toUpperCase()}\n`);
    data.push(CMD.TXT_NORMAL);
  }

  data.push(separatorHifen);
  data.push(CMD.ALIGN_CENTER);
  data.push(CMD.TXT_DOUBLE_H);
  data.push(`${typeLabel.toUpperCase()}\n`);
  data.push(CMD.TXT_NORMAL);
  emptyLine();
  data.push(CMD.ALIGN_LEFT);
  data.push(`Data do Pedido:  ${created.toLocaleString('pt-BR')}\n`);
  data.push(`Data de Entrega: ${deliveryTime.toLocaleString('pt-BR')}\n`);
  emptyLine();
  data.push(`Cliente: ${customerName}\n`);
  if (customerPhone) data.push(`Telefone: ${customerPhone} ID: ${displayId}\n`);

  if (order.street || order.customer_address) {
    if (order.street) {
      data.push(`Rua: ${normalizeText(order.street)}\n`);
      data.push(`Número: ${order.number || 'S/N'}\n`);
      if (order.neighborhood) data.push(`Bairro: ${normalizeText(order.neighborhood)}\n`);
      if (order.complement) data.push(`Comp: ${normalizeText(order.complement)}\n`);
      if (order.reference) data.push(`Ref: ${normalizeText(order.reference)}\n`);
    } else {
      normalizeText(order.customer_address).split(',').map((entry) => entry.trim()).filter(Boolean).forEach((entry) => {
        data.push(`${entry}\n`);
      });
    }
  }

  if (cd?.ordersCountOnMerchant) {
    data.push(`${cd.ordersCountOnMerchant} pedidos na sua loja\n`);
  }

  data.push(separatorHifen);
  data.push(CMD.ALIGN_CENTER);
  data.push('ITENS DO PEDIDO\n');
  data.push(CMD.ALIGN_LEFT);

  (order.items || []).forEach((item) => {
    const quantity = item.showQuantity || item.quantity || 1;
    const name = normalizeText(item.name || item.product_name || item.productName || 'Item');
    const unitPrice = item.price || item.unitPrice || item.unit_price || 0;
    const total = item.totalPrice || item.total_price || (unitPrice * quantity);

    data.push(`${quantity} UN\n`);
    data.push(padPair(settings, name, `R$ ${fmtMoney(total)}`));

    if (Array.isArray(item.options) && item.options.length > 0) {
      item.options.forEach((option) => {
        const optionQuantity = option.quantity || 1;
        const optionName = normalizeText(option.name);
        const optionPrice = option.price || option.unitPrice || 0;
        const optionTotal = option.totalPrice || (optionPrice * optionQuantity);
        const priceLabel = optionTotal > 0 ? `R$ ${fmtMoney(optionTotal)}` : '';
        data.push(padPair(settings, `  ${optionQuantity} UN ${optionName}`, priceLabel));
      });
    }

    if (item.observations) {
      data.push(`Obs: ${normalizeText(item.observations)}\n`);
    }

    if (Array.isArray(item.options) && item.options.length > 0) {
      data.push(padPair(settings, 'Total do item', `R$ ${fmtMoney(total)}`));
    }

    data.push(separatorHifen);
  });

  data.push(CMD.ALIGN_CENTER);
  data.push('TOTAL\n');
  data.push(separatorEqual);

  const subtotal = order.subtotal || (order.items || []).reduce((sum, item) => sum + (item.totalPrice || 0), 0);
  const deliveryFee = order.delivery_fee || order.deliveryFee || 0;
  const discount = order.discount || 0;
  const couvert = Number(order.couvert) || 0;
  const serviceFee = Number(order.service_fee) || 0;
  const totalValue = order.total || (subtotal + deliveryFee - discount + couvert + serviceFee);

  data.push(padPair(settings, '| Valor total dos itens', `R$ ${fmtMoney(subtotal)} |`));
  if (deliveryFee > 0) data.push(padPair(settings, '| Taxa de Entrega', `R$ ${fmtMoney(deliveryFee)} |`));

  if (discount > 0) {
    const ifoodDiscount = cd?.discountIfood || 0;
    const merchantDiscount = cd?.discountMerchant || 0;
    if (ifoodDiscount > 0 || merchantDiscount > 0) {
      if (ifoodDiscount > 0) data.push(padPair(settings, '| Desc iFood', `- R$ ${fmtMoney(ifoodDiscount)} |`));
      if (merchantDiscount > 0) data.push(padPair(settings, '| Desc Loja', `- R$ ${fmtMoney(merchantDiscount)} |`));
    } else {
      data.push(padPair(settings, '| Desconto', `- R$ ${fmtMoney(discount)} |`));
    }
  }

  const additionalFees = cd?.additionalFees || 0;
  if (additionalFees > 0) data.push(padPair(settings, '| Taxa de Servico', `R$ ${fmtMoney(additionalFees)} |`));
  if (couvert > 0) data.push(padPair(settings, '| Couvert Artistico', `R$ ${fmtMoney(couvert)} |`));
  if (serviceFee > 0) {
    const percentage = order.service_fee_percent ? ` (${order.service_fee_percent}%)` : '';
    data.push(padPair(settings, `| Taxa de Servico${percentage}`, `R$ ${fmtMoney(serviceFee)} |`));
  }

  data.push(padPair(settings, '| VALOR TOTAL', `R$ ${fmtMoney(totalValue)} |`));
  data.push(separatorEqual);
  emptyLine();

  data.push(CMD.ALIGN_CENTER);
  data.push('FORMAS DE PAGAMENTO\n');
  data.push(separatorEqual);

  let paymentMethodName = order.payment_method_name || order.paymentMethodName
    || order.payment_method || order.paymentMethod || 'Pagamento';
  // Se o valor parece um UUID (ID salvo em vez do nome), tenta resolver pelo custom_data
  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(paymentMethodName).trim());
  if (looksLikeUuid) {
    const resolvedName = cd?.paymentMethodName || cd?.payment_method_name || null;
    if (resolvedName) paymentMethodName = resolvedName;
    else paymentMethodName = 'Pagamento';
  }
  const legacySplits = getParsedPaymentSplits(order);
  if (paymentMethodName === 'mp_pix') paymentMethodName = 'PIX ONLINE';
  if (String(paymentMethodName).toUpperCase() === 'PENDING') paymentMethodName = 'A DEFINIR';
  // Converte codigos tecnicos (ex.: employee_advance) em rotulo legivel.
  paymentMethodName = mapPaymentMethodPrintLabel(paymentMethodName);

  const cardBrand = cd?.cardBrand;
  if (cardBrand) paymentMethodName = `${paymentMethodName} (${cardBrand})`;

  const isOnline =
    cd?.isPrepaid === true ||
    (Number(cd?.pendingAmount ?? 0) === 0 && Number(cd?.prepaidAmount ?? 0) > 0) ||
    paymentMethodName.toLowerCase().includes('online') ||
    paymentMethodName.toLowerCase().includes('site') ||
    paymentMethodName.toLowerCase().includes('app') ||
    paymentMethodName === 'PIX ONLINE';

  if (legacySplits.length > 0) {
    data.push(padPair(settings, '| Pagamento dividido', '|'));
    legacySplits.forEach((split) => {
      const splitName = normalizeText(mapPaymentMethodPrintLabel(split.method_name?.trim() || split.methodName?.trim() || split.method_id || ''));
      const splitPaid = split.paid === true ? ' [PAGO]' : ' [PENDENTE]';
      data.push(padPair(settings, `|   ${splitName}${splitPaid}`, `R$ ${fmtMoney(Number(split.amount) || 0)} |`));
    });
    const changeFor = order.change_for || order.changeFor;
    if (changeFor > 0) {
      data.push(padPair(settings, `|   TROCO: R$ ${fmtMoney(Math.max(0, changeFor - totalValue))}`, ' |'));
    }
    if (order.payment_status === 'paid') {
      data.push(padPair(settings, '| JA PAGO - NAO COBRAR', '|'));
    }
  } else if (isOnline) {
    data.push(padPair(settings, `| Pagamento Online (${normalizeText(paymentMethodName)})`, '(PAGO) |'));
  } else {
    data.push(padPair(settings, '| Cobrar na entrega', ' |'));
    data.push(padPair(settings, `|   ${normalizeText(paymentMethodName).toUpperCase()}`, `R$ ${fmtMoney(totalValue)} |`));
    const changeFor = order.change_for || order.changeFor;
    if (changeFor > 0) {
      data.push(padPair(settings, `|   TROCO: R$ ${fmtMoney(Math.max(0, changeFor - totalValue))}`, ' |'));
    }
  }

  data.push(separatorEqual);
  emptyLine();

  if (cd?.customerDocument) {
    data.push('Informacoes Adicionais\n');
    data.push('Incluir CPF na nota fiscal:\n');
    data.push(`${cd.customerDocument}\n`);
    emptyLine();
    data.push(separatorHifen);
  }

  if (orderType === 'delivery' || orderType === 'balcao') {
    data.push(CMD.ALIGN_CENTER);
    data.push(CMD.TXT_DOUBLE_H);
    data.push(`ENTREGA PEDIDO #${displayId}\n`);
    data.push(CMD.TXT_NORMAL);
    emptyLine();
    data.push(CMD.ALIGN_LEFT);
    const deliveryBy = cd?.deliveryBy || 'LOJA';
    data.push(`Entregue por: ${deliveryBy}\n`);
    data.push(`Horario da Entrega: ${deliveryTime.toLocaleString('pt-BR')}\n`);
    data.push(`Cliente: ${customerName}\n`);

    if (order.street || order.customer_address) {
      if (order.street) {
        data.push(`Rua: ${normalizeText(order.street)}\n`);
        data.push(`Número: ${order.number || 'S/N'}\n`);
        if (order.neighborhood) data.push(`Bairro: ${normalizeText(order.neighborhood)}\n`);
        if (order.complement) data.push(`Comp: ${normalizeText(order.complement)}\n`);
        if (order.reference) data.push(`Ref: ${normalizeText(order.reference)}\n`);
      } else {
        normalizeText(order.customer_address).split(',').map((entry) => entry.trim()).filter(Boolean).forEach((entry) => {
          data.push(`${entry}\n`);
        });
      }
    }

    data.push(separatorHifen);
  }

  data.push(CMD.ALIGN_CENTER);
  data.push(CMD.TXT_NORMAL);
  emptyLine();
  data.push('Impresso por:\n');
  data.push('Pedidos Hub . Desenvolvido por Pedidos Hub\n');
  data.push('@pedidoshub\n');
  emptyLine();

  for (let i = 0; i < settings.feedLines; i++) data.push('\n');
  if (settings.autoCut) data.push(CMD.CUT_FULL);

  return data;
}

function generateCounterPrintData(order, printSettings) {
  const settings = getNormalizedSettings(printSettings);
  const isIfood = order.origin === 'ifood' || order.order_origin === 'ifood' || order.source === 'ifood';
  if (isIfood) {
    return generateIfoodPrintData(order, settings);
  }

  const data = [];
  const cols = getPrinterCols(settings);
  const is58mm = (settings.paperWidth || 48) <= 32;
  const isCompactCounterLayout = is58mm;
  const separator = '='.repeat(cols) + '\n';
  const separatorFine = '-'.repeat(cols) + '\n';
  const orderType = order.order_type || order.orderType;
  const looksLikeTechnicalId = (value) => /^[a-z]{1,4}_|^\d{10,}$|_[0-9a-f]{8,}$/i.test(value || '');
  const isBeverageCategory = (category) => {
    const categoryLower = normalizeText(category || '').toLowerCase();
    return ['refrigerantes', 'bebidas', 'sucos', 'vitaminas', 'drinks', 'agua', 'aguas', 'cervejas', 'vinhos', 'chopp', 'doses', 'latas', 'garrafas']
      .some((entry) => categoryLower.includes(entry));
  };
  const resolveItemCategory = (item) => {
    if (item.category && !looksLikeTechnicalId(item.category)) return item.category;
    if (item.category?.name) return item.category.name;
    if (item.product?.category_name) return item.product.category_name;
    return 'Outros';
  };
  const emptyLine = () => { data.push('\n'); };
  const fmtMoney = (value) => (value || 0).toFixed(2).replace('.', ',');

  const pushItemHeading = (left, right) => {
    data.push(CMD.medium_ON);
    if (right) data.push(padPair(settings, left, right));
    else data.push(`${left}\n`);
    data.push(CMD.medium_OFF);
  };

  const pushItemDetail = (text, indent = '   ') => {
    data.push(`${indent}${text}\n`);
  };

  const pushLabeledDetail = (label, value, indent = '   ') => {
    data.push(CMD.medium_ON);
    data.push(`${indent}${label}`);
    data.push(CMD.medium_OFF);
    data.push(value ? ` ${value}\n` : '\n');
  };

  const pushSectionTitle = (title, withSpacing = true) => {
    const normalizedTitle = normalizeText(title).toUpperCase();
    if (isCompactCounterLayout && normalizedTitle === 'ITENS') return;

    if (withSpacing && !isCompactCounterLayout) emptyLine();
    data.push(CMD.medium_ON);
    data.push(`${normalizedTitle}\n`);
    data.push(CMD.medium_OFF);
    if (isCompactCounterLayout) return;
    data.push(separatorFine);
  };

  data.push(CMD.RESET);
  // 58mm (<=32 col) ou config compact: espacamento de linha justo (ESC 3 14) para a comanda nao sair espacada nem grudada.
  if ((settings.paperWidth || 48) <= 32 || settings.lineSpacing === "compact") data.push(CMD.LINE_SPACING_TIGHT_58MM);
  data.push(CMD.FONT_A);
  data.push(CMD.ALIGN_CENTER);

  if (settings.logoBase64) {
    generateLogoESCPOS(settings.logoBase64).forEach((command) => data.push(command));
  }

  if (settings.showStoreName && settings.storeName) {
    data.push(CMD.TXT_DOUBLE_H);
    data.push(CMD.medium_ON);
    data.push(`${normalizeText(settings.storeName)}\n`);
    data.push(CMD.medium_OFF);
    data.push(CMD.TXT_NORMAL);
  }

  if (settings.showStorePhone) {
    data.push(`Tel: ${settings.showStorePhone}\n`);
  }

  if (!isCompactCounterLayout) data.push(separator);

  const isService = orderType === 'servico' || orderType === 'serviço';
  const orderNum = String(order.order_number || order.orderNumber || order.id || '0').padStart(3, '0');
  const scheduledAt = order.scheduled_at || order.scheduledAt;

  let typeLabel = 'RETIRADA';
  if (orderType === 'delivery') typeLabel = scheduledAt ? 'ENTREGA AGENDADA' : 'ENTREGA';
  else if (orderType === 'mesa') typeLabel = `MESA ${order.table_number || order.tableNumber || ''}`.trim();
  else if (isService) typeLabel = 'AGENDAMENTO';
  else if (scheduledAt) typeLabel = 'RETIRADA AGENDADA';

  if (!isService) {
    data.push(is58mm ? CMD.TXT_DOUBLE_H : CMD.TXT_BIG);
    data.push(`#${orderNum} ${typeLabel}\n`);
    data.push(CMD.TXT_NORMAL);
  }

  if (settings.showDateTime) {
    const dateTime = new Date(order.created_at || order.createdAt || Date.now()).toLocaleString('pt-BR');
    data.push(`${dateTime}\n`);
  }

  if (scheduledAt) {
    const scheduleDate = new Date(scheduledAt);
    if (!Number.isNaN(scheduleDate.getTime())) {
      const scheduleLabel = `${scheduleDate.toLocaleDateString('pt-BR')} as ${scheduleDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
      data.push(CMD.medium_ON);
      data.push(`AGENDADO: ${scheduleLabel}\n`);
      data.push(CMD.medium_OFF);
    }
  }

  data.push(separatorFine);

  const customerName = normalizeText(order.customer_name || order.customerName || 'Consumidor');
  const customerPhone = order.customer_phone || order.customerPhone || '';
  if (settings.showCustomerInfo !== false) {
    data.push(CMD.ALIGN_LEFT);
    data.push(CMD.medium_ON);
    data.push(`CLIENTE: ${customerName}\n`);
    data.push(CMD.medium_OFF);
    if (customerPhone) data.push(`TEL: ${customerPhone}\n`);

    if (orderType === 'delivery' && settings.showDeliveryInfo) {
      const street = order.street || '';
      const number = order.number || order.address_number || order.addressNumber || '';
      const neighborhood = order.neighborhood || '';
      const complement = order.complement || '';
      const reference = order.reference || '';
      if (isCompactCounterLayout) {
        if (street) {
          const addressParts = [normalizeText(street)];
          if (number) addressParts.push(normalizeText(number));
          data.push(`END: ${addressParts.join(', ')}\n`);
        }

        const areaParts = [];
        if (neighborhood) areaParts.push(`BAIRRO: ${normalizeText(neighborhood)}`);
        if (complement) areaParts.push(`COMPL: ${normalizeText(complement)}`);
        if (reference) areaParts.push(`REF: ${normalizeText(reference)}`);
        if (areaParts.length > 0) {
          const line = areaParts.join(' / ');
          if (line.length <= cols) data.push(`${line}\n`);
          else areaParts.forEach((part) => data.push(`${part}\n`));
        }
      } else if (street) {
        data.push(`RUA: ${normalizeText(street)}\n`);
        data.push(`NUMERO: ${normalizeText(number) || 'S/N'}\n`);
        if (neighborhood) data.push(`BAIRRO: ${normalizeText(neighborhood)}\n`);
        if (complement) data.push(`COMPL: ${normalizeText(complement)}\n`);
        if (reference) data.push(`REF: ${normalizeText(reference)}\n`);
      }
    }

    data.push(separatorFine);
  }

  data.push(CMD.ALIGN_CENTER);

  if (isService) {
    data.push(CMD.TXT_DOUBLE_H);
    data.push(CMD.medium_ON);
    data.push('COMPROVANTE DE\n');
    data.push('AGENDAMENTO\n');
    data.push(CMD.medium_OFF);
    data.push(CMD.TXT_NORMAL);
    data.push(separator);
    emptyLine();
    data.push(CMD.ALIGN_LEFT);
    const paymentMethod = order.payment_method || order.paymentMethod || '';
    if (paymentMethod) {
      const pmPrint = String(paymentMethod).toUpperCase() === 'PENDING' ? 'A DEFINIR' : normalizeText(paymentMethod).toUpperCase();
      data.push(padPair(settings, `CODIGO: ${orderNum}`, `PAGAMENTO: ${pmPrint}`));
    } else {
      data.push(`CODIGO: ${orderNum}\n`);
    }
    emptyLine();
    data.push(CMD.medium_ON);
    data.push(`CLIENTE: ${customerName}\n`);
    data.push(CMD.medium_OFF);
    if (customerPhone) data.push(`TELEFONE: ${customerPhone}\n`);
    emptyLine();
    data.push(separator);
    data.push(CMD.ALIGN_CENTER);
    data.push(CMD.medium_ON);
    data.push('SERVICOS AGENDADOS\n');
    data.push(CMD.medium_OFF);
    data.push(separator);
    emptyLine();

    let serviceTotal = 0;
    (order.items || []).forEach((item) => {
      const serviceName = normalizeText(item.product_name || item.productName || item.name || 'Servico');
      const servicePrice = parseFloat(item.total_price || item.totalPrice || item.price || 0);
      const observations = item.observations || item.obs || '';
      serviceTotal += servicePrice;

      data.push(CMD.ALIGN_LEFT);
      data.push(CMD.medium_ON);
      data.push(`${serviceName}\n`);
      data.push(CMD.medium_OFF);

      if (observations) {
        const normalizedObservations = normalizeText(observations);
        const dateMatch = normalizedObservations.match(/(\d{2}\/\d{2}\/\d{4})/);
        const timeMatch = normalizedObservations.match(/as?\s*(\d{2}:\d{2})/i);
        const professionalMatch = normalizedObservations.match(/profissional:\s*(.+)/i);

        if (dateMatch) data.push(`   DATA: ${dateMatch[1]}\n`);
        if (timeMatch) data.push(`   HORARIO: ${timeMatch[1]}\n`);
        if (professionalMatch) data.push(`   PROFISSIONAL: ${professionalMatch[1].trim()}\n`);
        if (!dateMatch && !timeMatch && !professionalMatch) {
          data.push(`   ${normalizedObservations}\n`);
        }
      }

      data.push(CMD.medium_ON);
      data.push(padPair(settings, '   VALOR:', `R$ ${fmtMoney(servicePrice)}`));
      data.push(CMD.medium_OFF);
      emptyLine();
    });

    data.push(separator);
    data.push(CMD.ALIGN_CENTER);
    data.push(CMD.TXT_DOUBLE_H);
    data.push(CMD.medium_ON);
    data.push(`TOTAL: R$ ${fmtMoney(order.total || serviceTotal || 0)}\n`);
    data.push(CMD.medium_OFF);
    data.push(CMD.TXT_NORMAL);
    data.push(separator);
    emptyLine();
    data.push(CMD.ALIGN_CENTER);
    data.push('Obrigado pela preferencia!\n');
    if (settings.customFooter) data.push(`${normalizeText(settings.customFooter)}\n`);
    emptyLine();
    data.push(`Emitido em: ${new Date().toLocaleString('pt-BR')}\n`);
    for (let i = 0; i < settings.feedLines; i++) data.push('\n');
    if (settings.autoCut) data.push(CMD.CUT_FULL);
    return data;
  }

  data.push(CMD.ALIGN_LEFT);
  const groupedPromotions = new Map();
  const promotionHighlightedBeverages = new Map();
  const nonPromotionItems = [];

  (order.items || []).forEach((item) => {
    const promotionName = item.promotionName || item.promotion_name;
    const category = resolveItemCategory(item);

    if (settings.highlightBeverages && isBeverageCategory(category)) {
      if (promotionName) {
        if (!promotionHighlightedBeverages.has(promotionName)) promotionHighlightedBeverages.set(promotionName, []);
        promotionHighlightedBeverages.get(promotionName).push(item);
      }
      return;
    }

    if (promotionName) {
      if (!groupedPromotions.has(promotionName)) groupedPromotions.set(promotionName, []);
      groupedPromotions.get(promotionName).push(item);
    } else {
      nonPromotionItems.push(item);
    }
  });

  const itemsByCategory = {};
  nonPromotionItems.forEach((item) => {
    const category = resolveItemCategory(item);

    const bucket = settings.groupByCategory ? category : '_all';
    if (!itemsByCategory[bucket]) itemsByCategory[bucket] = [];
    itemsByCategory[bucket].push(item);
  });

  const printCounterItem = (item, isPromoChild = false, category = '') => {
    if (item.isMarmita && Array.isArray(item.marmitaSelections)) {
      const name = normalizeText(item.product_name || item.productName || item.name || 'Item');
      const quantity = settings.showItemQuantity ? (item.quantity || 1) : 1;
      const totalItem = item.totalPrice || item.total_price || (quantity * (item.unitPrice || item.unit_price || 0));
      const headerLine = settings.showItemQuantity
        ? `${isPromoChild ? '  ' : ''}${quantity}x ${name}`
        : `${isPromoChild ? '  ' : ''}${name}`;
      pushItemHeading(headerLine, settings.showItemPrice ? `R$ ${fmtMoney(totalItem)}` : undefined);

      let sizeValue = item.sizeLabel || item.sizeName || item.size;
      if (sizeValue && looksLikeTechnicalId(sizeValue)) {
        const cleaned = sizeValue.replace(/_\d+$/, '').replace(/_/g, ' ');
        sizeValue = cleaned.length < 30 && !cleaned.includes('{') ? cleaned : null;
      }
      if (sizeValue) pushLabeledDetail('Tamanho:', normalizeText(sizeValue));

      const selectionsByStep = {};
      item.marmitaSelections.forEach((selection) => {
        const step = normalizeText(selection.step || selection.stepName || 'Etapa');
        let options = [];
        if (Array.isArray(selection.items)) {
          options = selection.items.map((entry) => normalizeText(entry?.name || entry || '').toUpperCase());
        } else if (selection.option) {
          const optionName = selection.option.name || selection.option.label || (typeof selection.option === 'string' ? selection.option : '');
          if (optionName) options = [normalizeText(optionName).toUpperCase()];
        }
        if (options.length > 0) {
          if (!selectionsByStep[step]) selectionsByStep[step] = [];
          selectionsByStep[step].push(...options);
        }
      });

      Object.entries(selectionsByStep).forEach(([step, options]) => {
        pushLabeledDetail(`${step}:`, '', '   ');
        const counted = {};
        options.forEach((entry) => {
          counted[entry] = (counted[entry] || 0) + 1;
        });
        Object.entries(counted).forEach(([optionName, count]) => {
          pushItemDetail(`+ ${count > 1 ? `${count}x ` : '1x '}${optionName}`, '    ');
        });
      });

      if (settings.showItemNotes && item.observations) {
        pushLabeledDetail('Obs:', normalizeText(item.observations));
      }
      if (!isPromoChild && !isCompactCounterLayout) data.push(separatorFine);
      return;
    }

    const weightValue = parseFloat(item.weight || 0);
    const isByWeight = item.unitType === 'weight' || weightValue > 0;
    const name = normalizeText(item.product_name || item.productName || item.name || 'Item');
    const unitPrice = item.unit_price || item.unitPrice || item.price || 0;

    let quantityDisplay = '';
    let totalItem = 0;
    if (isByWeight) {
      const itemUnit = String(item.unit || '').toLowerCase();
      const isCustomUnit = itemUnit && !['kg', 'g', 'l', 'ml', 'un'].includes(itemUnit);
      if (isCustomUnit) {
        quantityDisplay = settings.showItemQuantity ? `${weightValue}${itemUnit}` : '';
        totalItem = (item.totalPrice || item.total_price) || (weightValue * unitPrice);
      } else if (weightValue < 1000) {
        quantityDisplay = settings.showItemQuantity ? `${weightValue}g` : '';
        totalItem = (item.totalPrice || item.total_price) || ((weightValue / 1000) * unitPrice);
      } else {
        const weightKg = weightValue / 1000;
        quantityDisplay = settings.showItemQuantity ? `${weightKg.toFixed(3).replace('.', ',')}kg` : '';
        totalItem = (item.totalPrice || item.total_price) || (weightKg * unitPrice);
      }
    } else {
      const quantity = item.quantity || 1;
      quantityDisplay = settings.showItemQuantity ? `${quantity}x` : '';
      totalItem = (item.totalPrice || item.total_price) || (quantity * unitPrice);
    }

    let size = item.sizeLabel || item.sizeName || item.size;
    if (size && looksLikeTechnicalId(size)) size = null;

    const flavors = Array.isArray(item.flavors) && item.flavors.length > 0
      ? item.flavors
      : (Array.isArray(item.halfFlavors) && item.halfFlavors.length > 0 ? item.halfFlavors : []);
    const hasFlavors = flavors.length > 0;
    const isPizzaHalf = item.half_and_half || item.isHalfAndHalf || item.pizzaType === 'half' || (hasFlavors && flavors.length > 1);

    let displayTitle = name;
    if (hasFlavors) {
      if (flavors.length === 1) {
        const flavorName = flavors[0].name || flavors[0];
        displayTitle = normalizeText(typeof flavorName === 'string' ? flavorName : name);
      } else {
        displayTitle = `PIZZA ${flavors.length} SABORES`;
      }
    } else if (isPizzaHalf && name.includes('/')) {
      displayTitle = name;
    }

    const hasPromotion = item.promotionId || item.promotion_id || item.promotionName || item.promotion_name;
    const categoryLower = String(category || '').toLowerCase();
    const isBeverage = ['refrigerantes', 'bebidas', 'sucos', 'vitaminas', 'drinks', 'agua', 'aguas', 'cervejas', 'vinhos', 'chopp', 'doses', 'latas', 'garrafas'].some((entry) => categoryLower.includes(entry));
    const isOrganizedPizzaBlock = !isBeverage && hasFlavors;

    // Tamanho no início para pizzas, no fim (entre parênteses) para bebidas
    const sizePrefix = size && !isBeverage ? `[${normalizeText(size).toUpperCase()}] ` : '';
    const sizeText = size ? `: ${normalizeText(size).toUpperCase()}` : '';
    let itemLine = isOrganizedPizzaBlock
      ? `${isPromoChild ? '  ' : ''}${quantityDisplay}${quantityDisplay ? ' ' : ''}PIZZA${sizeText}`
      : `${isPromoChild ? '  ' : ''}${quantityDisplay}${quantityDisplay ? ' ' : ''}${sizePrefix}${displayTitle}`;
    if (isBeverage && size) itemLine += ` (${normalizeText(size)})`;

    pushItemHeading(itemLine, settings.showItemPrice && (!hasPromotion || isPromoChild) ? `R$ ${fmtMoney(totalItem)}` : undefined);

    if (isByWeight && settings.showItemPrice && !hasPromotion) {
      pushLabeledDetail('Valor Kg:', `R$ ${fmtMoney(unitPrice)}`);
    }

    const borderName = item.stuffed_crust_flavor || item.stuffedCrustFlavor || item.borderName || item.border?.name || (typeof item.border === 'string' ? item.border : null);
    if (isOrganizedPizzaBlock && borderName) pushLabeledDetail('Borda:', normalizeText(borderName));

    if (hasFlavors) {
      const count = flavors.length;
      const fraction = count === 2 ? '1/2 ' : (count === 3 ? '1/3 ' : (count > 3 ? `1/${count} ` : ''));
      flavors.forEach((flavor) => {
        const flavorName = typeof flavor === 'string' ? flavor : flavor.name || '';
        pushItemDetail(`${fraction}${normalizeText(flavorName)}`);
      });
    }

    getComboChoiceLines(item).forEach((choice) => {
      pushItemDetail(`+ ${choice}`);
    });

    if (!isOrganizedPizzaBlock && borderName) pushLabeledDetail('Borda:', normalizeText(borderName));

    if (Array.isArray(item.extras) && item.extras.length > 0) {
      item.extras.forEach((extra) => pushItemDetail(`+ ${normalizeText(extra.name || extra)}`));
    }

    if (Array.isArray(item.options) && item.options.length > 0) {
      item.options.forEach((option) => pushItemDetail(`+ ${normalizeText(option.name || option)}`));
    }

    const pizzaCustomizations = item.pizzaCustomizations || item.pizza_customizations;
    if (Array.isArray(pizzaCustomizations) && pizzaCustomizations.length > 0) {
      pizzaCustomizations.forEach((selection) => {
        const stepName = normalizeText(selection.step || selection.stepName || '');
        const options = Array.isArray(selection.items)
          ? selection.items.map((entry) => normalizeText(entry?.name || entry || ''))
          : [normalizeText(selection.items)].filter(Boolean);
        if (stepName && options.length > 0) {
          pushLabeledDetail(`${stepName}:`, options.join(', '));
        }
      });
    }

    if (hasPromotion && !isPromoChild) {
      const promotionName = item.promotionName || item.promotion_name || 'PROMOCAO';
      const promotionType = item.promotionType || item.promotion_type;
      const originalPrice = item.originalPrice || item.original_price || 0;
      const buyQuantity = item.buyQuantity || item.buy_quantity;
      const payQuantity = item.payQuantity || item.pay_quantity;
      const giftName = item.giftProductName || item.gift_product_name;
      pushLabeledDetail('Promocao:', normalizeText(promotionName));

      if (promotionType === 'percentage' || promotionType === 'fixed' || promotionType === 'promo_price') {
        if (originalPrice > 0) pushLabeledDetail('De:', `R$ ${fmtMoney(originalPrice)}`, '    ');
        pushLabeledDetail('Por:', `R$ ${fmtMoney(totalItem)}`, '    ');
      } else if (promotionType === 'buy_x_get_y') {
        pushLabeledDetail('Regra:', `Leve ${buyQuantity || 3} pague ${payQuantity || 2}`, '    ');
        pushLabeledDetail('Total:', `R$ ${fmtMoney(totalItem)}`, '    ');
      } else if (promotionType === 'free_shipping') {
        pushLabeledDetail('Beneficio:', 'Frete gratis', '    ');
        pushLabeledDetail('Total:', `R$ ${fmtMoney(totalItem)}`, '    ');
      } else if (promotionType === 'gift' && giftName) {
        pushLabeledDetail('Brinde:', normalizeText(giftName), '    ');
        pushLabeledDetail('Total:', `R$ ${fmtMoney(totalItem)}`, '    ');
      } else if (promotionType === 'combo') {
        pushLabeledDetail('Tipo:', 'Combo', '    ');
        pushLabeledDetail('Total:', `R$ ${fmtMoney(totalItem)}`, '    ');
      } else {
        if (originalPrice > 0) pushLabeledDetail('De:', `R$ ${fmtMoney(originalPrice)}`, '    ');
        pushLabeledDetail('Por:', `R$ ${fmtMoney(totalItem)}`, '    ');
      }
    }

    if (settings.showItemNotes && item.observations) {
      pushLabeledDetail('Obs:', normalizeText(item.observations));
    }

    if (!isPromoChild && !isCompactCounterLayout) data.push(separatorFine);
  };

  groupedPromotions.forEach((items, promotionName) => {
    pushSectionTitle(`PROMO: ${promotionName}`);
    items.forEach((item) => printCounterItem(item, true, '_promos'));
    const highlightedBeverages = promotionHighlightedBeverages.get(promotionName) || [];
    if (highlightedBeverages.length > 0) {
      data.push(CMD.medium_ON);
      data.push('  BEBIDA NO DESTAQUE DO MOTOBOY\n');
      data.push(CMD.medium_OFF);
      highlightedBeverages.forEach((item) => {
        const quantity = item.quantity || 1;
        const name = normalizeText(item.product_name || item.productName || item.name || 'Bebida');
        let size = item.sizeLabel || item.sizeName || item.size;
        if (size && looksLikeTechnicalId(size)) size = null;
        const sizeText = size ? ` (${normalizeText(size)})` : '';
        pushItemDetail(`+ ${quantity}x ${name}${sizeText}`, '    ');
      });
    }
    if (!isCompactCounterLayout) data.push(separatorFine);
  });

  Object.keys(itemsByCategory).sort().forEach((category) => {
    if (settings.groupByCategory && category !== '_all') {
      pushSectionTitle(category);
    }

    itemsByCategory[category].forEach((item) => {
      printCounterItem(item, false, category);
    });
  });

  if (settings.highlightBeverages) {
    const beverageItems = (order.items || []).filter((item) => isBeverageCategory(resolveItemCategory(item)));

    if (beverageItems.length > 0) {
      if (!isCompactCounterLayout) data.push(separatorFine);
      data.push(CMD.ALIGN_CENTER);
      data.push(CMD.INVERSE_ON);
      data.push(CMD.TXT_BIG);
      data.push(CMD.medium_ON);
      data.push(' ATENCAO MOTOBOY \n');
      data.push(CMD.medium_OFF);
      data.push(CMD.TXT_NORMAL);
      data.push(CMD.INVERSE_OFF);
      emptyLine();
      data.push(CMD.ALIGN_LEFT);
      data.push(CMD.TXT_BIG);
      data.push(CMD.medium_ON);
      data.push('LEVAR BEBIDAS:\n');
      data.push(CMD.medium_OFF);
      data.push(CMD.TXT_NORMAL);
      emptyLine();

      beverageItems.forEach((item) => {
        const quantity = item.quantity || 1;
        const name = normalizeText(item.product_name || item.productName || item.name || 'Bebida');
        let size = item.sizeLabel || item.sizeName || item.size;
        if (size && looksLikeTechnicalId(size)) size = null;
        const sizeText = size ? ` (${normalizeText(size)})` : '';
        data.push(CMD.TXT_DOUBLE_H);
        data.push(CMD.medium_ON);
        data.push(`  ${quantity}x ${name}${sizeText}\n`);
        data.push(CMD.medium_OFF);
        data.push(CMD.TXT_NORMAL);
      });

      if (!isCompactCounterLayout) data.push(separatorFine);
    }
  }

  if (settings.showOrderNotes !== false && (order.notes || order.observations)) {
    const notesText = normalizeText(order.notes || order.observations);
    const cleanNotes = notesText
      .split('\n')
      .filter((line) => !line.toLowerCase().includes('taxa de pagamento'))
      .join('\n')
      .trim();

    if (cleanNotes) {
      pushSectionTitle('Observacoes do pedido');
      data.push(`${cleanNotes}\n`);
    }
  }

  if (settings.showTotal) {
    data.push(separatorFine);
    data.push(CMD.ALIGN_LEFT);
    data.push(padPair(settings, 'SUBTOTAL:', `R$ ${fmtMoney(order.subtotal)}`));

    if ((order.delivery_fee || order.deliveryFee) > 0) {
      data.push(padPair(settings, 'FRETE:', `R$ ${fmtMoney(order.delivery_fee || order.deliveryFee)}`));
    }

    let paymentFee = order.paymentFee || order.payment_fee || 0;
    if (!paymentFee && (order.notes || order.observations)) {
      const notes = String(order.notes || order.observations);
      const match = notes.match(/Taxa de pagamento:\s*R\$\s*([\d,.]+)/i);
      if (match && match[1]) {
        let value = match[1];
        if (value.includes(',')) value = value.replace(/\./g, '').replace(',', '.');
        paymentFee = parseFloat(value);
      }
    }
    if (paymentFee > 0) data.push(padPair(settings, 'TAXA PAGTO:', `R$ ${fmtMoney(paymentFee)}`));

    let additionValue = 0;
    if (order.addition !== undefined) additionValue = Number(order.addition);
    else if (order.additionValue !== undefined) additionValue = Number(order.additionValue);
    else if (order.acrescimo !== undefined) additionValue = Number(order.acrescimo);
    else if (order['acréscimo'] !== undefined) additionValue = Number(order['acréscimo']);
    if (!Number.isNaN(additionValue) && additionValue > 0) {
      data.push(padPair(settings, 'ACRESCIMO:', `R$ ${fmtMoney(additionValue)}`));
    }

    if (order.discount > 0) data.push(padPair(settings, 'DESCONTO:', `-R$ ${fmtMoney(order.discount)}`));
    if (Number(order.couvert) > 0) data.push(padPair(settings, 'COUVERT ARTISTICO:', `R$ ${fmtMoney(order.couvert)}`));

    if (Number(order.service_fee) > 0) {
      const percentage = order.service_fee_percent ? ` (${order.service_fee_percent}%)` : '';
      data.push(padPair(settings, `TAXA DE SERVICO${percentage}:`, `R$ ${fmtMoney(order.service_fee)}`));
    }

    if (!isCompactCounterLayout) data.push(separatorFine);
    data.push(CMD.ALIGN_CENTER);
    data.push(is58mm ? CMD.TXT_DOUBLE_H : CMD.TXT_BIG);
    data.push(CMD.medium_ON);
    data.push(isCompactCounterLayout ? `TOTAL: R$ ${fmtMoney(order.total)}\n` : ` TOTAL R$ ${fmtMoney(order.total)} \n`);
    data.push(CMD.medium_OFF);
    data.push(CMD.TXT_NORMAL);
    data.push(CMD.ALIGN_LEFT);
  }

  const receiptSplits = getParsedPaymentSplits(order);
  if (settings.showPaymentMethod && ((order.payment_method || order.paymentMethod) || receiptSplits.length > 0)) {
    let paymentMethodRaw = String(order.payment_method_name || order.paymentMethodName || order.payment_method || order.paymentMethod || '');
    if (paymentMethodRaw.toUpperCase() === 'PENDING') paymentMethodRaw = 'A DEFINIR';
    // Resolve UUID → nome via custom_data
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(paymentMethodRaw.trim())) {
      paymentMethodRaw = String(cd?.paymentMethodName || cd?.payment_method_name || 'Pagamento');
    }
    // Converte codigos tecnicos (ex.: employee_advance) em rotulo legivel.
    paymentMethodRaw = mapPaymentMethodPrintLabel(paymentMethodRaw);
    const paymentMethodLower = paymentMethodRaw.toLowerCase();
    const isSplitPayment =
      receiptSplits.length > 0 ||
      paymentMethodLower === 'split' ||
      paymentMethodLower.includes('múltipl') ||
      paymentMethodLower.includes('multipl') ||
      paymentMethodLower.includes('divid');
    const isPaidOnline = paymentMethodLower === 'pix_online' || paymentMethodLower.includes('online') || paymentMethodLower.includes('pago');
    const isManuallyPaid = order.payment_status === 'paid';

    if (!isCompactCounterLayout) data.push(separatorFine);

    if (isPaidOnline) {
      data.push(CMD.ALIGN_CENTER);
      data.push(CMD.TXT_BIG);
      data.push(CMD.medium_ON);
      data.push(' PAGO ONLINE \n');
      data.push(CMD.medium_OFF);
      data.push(CMD.TXT_NORMAL);
      data.push(CMD.TXT_DOUBLE_H);
      data.push(CMD.medium_ON);
      data.push(' NAO COBRAR \n');
      data.push(CMD.medium_OFF);
      data.push(CMD.TXT_NORMAL);
      data.push(CMD.ALIGN_LEFT);
    } else if (isSplitPayment) {
      data.push(CMD.ALIGN_CENTER);
      data.push(CMD.TXT_DOUBLE_H);
      data.push(CMD.medium_ON);
      data.push(' PAGAMENTO MULTIPLO \n');
      data.push(CMD.medium_OFF);
      data.push(CMD.TXT_NORMAL);
      data.push(CMD.ALIGN_LEFT);

      receiptSplits.forEach((split) => {
        const name = normalizeText(mapPaymentMethodPrintLabel(split.method_name?.trim() || split.methodName?.trim() || split.method_id || ''));
        const amount = `R$ ${fmtMoney(Number(split.amount) || 0)}`;
        const paidStatus = split.paid === true ? ' [PAGO]' : ' [PENDENTE]';
        data.push(CMD.medium_ON);
        data.push(padPair(settings, `  ${name}${paidStatus}:`, amount));
        data.push(CMD.medium_OFF);
      });

      if (isManuallyPaid) {
        emptyLine();
        data.push(CMD.ALIGN_CENTER);
        data.push(CMD.TXT_DOUBLE_H);
        data.push(CMD.medium_ON);
        data.push(' JA PAGO - NAO COBRAR \n');
        data.push(CMD.medium_OFF);
        data.push(CMD.TXT_NORMAL);
        data.push(CMD.ALIGN_LEFT);
      }
    } else {
      if (isCompactCounterLayout) {
        data.push(CMD.ALIGN_CENTER);
        data.push(CMD.TXT_DOUBLE_H);
        data.push(CMD.medium_ON);
        data.push(`${normalizeText(paymentMethodRaw).toUpperCase()}\n`);
        data.push(CMD.medium_OFF);
        data.push(CMD.TXT_NORMAL);
        data.push(CMD.ALIGN_LEFT);
      } else {
        data.push(CMD.ALIGN_CENTER);
        data.push(CMD.TXT_DOUBLE_H);
        data.push(CMD.medium_ON);
        data.push(` ${normalizeText(paymentMethodRaw).toUpperCase()} \n`);
        data.push(CMD.medium_OFF);
        data.push(CMD.TXT_NORMAL);
        data.push(CMD.ALIGN_LEFT);
      }

      const changeFor = order.change_for || order.changeFor;
      if (changeFor > 0) {
        data.push(CMD.medium_ON);
        data.push(padPair(settings, 'Troco para:', `R$ ${fmtMoney(changeFor)}`));
        data.push(padPair(settings, 'Levar troco:', `R$ ${fmtMoney(changeFor - order.total)}`));
        data.push(CMD.medium_OFF);
      }

      if (isManuallyPaid) {
        emptyLine();
        data.push(CMD.ALIGN_CENTER);
        data.push(CMD.TXT_DOUBLE_H);
        data.push(CMD.medium_ON);
        data.push(' JA PAGO - NAO COBRAR \n');
        data.push(CMD.medium_OFF);
        data.push(CMD.TXT_NORMAL);
        data.push(CMD.ALIGN_LEFT);
      }
    }
  }

  if (!isCompactCounterLayout) data.push(separatorFine);
  if (settings.showOperator !== false) {
    const operatorName = order.operator_name || order.operatorName || order.mesa_operator || order.mesaOperator;
    if (operatorName) data.push(`OPERADOR: ${normalizeText(operatorName)}\n`);
  }

  data.push(CMD.ALIGN_CENTER);
  if (settings.customFooter) data.push(`${normalizeText(settings.customFooter)}\n`);
  if (!isCompactCounterLayout) data.push('Pedidos Hub | @pedidoshub\n');

  const finalFeedLines = isCompactCounterLayout ? Math.min(settings.feedLines, 1) : settings.feedLines;
  for (let i = 0; i < finalFeedLines; i++) data.push('\n');
  if (settings.autoCut) data.push(CMD.CUT_FULL);

  return data;
}

function generateOrderPrintData(order, printType = 'counter', printSettings) {
  if (order?._customPrintData && Array.isArray(order._customPrintData)) {
    return order._customPrintData;
  }

  if (printType === 'kitchen') {
    return generateKitchenPrintData(order, printSettings);
  }

  if (printType === 'both') {
    return [
      ...generateKitchenPrintData(order, printSettings),
      ...generateCounterPrintData(order, printSettings)
    ];
  }

  return generateCounterPrintData(order, printSettings);
}

module.exports = {
  CMD,
  DEFAULT_PRINT_SETTINGS,
  getNormalizedSettings,
  generateOrderPrintData,
  normalizeText
};
