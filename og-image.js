/**
 * 社交平台链接预览图（OG / Twitter Card）
 * 1200×630（1.91:1）万能尺寸，头像对齐海报左上角预留圆框
 */
const Jimp = require('jimp');
const QRCode = require('qrcode');
const { POSTER_AVATAR_SLOT, INVITE_LANDING_AVATAR_SLOT, INSTAGRAM_STORY_AVATAR_SLOT, INSTAGRAM_STORY_QR_SLOT } = require('./poster-avatar-slot');
const {
  getAvatarInitial,
  needsRichTextRendering,
  renderInitialLetter,
} = require('./avatar-initial-text');

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const OG_SQUARE_SIZE = 1200;
const CANVAS_BG = 0xf8fafcff;

let fontsPromise;

function loadFonts() {
  if (!fontsPromise) {
    fontsPromise = Promise.all([
      Jimp.loadFont(Jimp.FONT_SANS_32_BLACK),
      Jimp.loadFont(Jimp.FONT_SANS_64_BLACK),
    ]).then(([avatarBlack, avatarLargeBlack]) => ({
      avatarBlack, avatarLargeBlack,
    }));
  }
  return fontsPromise;
}

async function buildGradientFallback(width = OG_WIDTH, height = OG_HEIGHT) {
  const img = new Jimp(width, height, 0x0f172aff);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = y / height;
      const r = Math.round(15 + t * 8);
      const g = Math.round(23 + t * 18);
      const b = Math.round(42 + t * 30);
      img.setPixelColor(Jimp.rgbaToInt(r, g, b, 255), x, y);
    }
  }
  return img;
}

async function loadPosterImage(posterUrl, width = OG_WIDTH, height = OG_HEIGHT) {
  if (!posterUrl) return buildGradientFallback(width, height);
  try {
    return await Jimp.read(posterUrl);
  } catch {
    return buildGradientFallback(width, height);
  }
}

/** object-fit: cover — 横版 1200×630；方版等比缩放至目标尺寸（避免裁切偏移槽位） */
async function composePosterCanvas(posterUrl, width = OG_WIDTH, height = OG_HEIGHT) {
  const canvas = new Jimp(width, height, CANVAS_BG);
  const poster = await loadPosterImage(posterUrl, width, height);
  const srcAr = poster.bitmap.width / poster.bitmap.height;
  const targetAr = width / height;
  if (Math.abs(srcAr - targetAr) < 0.02) {
    poster.resize(width, height);
  } else {
    poster.cover(width, height);
  }
  canvas.composite(poster, 0, 0);
  return { canvas, posterX: 0, posterY: 0, posterW: width, posterH: height };
}

function fillCircleGradient(target, size, r, c1, c2) {
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const dx = px - r;
      const dy = py - r;
      if (Math.sqrt(dx * dx + dy * dy) > r) continue;
      const t = Math.min(1, (px * 0.6 + py * 0.9) / (size * 1.15));
      const red = Math.round(c1.r + (c2.r - c1.r) * t);
      const green = Math.round(c1.g + (c2.g - c1.g) * t);
      const blue = Math.round(c1.b + (c2.b - c1.b) * t);
      target.setPixelColor(Jimp.rgbaToInt(red, green, blue, 255), px, py);
    }
  }
}

function drawAvatarRing(img, ring, cx, cy) {
  img.composite(ring, Math.round(cx - ring.bitmap.width / 2), Math.round(cy - ring.bitmap.height / 2));
}

async function drawInitialAvatar(img, initial, cx, cy, size, fontLarge) {
  const avatar = new Jimp(size, size, 0x00000000);
  const ring = new Jimp(size + 8, size + 8, 0x00000000);
  const r = size / 2;
  const rr = r + 4;

  fillCircleGradient(avatar, size, r, { r: 0, g: 248, b: 208 }, { r: 0, g: 248, b: 208 });

  for (let py = 0; py < size + 8; py++) {
    for (let px = 0; px < size + 8; px++) {
      const dx = px - rr;
      const dy = py - rr;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= rr && dist > r) ring.setPixelColor(0xffffffff, px, py);
    }
  }

  ring.composite(avatar, 4, 4);
  const letter = new Jimp(size, size, 0x00000000);
  if (needsRichTextRendering(initial)) {
    const richBuffer = await renderInitialLetter(initial, size);
    if (richBuffer) {
      const richLetter = await Jimp.read(richBuffer);
      letter.composite(richLetter, 0, 0);
    }
  } else {
    const textW = Jimp.measureText(fontLarge, initial);
    const textH = Jimp.measureTextHeight(fontLarge, initial, textW);
    letter.print(
      fontLarge,
      Math.max(0, (size - textW) / 2),
      Math.max(0, (size - textH) / 2 - 1),
      initial
    );
  }
  ring.composite(letter, 4, 4);
  drawAvatarRing(img, ring, cx, cy);
}

