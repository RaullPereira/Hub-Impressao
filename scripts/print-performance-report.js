const fs = require('node:fs');

const MARKER = '[PRINT_PERF] ';
const STAGES = ['pickup', 'claim', 'render', 'queueWait', 'spool'];

function parsePrintPerformanceLines(content) {
  const records = [];

  for (const line of String(content || '').split(/\r?\n/)) {
    const markerIndex = line.indexOf(MARKER);
    if (markerIndex < 0) continue;

    try {
      const record = JSON.parse(line.slice(markerIndex + MARKER.length));
      if (record && typeof record === 'object' && !Array.isArray(record)) {
        records.push(record);
      }
    } catch {
      // Ignore unrelated or truncated log lines.
    }
  }

  return records;
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summarizePrintPerformance(records) {
  const printed = (Array.isArray(records) ? records : []).filter((record) => (
    record?.outcome === 'printed' &&
    typeof record.totalMs === 'number' &&
    Number.isFinite(record.totalMs) &&
    record.totalMs >= 0
  ));
  const totals = printed.map((record) => record.totalMs);
  const bottlenecks = {};

  for (const stage of STAGES) {
    const count = printed.filter((record) => record.slowestStage === stage).length;
    if (count > 0) {
      bottlenecks[stage] = count;
    }
  }

  return {
    count: totals.length,
    p50: percentile(totals, 0.5),
    p95: percentile(totals, 0.95),
    max: totals.length > 0 ? Math.max(...totals) : 0,
    bottlenecks
  };
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

function main(argv = process.argv.slice(2)) {
  const logPath = argv[0];
  if (!logPath) {
    throw new Error('Usage: node scripts/print-performance-report.js <app.log>');
  }

  const content = fs.readFileSync(logPath, 'utf8');
  process.stdout.write(`${createPrintPerformanceReport(content)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  createPrintPerformanceReport,
  formatPrintPerformanceReport,
  main,
  parsePrintPerformanceLines,
  percentile,
  summarizePrintPerformance
};
