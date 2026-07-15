const { normalizeText } = require('./pedidoshub-formatter');

const CMD = {
  RESET: '\x1B@',
  LINE_SPACING_TIGHT_58MM: '\x1B\x33\x0E',
  FONT_A: '\x1BM\x00',
  TXT_NORMAL: '\x1D\x21\x00',
  ALIGN_LEFT: '\x1Ba\x00',
  CUT_FULL: '\x1DV\x41\x00'
};

const DEFAULT_MANUAL_TEXT_SETTINGS = {
  paperWidth: 32,
  feedLines: 2
};

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function resolveManualTextSettings(printSettings) {
  const settings = Object.assign({}, DEFAULT_MANUAL_TEXT_SETTINGS, printSettings || {});
  return {
    paperWidth: clampNumber(settings.paperWidth, 24, 48, DEFAULT_MANUAL_TEXT_SETTINGS.paperWidth),
    feedLines: clampNumber(settings.feedLines, 0, 3, DEFAULT_MANUAL_TEXT_SETTINGS.feedLines)
  };
}

function wrapManualTextLine(line, width) {
  const normalized = normalizeText(line).replace(/[ \t]+/g, ' ').trim();
  if (!normalized) return [''];

  const wrapped = [];
  let current = '';

  for (const word of normalized.split(' ')) {
    if (!word) continue;

    if (word.length > width) {
      if (current) {
        wrapped.push(current);
        current = '';
      }

      for (let index = 0; index < word.length; index += width) {
        wrapped.push(word.slice(index, index + width));
      }
      continue;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) {
      current = candidate;
    } else {
      if (current) wrapped.push(current);
      current = word;
    }
  }

  if (current) wrapped.push(current);
  return wrapped.length ? wrapped : [''];
}

function formatManualTextPrint(text, printSettings) {
  const settings = resolveManualTextSettings(printSettings);
  const normalizedText = normalizeText(text);
  const lines = normalizedText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .flatMap((line) => wrapManualTextLine(line, settings.paperWidth));

  const commandString = [
    CMD.RESET,
    CMD.LINE_SPACING_TIGHT_58MM,
    CMD.FONT_A,
    CMD.TXT_NORMAL,
    CMD.ALIGN_LEFT,
    lines.join('\n'),
    '\n'.repeat(settings.feedLines),
    CMD.CUT_FULL
  ].join('');

  return Buffer.from(commandString, 'latin1');
}

module.exports = {
  DEFAULT_MANUAL_TEXT_SETTINGS,
  formatManualTextPrint,
  resolveManualTextSettings,
  wrapManualTextLine
};
