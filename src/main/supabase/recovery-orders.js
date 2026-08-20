'use strict';

async function fetchRecoveryOrders({
  supabase,
  adminClientId,
  sinceIso,
  untilIso,
  pageSize = 50
}) {
  const orders = [];
  let pageCount = 0;

  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('admin_client_id', adminClientId)
      .gte('created_at', sinceIso)
      .lte('created_at', untilIso)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) {
      throw error;
    }

    const page = Array.isArray(data) ? data : [];
    pageCount += 1;
    orders.push(...page);

    if (page.length < pageSize) {
      break;
    }
  }

  return { orders, pageCount };
}

module.exports = { fetchRecoveryOrders };