async function drawPhotoAvatar(img, avatarSource, cx, cy, size, config = {}, options = {}) {
  const { isAllowedAvatarUrl } = require('./avatar-url');
  if (!isAllowedAvatarUrl(avatarSource, config)) {
    throw new Error('Avatar URL not allowed');
  }
  const frameless = options.frameless === true;
  const r = size / 2;
  const photo = await Jimp.read(avatarSource);
  const plate = new Jimp(size, size, 0x00000000);
  if (frameless) {
    const fitted = photo.clone();
    fitted.scaleToFit(size, size);
    plate.composite(
      fitted,
      Math.round((size - fitted.bitmap.width) / 2),
      Math.round((size - fitted.bitmap.height) / 2),
    );
  } else {
    photo.cover(size, size);
    plate.composite(photo, 0, 0);
  }

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const dx = px - r;
      const dy = py - r;
      if (Math.sqrt(dx * dx + dy * dy) > r) {
        plate.setPixelColor(0x00000000, px, py);
      }
    }
  }

  if (frameless) {
    drawAvatarRing(img, plate, cx, cy);
    return;
  }

  const rr = r + 4;
  const ring = new Jimp(size + 8, size + 8, 0x00000000);
  for (let py = 0; py < size + 8; py++) {
    for (let px = 0; px < size + 8; px++) {
      const dx = px - rr;
      const dy = py - rr;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= rr && dist > r) ring.setPixelColor(0xffffffff, px, py);
    }
  }
  ring.composite(plate, 4, 4);
  drawAvatarRing(img, ring, cx, cy);
}

async function drawInviteQr(img, inviteUrl, posterW, posterH, qrSlot = INSTAGRAM_STORY_QR_SLOT) {
  const url = String(inviteUrl || '').trim();
  if (!url || !qrSlot) return;
  const qrSize = Math.max(48, Math.round(posterH * qrSlot.size));
  const qrBuffer = await QRCode.toBuffer(url, {
    type: 'png',
    width: qrSize,
    margin: 0,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  });
  const qr = await Jimp.read(qrBuffer);
  const pad = Math.max(6, Math.round(qrSize * 0.05));
  const plate = new Jimp(qrSize + pad * 2, qrSize + pad * 2, 0xffffffff);
  plate.composite(qr, pad, pad);
  const cx = posterW * qrSlot.cx;
  const cy = posterH * qrSlot.cy;
  const plateSize = plate.bitmap.width;
  img.composite(plate, Math.round(cx - plateSize / 2), Math.round(cy - plateSize / 2));
}

async function generateOgImage({
  name, posterUrl, avatarPath, avatarUrl, config = {},
  shape = 'landscape',
  avatarSlot,
  inviteUrl,
  qrSlot,
}) {
  const avatarSource = avatarUrl || avatarPath || '';
  const initial = getAvatarInitial(name);
  const fonts = await loadFonts();

  const isSquare = shape === 'square';
  const width = isSquare ? OG_SQUARE_SIZE : OG_WIDTH;
  const height = isSquare ? OG_SQUARE_SIZE : OG_HEIGHT;
  const { canvas, posterX, posterY, posterW, posterH } = await composePosterCanvas(posterUrl, width, height);

  const slot = avatarSlot || (isSquare ? INSTAGRAM_STORY_AVATAR_SLOT : POSTER_AVATAR_SLOT);
  const avatarSize = Math.max(48, Math.round(posterH * slot.size));
  const avatarCx = posterX + posterW * slot.cx;
  const avatarCy = posterY + posterH * slot.cy;

  const avatarFont = avatarSize >= 100 ? fonts.avatarLargeBlack : fonts.avatarBlack;
  const avatarOpts = isSquare ? { frameless: true } : {};
  if (avatarSource) {
    try {
      await drawPhotoAvatar(canvas, avatarSource, avatarCx, avatarCy, avatarSize, config, avatarOpts);
    } catch {
      await drawInitialAvatar(canvas, initial, avatarCx, avatarCy, avatarSize, avatarFont);
    }
  } else {
    await drawInitialAvatar(canvas, initial, avatarCx, avatarCy, avatarSize, avatarFont);
  }

  if (isSquare && inviteUrl) {
    await drawInviteQr(canvas, inviteUrl, posterW, posterH, qrSlot || INSTAGRAM_STORY_QR_SLOT);
  }

  return canvas.quality(90).getBufferAsync(Jimp.MIME_JPEG);
}

module.exports = {
  OG_WIDTH,
  OG_HEIGHT,
  OG_SQUARE_SIZE,
  generateOgImage,
};
