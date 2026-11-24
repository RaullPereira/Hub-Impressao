const ATTENDANCE_ALIASES = new Set([
  'attendance',
  'counter',
  'balcao',
  'balcão',
  'salao',
  'salão',
  'delivery',
  'pickup',
  'takeout',
  'retirada'
]);

const BAR_ALIASES = new Set([
  'bar',
  'bebida',
  'bebidas',
  'drink',
  'drinks'
]);

function normalizePrinterValue(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}

function normalizeAutoPrintRoute(value) {
  const type = typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : '';

  if (type === 'kitchen') return 'kitchen';
  if (BAR_ALIASES.has(type)) return 'bar';
  if (type === 'default') return null;
  if (!type || ATTENDANCE_ALIASES.has(type)) return 'attendance';

  return 'attendance';
}

function normalizeLegacyPrinterType(value) {
  const route = normalizeAutoPrintRoute(value);
  if (route === 'kitchen') return 'kitchen';
  if (route === 'bar') return 'bar';
  if (route === 'attendance') return 'counter';
  return 'default';
}

function getPrintTypeForRoute(route) {
  const normalizedRoute = normalizeAutoPrintRoute(route);
  if (normalizedRoute === 'kitchen') return 'kitchen';
  if (normalizedRoute === 'bar') return 'bar';
  return 'counter';
}

function normalizeAutoPrintRoutes(value, options = {}) {
  let rawRoutes = null;

  if (Array.isArray(value)) {
    rawRoutes = value;
  } else if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      rawRoutes = Array.isArray(parsed) ? parsed : null;
    } catch {
      rawRoutes = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    }
  }

  if (!rawRoutes) {
    const legacyType = String(options.autoPrintType || 'counter').toLowerCase();
    rawRoutes = [];
    if (legacyType === 'counter' || legacyType === 'both') rawRoutes.push('counter');
    if (legacyType === 'kitchen' || legacyType === 'both') rawRoutes.push('kitchen');
    if (options.barPrintEnabled === true) rawRoutes.push('bar');
  }

  const routes = [];
  for (const route of rawRoutes) {
    const normalizedRoute = normalizeAutoPrintRoute(route);
    const checkboxRoute = normalizedRoute === 'attendance' ? 'counter' : normalizedRoute;
    if (!checkboxRoute || !['counter', 'kitchen', 'bar'].includes(checkboxRoute)) continue;
    if (checkboxRoute === 'bar' && options.barPrintEnabled !== true) continue;
    if (!routes.includes(checkboxRoute)) routes.push(checkboxRoute);
  }

  return routes;
}

function buildLegacyAutoPrintRoutes(printSettings = {}) {
  return normalizeAutoPrintRoutes(printSettings.autoPrintRoutes, {
    autoPrintType: printSettings.autoPrintType,
    barPrintEnabled: printSettings.barPrintEnabled === true
  }).map((route) => ({
    route,
    printType: route === 'counter' ? 'counter' : route,
    ledgerType: route
  }));
}

// Tipos de pedido que cada impressora imprime no automático (cadastro da impressora).
const ORDER_TYPE_KEYS = ['mesa', 'balcao', 'delivery'];

function orderTypeKey(order) {
  const type = String(order?.order_type ?? order?.orderType ?? order?.delivery_type ?? order?.deliveryType ?? '')
    .trim().toLowerCase();
  if (['mesa', 'table', 'dine_in', 'salao'].includes(type)) return 'mesa';
  if (type === 'delivery') return 'delivery';
  return 'balcao';
}

function normalizeOrderTypes(value) {
  if (!Array.isArray(value)) return null;
  const types = value.map((entry) => String(entry || '').trim().toLowerCase()).filter((entry) => ORDER_TYPE_KEYS.includes(entry));
  // Lista vazia ou com todos os tipos = imprime tudo (sem filtro).
  return types.length > 0 && types.length < ORDER_TYPE_KEYS.length ? Array.from(new Set(types)) : null;
}

function normalizeRouteOrderTypes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const result = {};
  for (const route of ['kitchen', 'attendance', 'bar']) {
    const types = normalizeOrderTypes(raw[route]);
    if (types) result[route] = types;
  }
  return Object.keys(result).length > 0 ? result : null;
}

