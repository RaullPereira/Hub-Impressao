const fs = require('fs');
const path = require('path');
const winston = require('winston');
const { app } = require('electron');

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

const renderLine = winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
  const renderedMessage = stack || message;
  const renderedMeta = Object.keys(meta).length > 0
    ? ` ${JSON.stringify(meta)}`
    : '';

  return `${timestamp} [${level}]: ${renderedMessage}${renderedMeta}`;
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

const logger = winston.createLogger({
  level: 'info',
  transports: [
    new winston.transports.Console({
      format: baseFormat
    }),
    new winston.transports.File({
      filename: getLogFilePath('app'),
      format: baseFormat
    }),
    new winston.transports.File({
      filename: getLogFilePath('error'),
      level: 'error',
      format: baseFormat
    }),
    new winston.transports.File({
      filename: getLogFilePath('print'),
      format: winston.format.combine(
        printOnly(),
        baseFormat
      )
    })
  ]
});

logger.getLogFilePath = getLogFilePath;
logger.getLogDirectory = ensureLogsDir;
logger.getRecentLogs = ({ type = 'print', limit = 200 } = {}) => {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const filePath = getLogFilePath(type);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-safeLimit);
};

module.exports = logger;
