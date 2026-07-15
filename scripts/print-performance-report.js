const fs = require('node:fs');
const readline = require('node:readline');

const MARKER = '[PRINT_PERF] ';
const STAGES = ['pickup', 'claim', 'render', 'queueWait', 'spool'];

function parsePrintPerformanceLine(line) {
  const markerIndex = String(line || '').indexOf(MARKER);
  if (markerIndex < 0) return null;

  try {
    const record = JSON.parse(String(line).slice(markerIndex + MARKER.length));
    return record && typeof record === 'object' && !Array.isArray(record)
      ? record
      : null;
  } catch {
    return null;
  }
}

function parsePrintPerformanceLines(content) {
  const records = [];

  for (const line of String(content || '').split(/\r?\n/)) {
    const record = parsePrintPerformanceLine(line);
    if (record) records.push(record);
  }

  return records;
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function createPrintPerformanceAccumulator() {
  return {
    totals: [],
    bottlenecks: Object.fromEntries(STAGES.map((stage) => [stage, 0]))
  };
}

function addPrintPerformanceRecord(accumulator, record) {
  if (!(
    record?.outcome === 'printed' &&
    typeof record.totalMs === 'number' &&
    Number.isFinite(record.totalMs) &&
    record.totalMs >= 0
  )) {
    return;
  }

  accumulator.totals.push(record.totalMs);
  if (STAGES.includes(record.slowestStage)) {
    accumulator.bottlenecks[record.slowestStage] += 1;
  }
}

function summarizePrintPerformanceAccumulator(accumulator) {
  const totals = accumulator.totals;
  const bottlenecks = {};

  for (const stage of STAGES) {
    const count = accumulator.bottlenecks[stage];
    if (count > 0) {
      bottlenecks[stage] = count;
    }
  }

  const max = totals.reduce((currentMax, value) => (
    value > currentMax ? value : currentMax
  ), 0);

  return {
    count: totals.length,
    p50: percentile(totals, 0.5),
    p95: percentile(totals, 0.95),
    max,
    bottlenecks
  };
}

function summarizePrintPerformance(records) {
  const accumulator = createPrintPerformanceAccumulator();
  for (const record of Array.isArray(records) ? records : []) {
    addPrintPerformanceRecord(accumulator, record);
  }
  return summarizePrintPerformanceAccumulator(accumulator);
}

async function summarizePrintPerformanceStream(input) {
  const accumulator = createPrintPerformanceAccumulator();
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    const record = parsePrintPerformanceLine(line);
    if (record) addPrintPerformanceRecord(accumulator, record);
  }

  return summarizePrintPerformanceAccumulator(accumulator);
}

function formatPrintPerformanceReport(summary) {
  const bottlenecks = Object.entries(summary.bottlenecks || {})
    .map(([stage, count]) => `${stage}=${count}`)
    .join(', ');

  return [
    `count=${summary.count}`,
    `p50=${summary.p50}ms`,
    `p95=${summary.p95}ms`,
    `max=${summary.max}ms`,
    `bottlenecks: ${bottlenecks || 'none'}`
  ].join('\n');
}

function createPrintPerformanceReport(content) {
  return formatPrintPerformanceReport(
    summarizePrintPerformance(parsePrintPerformanceLines(content))
  );
}

async function main(argv = process.argv.slice(2)) {
  const logPath = argv[0];
  if (!logPath) {
    throw new Error('Usage: node scripts/print-performance-report.js <app.log>');
  }

  const input = fs.createReadStream(logPath, { encoding: 'utf8' });
  const summary = await summarizePrintPerformanceStream(input);
  process.stdout.write(`${formatPrintPerformanceReport(summary)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createPrintPerformanceReport,
  formatPrintPerformanceReport,
  main,
  parsePrintPerformanceLine,
  parsePrintPerformanceLines,
  percentile,
  summarizePrintPerformance,
  summarizePrintPerformanceStream
};