// Pedido de mesa lançado pelo garçom no app (espelho com hub_gestao_order_id): no
// automático só sai a via de produção. A comanda completa vai para o caixa quando
// o garçom pede o fechamento (mesma regra do web, isAppTableOrder).
function isAppTableOrder(order) {
  if (!order) return false;
  const fromApp = Boolean(order.hub_gestao_order_id ?? order.hubGestaoOrderId);
  return fromApp && orderTypeKey(order) === 'mesa';
}

function routeAcceptsOrder(normalizedMap, route, order) {
  if (route === 'attendance' && isAppTableOrder(order)) return false;
  const types = normalizedMap?.orderTypes?.[route];
  if (!types || !order) return true;
  return types.includes(orderTypeKey(order));
}

function normalizeAutoPrintMap(rawAutoPrint) {
  if (!rawAutoPrint || typeof rawAutoPrint !== 'object' || Array.isArray(rawAutoPrint)) {
    return null;
  }

  const kitchen = normalizePrinterValue(rawAutoPrint.kitchen);
  const attendance = normalizePrinterValue(rawAutoPrint.attendance) ||
    normalizePrinterValue(rawAutoPrint.counter) ||
    normalizePrinterValue(rawAutoPrint.balcao) ||
    normalizePrinterValue(rawAutoPrint.salao) ||
    normalizePrinterValue(rawAutoPrint.delivery);
  const bar = normalizePrinterValue(rawAutoPrint.bar) ||
    normalizePrinterValue(rawAutoPrint.bebida) ||
    normalizePrinterValue(rawAutoPrint.bebidas) ||
    normalizePrinterValue(rawAutoPrint.drinks);

  if (!kitchen && !attendance && !bar) {
    return null;
  }

  const orderTypes = normalizeRouteOrderTypes(rawAutoPrint.orderTypes);
  return {
    kitchen,
    attendance,
    counter: attendance,
    delivery: attendance,
    bar,
    ...(orderTypes ? { orderTypes } : {})
  };
}

function getAutoPrintPrinterForRoute(autoPrintMap, route) {
  const normalizedMap = normalizeAutoPrintMap(autoPrintMap);
  if (!normalizedMap) return null;

  const normalizedRoute = normalizeAutoPrintRoute(route);
  if (normalizedRoute === 'kitchen') return normalizedMap.kitchen || null;
  if (normalizedRoute === 'attendance') return normalizedMap.attendance || null;
  if (normalizedRoute === 'bar') return normalizedMap.bar || null;

  return null;
}

function buildAutoPrintRoutesForOrder(autoPrintMap, order = null, options = {}) {
  const normalizedMap = normalizeAutoPrintMap(autoPrintMap);
  if (!normalizedMap) return [];
  const selectedRoutes = Array.isArray(options.autoPrintRoutes) || typeof options.autoPrintRoutes === 'string'
    ? new Set(normalizeAutoPrintRoutes(options.autoPrintRoutes, {
      autoPrintType: options.autoPrintType,
      barPrintEnabled: options.barPrintEnabled === true
    }))
    : null;
  const routeOn = (route) => !selectedRoutes || selectedRoutes.has(route);
  const mapRoute = (route) => (route === 'counter' ? 'attendance' : route);
  const routeEnabled = (route) => routeOn(route) && routeAcceptsOrder(normalizedMap, mapRoute(route), order);

  const routes = [];
  if (routeEnabled('kitchen') && normalizedMap.kitchen) {
    routes.push({
      route: 'kitchen',
      printType: 'kitchen',
      printer: normalizedMap.kitchen
    });
  }

  if (routeEnabled('counter') && normalizedMap.attendance) {
    routes.push({
      route: 'attendance',
      printType: 'counter',
      printer: normalizedMap.attendance
    });
  }

  if (routeEnabled('bar') && options.barPrintEnabled === true && normalizedMap.bar) {
    routes.push({
      route: 'bar',
      printType: 'bar',
      printer: normalizedMap.bar
    });
  }

  return routes;
}

module.exports = {
  orderTypeKey,
  isAppTableOrder,
  buildLegacyAutoPrintRoutes,
  buildAutoPrintRoutesForOrder,
  getAutoPrintPrinterForRoute,
  getPrintTypeForRoute,
  normalizeAutoPrintRoutes,
  normalizeAutoPrintMap,
  normalizeAutoPrintRoute,
  normalizeLegacyPrinterType,
  normalizePrinterValue
};
