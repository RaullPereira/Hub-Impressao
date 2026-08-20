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
  let cursor = null;

  for (;;) {
    let query = supabase
      .from('orders')
      .select('*')
      .eq('admin_client_id', adminClientId)
      .gte('created_at', sinceIso)
      .lte('created_at', untilIso)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });

    if (cursor) {
      query = query.or(
        `created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`
      );
    }

    const { data, error } = await query.limit(pageSize);

    if (error) {
      throw error;
    }

    const page = Array.isArray(data) ? data : [];
    pageCount += 1;
    orders.push(...page);

    if (page.length < pageSize) {
      break;
    }

    const lastOrder = page[page.length - 1];
    cursor = {
      createdAt: lastOrder.created_at,
      id: lastOrder.id
    };
  }

  return { orders, pageCount };
}

module.exports = { fetchRecoveryOrders };
