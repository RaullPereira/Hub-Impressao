const fs = require('fs');
const os = require('os');
const path = require('path');
const winston = require('winston');
const { app } = require('electron');

// Logs com tamanho limitado: sem rotacao o app.log passava de 100 MB e cada
// leitura da tela de logs carregava o arquivo inteiro no processo principal.
const LOG_LIMITS = {
  app: { maxsize: 5 * 1024 * 1024, maxFiles: 3 },
  error: { maxsize: 2 * 1024 * 1024, maxFiles: 2 },
  print: { maxsize: 2 * 1024 * 1024, maxFiles: 3 }
};
const MAX_LINE_LENGTH = 4000;
const RECENT_LOGS_TAIL_BYTES = 512 * 1024;

function ensureLogsDir() {
  const logsDir = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  return logsDir;
}

function getLogFilePath(type = 'app') {
  const logsDir = ensureLogsDir();

  if (type === 'error') {
    return path.join(logsDir, 'error.log');
  }

  if (type === 'print') {
    return path.join(logsDir, 'print.log');
  }

  return path.join(logsDir, 'app.log');
}

// Arquivos girados pelo winston (tailable): app.log e o mais novo, depois app1.log, app2.log.
function getRotatedLogFilePaths(type = 'app') {
  const current = getLogFilePath(type);
  const { dir, name, ext } = path.parse(current);
  const maxFiles = (LOG_LIMITS[type] || LOG_LIMITS.app).maxFiles;
  const files = [current];
  for (let index = 1; index < maxFiles; index += 1) {
    files.push(path.join(dir, `${name}${index}${ext}`));
  }
  return files;
}

// Os logs sao enviados para o suporte: tokens de sessao, chaves e o token do
// WebSocket nunca podem sair no texto.
function redactSecrets(text) {
  return String(text)
    .replace(/((?:\\?["'])?(?:access_token|refresh_token|anonKey|anon_key|apikey|apiKey|token|password|senha)(?:\\?["'])?\s*[:=]\s*\\?["']?)([^"'\\\s,}&]{4,})/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{10,}/g, '$1***')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'eyJ***');
}

function limitLine(text) {
  if (text.length <= MAX_LINE_LENGTH) return text;
  return `${text.slice(0, MAX_LINE_LENGTH)}... [cortado: ${text.length - MAX_LINE_LENGTH} caracteres]`;
}

const renderLine = winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
  const renderedMessage = stack || message;
  const renderedMeta = Object.keys(meta).length > 0
    ? ` ${JSON.stringify(meta)}`
    : '';

  return limitLine(redactSecrets(`${timestamp} [${level}]: ${renderedMessage}${renderedMeta}`));
});

const baseFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  renderLine
);

const printOnly = winston.format((info) => {
  const message = typeof info.message === 'string' ? info.message : '';
  return message.includes('[PRINT]') ? info : false;
});

function createFileTransport(type, extra = {}) {
  return new winston.transports.File({
    filename: getLogFilePath(type),
    maxsize: LOG_LIMITS[type].maxsize,
    maxFiles: LOG_LIMITS[type].maxFiles,
    tailable: true,
    ...extra
  });
}

// Hubs antigos nao giravam o log (ha arquivos com 100+ MB). Na primeira
// abertura desta versao, guarda so o final do arquivo.
function compactOversizedLog(type) {
  try {
    const filePath = getLogFilePath(type);
    if (!fs.existsSync(filePath)) return;
    const limit = LOG_LIMITS[type].maxsize;
    if (fs.statSync(filePath).size <= limit * 2) return;
    const tail = readFileTail(filePath, limit);
    fs.writeFileSync(filePath, `${new Date().toISOString()} [info]: Log antigo compactado (mantido só o final).\n${tail}`);
  } catch {
    // Nunca impedir o Hub de iniciar por causa do log.
  }
}
['app', 'error', 'print'].forEach(compactOversizedLog);

const logger = winston.createLogger({
  level: 'info',
  transports: [
    new winston.transports.Console({
      format: baseFormat
    }),
    createFileTransport('app', { format: baseFormat }),
    createFileTransport('error', { level: 'error', format: baseFormat }),
    createFileTransport('print', {
      format: winston.format.combine(
        printOnly(),
        baseFormat
      )
    })
  ]
});

// Le so o final do arquivo (nunca o arquivo inteiro).
function readFileTail(filePath, maxBytes) {
  if (!fs.existsSync(filePath)) return '';
  const { size } = fs.statSync(filePath);
  if (size === 0) return '';
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, size - length);
  } finally {
    fs.closeSync(fd);
  }
  const text = buffer.toString('utf8');
  // Descarta a primeira linha, que pode ter sido cortada no meio.
  return length < size ? text.slice(text.indexOf('\n') + 1) : text;
}

function readLogTailLines(type, maxBytes) {
  const lines = [];
  let remaining = maxBytes;
  for (const filePath of getRotatedLogFilePaths(type)) {
    if (remaining <= 0) break;
    if (!fs.existsSync(filePath)) continue;
    const size = fs.statSync(filePath).size;
    const chunk = readFileTail(filePath, remaining);
    remaining -= Math.min(size, remaining);
    const chunkLines = chunk.split(/\r?\n/).filter(Boolean);
    lines.unshift(...chunkLines);
  }
  return lines;
}

logger.getLogFilePath = getLogFilePath;
logger.getLogDirectory = ensureLogsDir;
logger.redactSecrets = redactSecrets;
logger.readLogTailLines = readLogTailLines;
logger.getRecentLogs = ({ type = 'print', limit = 200 } = {}) => {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const safeType = ['app', 'error', 'print'].includes(type) ? type : 'print';
  return readFileTail(getLogFilePath(safeType), RECENT_LOGS_TAIL_BYTES)
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-safeLimit);
};

// Arquivo unico em texto para o suporte: cabecalho com versao, sistema,
// pareamentos e impressoras + o final de cada log. Tudo passa pela mascara.
logger.buildDiagnosticReport = ({ appVersion = '', statuses = [], settingsSummary = null } = {}) => {
  const sections = [];
  sections.push([
    '=== Hub Impressão: diagnóstico ===',
    `Gerado em: ${new Date().toISOString()}`,
    `Versão: ${appVersion}`,
    `Sistema: ${process.platform} ${os.release()} (${process.arch})`,
    `Computador: ${os.hostname()}`,
    `Memória do Hub: ${Math.round(process.memoryUsage().rss / (1024 * 1024))} MB`,
    `Tempo ligado: ${Math.round(process.uptime() / 60)} min`
  ].join('\n'));

  sections.push(`=== Lojas pareadas ===\n${JSON.stringify(statuses, null, 2)}`);
  if (settingsSummary) {
    sections.push(`=== Configuração local ===\n${JSON.stringify(settingsSummary, null, 2)}`);
  }

  const tails = [
    ['error', 512 * 1024],
    ['print', 1024 * 1024],
    ['app', 3 * 1024 * 1024]
  ];
  for (const [type, maxBytes] of tails) {
    const lines = readLogTailLines(type, maxBytes);
    sections.push(`=== ${type}.log (últimas ${lines.length} linhas) ===\n${lines.join('\n')}`);
  }

  return redactSecrets(sections.join('\n\n'));
};

module.exports = logger;
