const { performance } = require('node:perf_hooks');

const STAGES = ['pickup', 'claim', 'render', 'queueWait', 'spool'];
const OUTCOMES = new Set(['printed', 'skipped', 'failed']);
const ACCEPTED_SOURCES = new Set(['realtime_update_accepted', 'recovery_accept']);

let traceSequence = 0;

function toNonNegativeNumber(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? Math.max(0, normalized) : 0;
}

function toText(value) {
  return value == null ? '' : String(value);
}

function createPrintTraceId(now = Date.now()) {
  traceSequence = (traceSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${toNonNegativeNumber(now).toString(36)}-${process.pid.toString(36)}-${traceSequence.toString(36)}`;
}

function calculatePickupMs(order, source, handlerStartedAt = Date.now()) {
  const timestamp = ACCEPTED_SOURCES.has(toText(source))
    ? order?.updated_at ?? order?.updatedAt
    : order?.created_at ?? order?.createdAt;
  const eligibleAt = Date.parse(toText(timestamp));
  const startedAt = Number(handlerStartedAt);

  if (!Number.isFinite(eligibleAt) || !Number.isFinite(startedAt)) {
    return 0;
  }

  return Math.max(0, startedAt - eligibleAt);
}

function buildPrintPerformanceRecord(base = {}, timings = {}) {
  const values = Object.fromEntries(STAGES.map((stage) => [
    stage,
    toNonNegativeNumber(timings[`${stage}Ms`])
  ]));
  const slowestStage = STAGES.reduce((slowest, stage) => (
    values[stage] > values[slowest] ? stage : slowest
  ));
  const suppliedTotal = Number(timings.totalMs);
  const totalMs = Number.isFinite(suppliedTotal)
    ? Math.max(0, suppliedTotal)
    : STAGES.reduce((sum, stage) => sum + values[stage], 0);
  const record = {
    traceId: toText(base.traceId),
    orderId: toText(base.orderId),
    source: toText(base.source),
    outcome: OUTCOMES.has(base.outcome) ? base.outcome : 'printed',
    pickupMs: values.pickup,
    claimMs: values.claim,
    renderMs: values.render,
    queueWaitMs: values.queueWait,
    spoolMs: values.spool,
    totalMs,
    slowestStage
  };

  if (base.storeId != null && toText(base.storeId)) {
    record.storeId = toText(base.storeId);
  }
  if (base.via != null && toText(base.via)) {
    record.via = toText(base.via);
  }
  if (base.printer != null && toText(base.printer)) {
    record.printer = toText(base.printer);
  }

  return {
    traceId: record.traceId,
    ...(record.storeId ? { storeId: record.storeId } : {}),
    orderId: record.orderId,
    ...(record.via ? { via: record.via } : {}),
    ...(record.printer ? { printer: record.printer } : {}),
    source: record.source,
    outcome: record.outcome,
    pickupMs: record.pickupMs,
    claimMs: record.claimMs,
    renderMs: record.renderMs,
    queueWaitMs: record.queueWaitMs,
    spoolMs: record.spoolMs,
    totalMs: record.totalMs,
    slowestStage: record.slowestStage
  };
}

function createPrintTelemetry(base, now = () => performance.now()) {
  const startedAt = now();

  return {
    finish(timings = {}) {
      return buildPrintPerformanceRecord(base, {
        ...timings,
        totalMs: timings.totalMs ?? (now() - startedAt)
      });
    }
  };
}

function emitPrintPerformance(logger, base, timings = {}) {
  try {
    const record = buildPrintPerformanceRecord(base, timings);
    logger.info('[PRINT_PERF] ' + JSON.stringify(record));
    return record;
  } catch {
    return null;
  }
}

module.exports = {
  STAGES,
  buildPrintPerformanceRecord,
  calculatePickupMs,
  createPrintTelemetry,
  createPrintTraceId,
  emitPrintPerformance
};
