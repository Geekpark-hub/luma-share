/**
 * 头像首字渲染（支持中文等 CJK；Jimp 内置位图字体仅 ASCII）
 */
const path = require('path');
const fs = require('fs');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const FONT_FAMILY = 'AvatarInitial';
let fontRegistered = false;

const FONT_CANDIDATES = [
  path.join(__dirname, 'assets', 'fonts', 'NotoSansSC-Regular.otf'),
  path.join(__dirname, 'assets', 'fonts', 'NotoSansSC-Regular.ttf'),
  '/usr/share/fonts/opentype/noto/NotoSansSC-Regular.otf',
  '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  'C:\\Windows\\Fonts\\msyh.ttc',
  'C:\\Windows\\Fonts\\msyhbd.ttc',
];

function getAvatarInitial(name) {
  const n = String(name || 'A').trim();
  if (!n) return 'A';
  const ch = n.charAt(0).toUpperCase();
  if (/[A-Z0-9\u4e00-\u9fff]/.test(ch)) return ch;
  return 'A';
}

function needsRichTextRendering(initial) {
  return /[^\x00-\x7F]/.test(String(initial || ''));
}

function ensureFont() {
  if (fontRegistered) return true;
  for (const fontPath of FONT_CANDIDATES) {
    if (!fontPath || !fs.existsSync(fontPath)) continue;
    try {
      GlobalFonts.registerFromPath(fontPath, FONT_FAMILY);
      fontRegistered = true;
      return true;
    } catch {
      // try next candidate
    }
  }
  return false;
}

async function renderInitialLetter(initial, size) {
  const letter = String(initial || 'A').trim().charAt(0) || 'A';
  if (!needsRichTextRendering(letter)) return null;
  if (!ensureFont()) return null;

  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  const fontSize = Math.max(12, Math.round(size * 0.46));
  ctx.font = `600 ${fontSize}px "${FONT_FAMILY}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, size / 2, size / 2 + Math.round(size * 0.02));
  return canvas.toBuffer('image/png');
}

module.exports = {
  FONT_FAMILY,
  getAvatarInitial,
  needsRichTextRendering,
  renderInitialLetter,
};
