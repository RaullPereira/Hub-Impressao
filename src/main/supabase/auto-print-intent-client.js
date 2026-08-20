'use strict';

function isMissingAutoPrintIntentRpc(error, rpcName) {
  if (error?.code !== 'PGRST202' && error?.code !== '42883') return false;

  const diagnostic = [error?.message, error?.details, error?.hint]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  const name = String(rpcName || '').toLowerCase();
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameIsExactIdentifier = new RegExp(
    `(?:^|[^a-z0-9_$])${escapedName}(?=$|[^a-z0-9_$])`,
    'i'
  ).test(diagnostic);

  return Boolean(name) && nameIsExactIdentifier && /(?:not found|does not exist|schema cache|could not find|missing)/.test(diagnostic);
}

function unavailableResolveError() {
  const error = new Error('Ação de intenção de impressão indisponível');
  error.code = 'AUTO_PRINT_INTENT_RESOLVE_UNAVAILABLE';
  return error;
}

class AutoPrintIntentClient {
  constructor(supabase) {
    this.supabase = supabase;
    this.available = true;
    this.claimAvailable = true;
    this.attentionListAvailable = true;
    this.resolveAvailable = true;
  }

  async call(name, args) {
    const { data, error } = await this.supabase.rpc(name, args);
    if (error) throw error;
    return Array.isArray(data) ? data : data ? [data] : [];
  }

  async claim(adminClientId, claimedBy, limit = 10, leaseSeconds = 90) {
    if (!this.claimAvailable) return [];

    try {
      return await this.call('claim_auto_print_intents', {
        p_admin_client_id: adminClientId,
        p_claimed_by: claimedBy,
        p_limit: limit,
        p_lease_seconds: leaseSeconds
      });
    } catch (error) {
      if (!isMissingAutoPrintIntentRpc(error, 'claim_auto_print_intents')) throw error;
      this.claimAvailable = false;
      this.available = false;
      return [];
    }
  }

  settle(intentId, leaseToken, outcome, lastError = null) {
    return this.call('settle_auto_print_intent', {
      p_intent_id: intentId,
      p_lease_token: leaseToken,
      p_outcome: outcome,
      p_last_error: lastError
    });
  }

  async resolve(intentId, action) {
    if (!this.resolveAvailable) throw unavailableResolveError();

    try {
      return await this.call('resolve_auto_print_intent', {
        p_intent_id: intentId,
        p_action: action
      });
    } catch (error) {
      if (!isMissingAutoPrintIntentRpc(error, 'resolve_auto_print_intent')) throw error;
      this.resolveAvailable = false;
      throw unavailableResolveError();
    }
  }

  async listAttention(adminClientId) {
    if (!this.attentionListAvailable) return [];

    const staleCutoff = new Date(Date.now() - 5 * 60_000).toISOString();

    const { data, error } = await this.supabase
      .from('auto_print_intents')
      .select('id,order_id,status,eligibility_reason,attempt_count,last_error,attention_reason,operator_retry_at,created_at,updated_at,orders(order_number)')
      .eq('admin_client_id', adminClientId)
      .or(`status.eq.attention,and(status.eq.pending,operator_retry_at.is.null,created_at.lt.${staleCutoff}),and(status.eq.pending,operator_retry_at.lt.${staleCutoff})`)
      .order('updated_at', { ascending: false })
      .limit(20);

    if (error?.code === '42P01' || error?.code === 'PGRST205') {
      this.attentionListAvailable = false;
      return [];
    }
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  }
}

module.exports = AutoPrintIntentClient;
module.exports.isMissingAutoPrintIntentRpc = isMissingAutoPrintIntentRpc;
