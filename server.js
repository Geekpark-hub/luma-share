/**
 * Luma Webhook 轻量服务
 * 技术栈：Node.js + Express + better-sqlite3 + nodemailer
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const multer = require('multer');
const nodemailer = require('nodemailer');
const config = require('./config');
const {
  APP_VERSION,
  DEFAULT_SHARE_MESSAGE,
  DEFAULT_POSTER_SLOGAN,
  DEFAULT_EMAIL_SUBJECT,
  PLATFORM_SHARE_MESSAGES,
  LEGACY_POSTER_SLOGANS,
  EVENT_SUBLINE,
  LEGACY_SHARE_MESSAGES,
  stripShareLinkPlaceholder,
  normalizeShareTemplateText,
  isLegacyShareMessage,
} = require('./version');
const { POSTER_AVATAR_SLOT, INVITE_LANDING_AVATAR_SLOT, INSTAGRAM_STORY_AVATAR_SLOT } = require('./poster-avatar-slot');
const { OG_WIDTH, OG_HEIGHT, generateOgImage } = require('./og-image');
const {
  isLumaApiConfigured, addGuestsToEvent, getGuestOnEvent, isLumaGuestJoined, getEventById,
} = require('./luma-api');
const { uploadImageBuffer } = require('./image-upload');
const { buildGaHeadHtml } = require('./ga-snippet');
const { isAllowedAvatarUrl, sanitizeAvatarUrl, sanitizeDisplayText } = require('./avatar-url');
const {
  verifyShareUid, isShareLinkSecretConfigured, buildSharePageUrl, signShareUid,
} = require('./share-auth');
const {
  initDatabase, saveRegistrant, removeRegistrantByEmail, isWelcomeEmailSent, markWelcomeEmailSent,
  tryClaimWelcomeEmailSend, releaseWelcomeEmailSendClaim,
  logShareEvent, logTicketEvent, getStats, getReferrerStats,
  getRegistrantByReferralId, saveShareAvatar, getShareAvatar, saveShareMessage, getShareMessage,
  savePosterSlogan, getPosterSlogan,
  saveShareDisplayName, getShareDisplayName, saveShareDisplayCompany, getShareDisplayCompany,
  getRegistrantByEmail, hasActiveMainEventRegistration,
  getSideEventRsvp, listSideEventRsvpsForUser, saveSideEventRsvp, deleteSideEventRsvp,
  deleteSideEventRsvpByEmail,
  closeDatabase, flushPersist,
  recoverDatabaseFromDisk, isSqlWasmError,
  ensureSeedRegistrant,
  listPartnerPages, getPartnerPage, savePartnerPage, deletePartnerPage,
} = require('./db');
const { buildEmailText, buildEmailHtml } = require('./email-content');

const app = express();

// 部署在 Nginx 等反向代理后，信任第一层代理的 X-Forwarded-*（避免 rate-limit 安全告警）
app.set('trust proxy', 1);

/** 公开 API 限流（生产默认开启；本地调试可设 RATE_LIMIT=1 强制启用） */
function isRateLimitEnabled() {
  return isProduction() || process.env.RATE_LIMIT === '1';
}

function createRouteLimiter({ windowMs, max, message }) {
  if (!isRateLimitEnabled()) {
    return (_req, _res, next) => next();
  }
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res, _next, options) => {
      res.status(options.statusCode).json({
        success: false,
        message: message || '请求过于频繁，请稍后再试',
      });
    },
  });
}

const ogLimiter = createRouteLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: 'OG 图片请求过于频繁，请稍后再试',
});
const readApiLimiter = createRouteLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: '读取请求过于频繁，请稍后再试',
});
const trackLimiter = createRouteLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: '统计上报过于频繁，请稍后再试',
});
const webhookLimiter = createRouteLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Webhook 请求过于频繁',
});
const uploadLimiter = createRouteLimiter({
  windowMs: 60 * 1000,
  max: 5,
  message: '头像上传过于频繁，请稍后再试',
});
const profileWriteLimiter = createRouteLimiter({
  windowMs: 60 * 1000,
  max: 15,
  message: '分享资料更新过于频繁，请稍后再试',
});
const verifyAccessLimiter = createRouteLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: '校验请求过于频繁，请稍后再试',
});

const SHARER_TRACK_CHANNELS = new Set([
  'page_view', 'copy', 'download', 'linkedin', 'email', 'whatsapp', 'x', 'instagram',
]);

// 解析 JSON 请求体
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// share.html 随版本更新，避免 CDN/浏览器长期缓存旧页面
app.use((req, res, next) => {
  if (req.path === '/share.html') {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

const AVATAR_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|jpg|png|webp|gif)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error('仅支持 JPG/PNG/WebP/GIF 图片'));
  },
});

/** 只允许字母数字与常见安全字符，防止路径穿越 */
function sanitizeUid(uid) {
  const safe = String(uid || '').trim().replace(/[^a-zA-Z0-9._-]/g, '');
  return safe || '';
}

function sanitizePartnerSlug(slug) {
  const raw = String(slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!raw || raw.length > 48) return '';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(raw)) return '';
  return raw;
}

const UTM_CHANNEL_PREFIXES = ['copy', 'download', 'linkedin', 'email', 'whatsapp', 'x', 'instagram', 'invite', 'partner'];
const WEAK_SHARE_SECRETS = new Set([
  'agi-share-dev-secret-change-me',
  'change-me-to-a-long-random-secret',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getWebhookSecret() {
  return String(process.env.WEBHOOK_SECRET || config.webhookSecret || '').trim();
}

function getStatsCredentials() {
  return {
    user: String(process.env.STATS_USER || config.statsAuth?.user || '').trim(),
    pass: String(process.env.STATS_PASS || config.statsAuth?.pass || '').trim(),
  };
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/** Webhook 密钥校验（优先 Header，兼容 Luma URL ?secret= 回退） */
function verifyWebhookRequest(req) {
  const secret = getWebhookSecret();
  if (!secret) {
    if (isProduction()) {
      console.warn('[Webhook] 生产环境未配置 webhookSecret，已拒绝回调');
      return false;
    }
    return true;
  }

  const header = String(req.headers['x-webhook-secret'] || '').trim();
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const query = String(req.query.secret || '').trim();
  const token = header || bearer || query;
  return token === secret;
}

/** 统计看板 Basic Auth（仅 API 使用，不返回 WWW-Authenticate，避免浏览器原生弹窗） */
function requireStatsAuth(req, res, next) {
  const { user, pass } = getStatsCredentials();
  if (!user || !pass) {
    if (isProduction()) {
      res.status(503).json({ success: false, message: 'statsAuth 未配置' });
      return;
    }
    next();
    return;
  }

  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Basic ')) {
    res.status(401).json({ success: false, message: '需要登录' });
    return;
  }

  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  const u = sep >= 0 ? decoded.slice(0, sep) : decoded;
  const p = sep >= 0 ? decoded.slice(sep + 1) : '';
  if (u === user && p === pass) {
    next();
    return;
  }

  res.status(401).json({ success: false, message: '认证失败' });
}

// 根路径 → 统计看板
app.get('/', (_req, res) => {
  res.redirect(302, '/stats.html');
});

// 静态资源（stats.html 由页面内自定义登录；API 仍走 Basic Auth）
app.use(express.static(path.join(__dirname, 'public')));

function resolveInviteDisplayName(uid, registrant, queryName) {
  const fromShare = sanitizeDisplayText(getShareDisplayName(uid), 80);
  if (fromShare) return fromShare;
  if (registrant?.name) return sanitizeDisplayText(registrant.name, 80);
  return sanitizeDisplayText(queryName || 'A friend', 80) || 'A friend';
}

function resolveInviteDisplayCompany(uid, registrant, queryCompany, fallback) {
  const fromShare = sanitizeDisplayText(getShareDisplayCompany(uid), 120);
  if (fromShare) return fromShare;
  if (registrant?.company) return sanitizeDisplayText(registrant.company, 120);
  const fromQuery = sanitizeDisplayText(queryCompany, 120);
  return fromQuery || sanitizeDisplayText(fallback, 120) || fallback;
}

/** 公开读 API：无效 uid / 无效 sig / 未注册统一 404，降低枚举差异 */
function guardRegisteredShareRead(res, uid, sig) {
  const safe = sanitizeUid(uid);
  if (!safe || !verifyShareUid(safe, sig)) {
    sendNotFoundApi(res);
    return null;
  }
  const registrant = requireRegisteredUid(safe);
  if (!registrant) {
    sendNotFoundApi(res);
    return null;
  }
  return registrant;
}

function decodeQueryParam(raw) {
  if (raw == null || raw === '') return '';
  try {
    return decodeURIComponent(String(raw));
  } catch {
    return String(raw);
  }
}

/** 邀请落地页：从 URL note 参数读取分享者自定义文案 */
function resolveInviteNote(queryNote) {
  let note = decodeQueryParam(queryNote).trim();
  return sanitizeInviteDisplayNote(note);
}

/** 落地页展示用：去掉链接占位等，保留完整分享文案 */
function sanitizeInviteDisplayNote(raw) {
  let note = String(raw || '').trim();
  if (!note) return '';
  note = note
    .replace(/\n*Join me with my personal invite link below\.?\n*/gi, '\n')
    .replace(/\n*https?:\/\/[^\s]+/gi, '\n')
    .trim();
  if (note.length > 1200) note = `${note.slice(0, 1197)}…`;
  return note;
}

function resolveInviteDisplayNote(uid, queryNote) {
  const stored = sanitizeInviteDisplayNote(getShareMessage(uid));
  if (stored) return stored;
  const fromUrl = resolveInviteNote(queryNote);
  if (fromUrl) return fromUrl;
  return defaultInviteNoteExcerpt();
}

function resolveInvitePosterSlogan(uid) {
  const stored = String(getPosterSlogan(uid) || '').trim();
  if (stored) return stored;
  return String(DEFAULT_POSTER_SLOGAN || "I'm going!").trim();
}

/** 统计/传播展示名：分享页自定义优先于报名姓名 */
function resolveSharerDisplayName(uid, registrant) {
  const fromShare = String(getShareDisplayName(uid) || '').trim();
  if (fromShare) return fromShare;
  return String(registrant?.name || '').trim();
}

let statsCache = { byRange: {}, at: 0 };
const STATS_CACHE_MS = 60000;
let statsQueryBusy = false;

function invalidateStatsCache() {
  statsCache = { byRange: {}, at: 0 };
}

function respondWithStatsCache(res, req, range, extra = {}) {
  const cached = statsCache.byRange[range];
  if (!cached) return false;
  res.json(enrichStatsResponse({ ...cached, ...extra }, req));
  return true;
}

function normalizeStatsRange(range) {
  const key = String(range || 'all').toLowerCase();
  return ['day', 'week', 'all'].includes(key) ? key : 'all';
}

function enrichStatsResponse(raw, req) {
  const siteBase = resolveSiteBaseUrl(req);
  const withUrls = (row, uidKey = 'sharer_uid', nameKey = 'sharer_name') => {
    const uid = String(row[uidKey] || '').trim();
    const displayName = getShareDisplayName(uid) || row[nameKey] || '';
    const displayCompany = getShareDisplayCompany(uid) || '';
    return {
      ...row,
      [nameKey]: displayName || row[nameKey],
      invite_url: uid ? buildInviteLandingUrl(uid, siteBase, 'invite') : '',
      share_url: uid && isShareLinkSecretConfigured()
        ? buildSharePageUrl(displayName, uid, siteBase, displayCompany)
        : '',
    };
  };
  const withReferrerName = (row) => {
    const uid = String(row.referrer_uid || row.referred_by || '').trim();
    if (!uid) return row;
    const displayName = getShareDisplayName(uid) || row.referrer_name || '';
    return { ...row, referrer_name: displayName || row.referrer_name };
  };

  return {
    ...raw,
    shareByUser: (raw.shareByUser || []).map((r) => withUrls(r)),
    pageViewsByUser: (raw.pageViewsByUser || []).map((r) => withUrls(r)),
    referralLeaderboard: (raw.referralLeaderboard || []).map(withReferrerName),
    ticketByReferrer: (raw.ticketByReferrer || []).map(withReferrerName),
    recentRegistrants: (raw.recentRegistrants || []).map(withReferrerName),
    inviteFunnelByUser: (raw.inviteFunnelByUser || []).map((r) => withReferrerName({
      ...r,
      referrer_uid: r.referrer_uid || r.referred_by,
    })),
  };
}

function recordShareTrackEvent({ sharer_uid, sharer_name, channel, utm_source, visitor_id }) {
  logShareEvent({ sharer_uid, sharer_name, channel, visitor_id });
  if (channel === 'invite_view' && utm_source) {
    const { register_channel } = parseUtmSource(utm_source);
    if (register_channel && register_channel !== 'invite') {
      logShareEvent({
        sharer_uid,
        sharer_name,
        channel: `invite_inbound_${register_channel}`,
        visitor_id,
      });
    }
  }
  invalidateStatsCache();
}

function invitePosterSubline(name) {
  const line = String(EVENT_SUBLINE || 'Your dates · Your city · Your venue').trim();
  const parts = line.split('·').map((s) => s.trim()).filter(Boolean);
  let datePart = parts[0] || 'Your dates';
  datePart = datePart.replace(/,\s*\d{4}$/, '').trim();
  const place = parts[1] || 'Your City';
  const safeName = String(name || 'friend').trim() || 'friend';
  return `${safeName} · ${datePart} · ${place}`;
}

function shouldShowInviteDetailNote(slogan, note) {
  const s = String(slogan || '').trim();
  const n = String(note || '').trim();
  if (!n) return false;
  if (!s) return true;
  if (n === s) return false;
  const normalizedNote = n.replace(/\s+/g, ' ').toLowerCase();
  const normalizedSlogan = s.replace(/\s+/g, ' ').toLowerCase();
  if (normalizedNote === normalizedSlogan) return false;
  if (normalizedNote.startsWith(normalizedSlogan)) return normalizedNote.length > normalizedSlogan.length + 12;
  return true;
}

function resolveInviteQuoteMain(noteText, sloganText) {
  const note = String(noteText || '').trim();
  const slogan = String(sloganText || '').trim();
  if (note) {
    const first = note.split('\n\n')[0].trim();
    return first.length > 320 ? `${first.slice(0, 317)}…` : first;
  }
  return slogan || defaultInviteNoteExcerpt();
}

function resolveInviteQuoteExtra(noteText, sloganText) {
  const note = String(noteText || '').trim();
  const slogan = String(sloganText || '').trim();
  const main = resolveInviteQuoteMain(noteText, sloganText);
  const extras = [];
  if (note.includes('\n\n')) {
    const rest = note.split('\n\n').slice(1).join('\n\n').trim();
    if (rest) extras.push(rest);
  }
  if (slogan && slogan !== main && !main.includes(slogan)) {
    extras.unshift(`"${slogan}"`);
  }
  return extras.join('\n\n');
}

function buildEnvelopeWaxHtml(avatarUrl, avatarInitial) {
  const safeAvatarUrl = escapeHtml(avatarUrl || '');
  if (safeAvatarUrl) {
    return `<div class="envelope-wax envelope-wax-photo"><img src="${safeAvatarUrl}" alt="" referrerpolicy="no-referrer" decoding="async" /></div>`;
  }
  return `<div class="envelope-wax">${escapeHtml(avatarInitial)}</div>`;
}

function defaultInviteNoteExcerpt() {
  const first = String(DEFAULT_SHARE_MESSAGE || '').split('\n\n')[0].trim();
  return first || 'Your Event 2026 is coming up in Your City — join me at Your Venue.';
}

function formatInviteNoteHtml(note) {
  return escapeHtml(note).replace(/\n/g, '<br>');
}

function clampInviteText(text, maxLen = 280) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

function summarizeWebhookPayload(payload) {
  try {
    const meta = normalizeWebhookPayload(payload);
    const event = resolveWebhookEvent(payload) || extractLumaEvent(payload);
    return {
      type: payload?.type || 'unknown',
      email: meta.email || '',
      referral_id: meta.referral_id || '',
      approval_status: meta.approval_status || '',
      invited_at: meta.invited_at || '',
      registered_at: meta.registered_at || '',
      coupon_applied: !!meta.coupon_applied,
      user_confirmed: hasUserCompletedRegistration(meta),
      event_url: event?.url || '',
    };
  } catch {
    return {
      type: payload?.type || 'unknown',
      email: '',
      referral_id: '',
      approval_status: '',
      invited_at: '',
      registered_at: '',
      coupon_applied: false,
      user_confirmed: false,
      event_url: '',
    };
  }
}

/**
 * 创建飞书 SMTP 邮件传输器
 */
function createMailTransporter() {
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
  });
}

function validateConfig() {
  const warnings = [];
  const fatal = [];

  if (!config.smtp.user || config.smtp.user.includes('【')) {
    warnings.push('smtp.user 未配置');
  }
  if (!config.smtp.pass || config.smtp.pass.includes('【')) {
    warnings.push('smtp.pass 未配置');
  }
  if (config.lumaEventUrl.includes('【') || config.lumaEventUrl.includes('你的')) {
    warnings.push('lumaEventUrl 未配置 — 分享页邀请链接无效');
  }
  if (config.posterImageUrl.includes('【') || config.posterImageUrl.includes('你的')) {
    warnings.push('posterImageUrl 未配置 — 邮件海报无法显示');
  }
  if (!isShareLinkSecretConfigured()) {
    warnings.push('shareLinkSecret 未配置 — 分享页链接签名未启用（仅适合本地调试）');
  } else if (WEAK_SHARE_SECRETS.has(String(process.env.SHARE_LINK_SECRET || config.shareLinkSecret || '').trim())) {
    if (isProduction()) {
      fatal.push('shareLinkSecret 仍为默认值 — 生产环境必须更换');
    } else {
      warnings.push('shareLinkSecret 仍为默认值 — 生产环境必须更换');
    }
  }
  if (isProduction() && config.testMode) {
    fatal.push('testMode 仍为 true — 生产环境请关闭，避免向测试邮箱抄送真实用户数据');
  }
  if (isProduction() && !getWebhookSecret()) {
    fatal.push('webhookSecret 未配置 — Webhook 可被任意伪造');
  }
  if (isProduction()) {
    const { user, pass } = getStatsCredentials();
    if (!user || !pass) {
      fatal.push('statsAuth 未配置 — 统计看板与 API 将无法安全访问');
    }
  }

  if (fatal.length) {
    console.error('[配置检查] 生产环境拒绝启动：');
    fatal.forEach((w) => console.error('  -', w));
    process.exit(1);
  }

  if (warnings.length) {
    console.warn('[配置检查] 以下项需上线前处理：');
    warnings.forEach((w) => console.warn('  -', w));
  } else {
    console.log('[配置检查] 关键配置已就绪');
  }
  if (config.welcomeEmailEnabled === false) {
    console.warn('[配置检查] welcomeEmailEnabled=false — Webhook 会入库但不会发送报名确认邮件');
  } else if (config.welcomeEmailRequireUserConfirmation !== false) {
    console.log('[配置检查] 欢迎邮件：自行报名/checkout 成功后发送；后台邀请须用户确认参加');
  }
}

/** HTML 转义，防止 XSS */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 活动副标题：手机端在 2026 后换行，第二行去掉行首 · */
function formatEventSublineHtml(subline) {
  const s = String(subline || EVENT_SUBLINE || '').trim();
  const idx = s.indexOf('2026');
  if (idx === -1) return escapeHtml(s);
  const datePart = s.slice(0, idx + 4).trimEnd();
  const rawRest = s.slice(idx + 4).trimStart();
  const mobileRest = rawRest.replace(/^[·•]\s*/, '');
  if (!rawRest) return escapeHtml(datePart);
  return `<span class="event-subline-inline">${escapeHtml(s)}</span><span class="event-subline-stacked">${escapeHtml(datePart)}<br>${escapeHtml(mobileRest)}</span>`;
}

function parseHostHeader(host) {
  const raw = String(host || '').split(',')[0].trim();
  if (!raw) return { hostname: '', port: '' };
  const ipv6 = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6) return { hostname: ipv6[1], port: ipv6[2] || '' };
  const idx = raw.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(raw.slice(idx + 1))) {
    return { hostname: raw.slice(0, idx), port: raw.slice(idx + 1) };
  }
  return { hostname: raw, port: '' };
}

/** 规范化站点根 URL（修复宝塔/Nginx 下 http + :443 导致 OG 图无法被 X 抓取） */
function normalizeSiteBaseUrl(proto, host) {
  let scheme = String(proto || 'https').split(',')[0].trim().toLowerCase();
  const { hostname, port } = parseHostHeader(host);
  if (!hostname) return '';

  if (port === '443') scheme = 'https';
  if (port === '80' && scheme !== 'https') scheme = 'http';

  const isLocal = /^127\.0\.0\.1$/i.test(hostname) || /^localhost$/i.test(hostname);
  if (!isLocal) scheme = 'https';

  const omitPort = !port
    || (scheme === 'https' && port === '443')
    || (scheme === 'http' && port === '80');
  return `${scheme}://${hostname}${omitPort ? '' : `:${port}`}`;
}

/**
 * 从 Webhook 请求头自动识别站点根地址（部署后无需改 config）
 * 优先级：SITE_BASE_URL 环境变量 > config 非 localhost > 规范化后的请求头 > config 兜底
 */
function resolveSiteBaseUrl(req) {
  if (process.env.SITE_BASE_URL) {
    return process.env.SITE_BASE_URL.replace(/\/$/, '');
  }

  const configured = String(config.siteBaseUrl || '').replace(/\/$/, '');
  if (configured && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(configured)) {
    return configured;
  }

  if (req) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('x-forwarded-host') || req.get('host') || '';
    const normalized = normalizeSiteBaseUrl(proto, host);
    if (normalized && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized)) {
      return normalized;
    }
  }

  return configured || 'http://localhost:3000';
}

/** 拼接用户专属分享页 URL（邮件入口，含 uid 签名） */
function buildSharePageUrlForEmail(name, referralId, siteBaseUrl, company) {
  return buildSharePageUrl(name, referralId, siteBaseUrl, company);
}

/** 校验 uid 是否为已报名用户 */
function requireRegisteredUid(uid) {
  const safe = sanitizeUid(uid);
  if (!safe) return null;
  return getRegistrantByReferralId(safe);
}

const NOT_FOUND_HTML = path.join(__dirname, 'public', '404.html');

function sendNotFoundPage(res) {
  res.status(404).sendFile(NOT_FOUND_HTML);
}

function sendNotFoundApi(res, message = 'Invite not found') {
  res.status(404).json({ success: false, message });
}

/** 合作方 slug 对应已启用落地页（用于 /og 与 registrant 区分） */
function getEnabledPartnerBySlug(raw) {
  const slug = sanitizePartnerSlug(raw);
  if (!slug) return null;
  const partner = getPartnerPage(slug);
  if (!partner || !partner.enabled) return null;
  return partner;
}

/** 拼接对外分享的邀请落地页 URL（社交平台链接预览读此页 OG） */
function buildInviteLandingUrl(referralId, siteBaseUrl, channel) {
  const base = (siteBaseUrl || config.siteBaseUrl).replace(/\/$/, '');
  const uid = String(referralId || '').trim();
  if (!uid) return config.lumaEventUrl || '';
  const params = new URLSearchParams();
  if (channel) params.set('utm_source', `${channel}__${uid}`);
  const qs = params.toString();
  return `${base}/i/${encodeURIComponent(uid)}${qs ? `?${qs}` : ''}`;
}

/** 拼接 Luma 报名链接（带 referral 与 utm 追踪） */
function buildLumaRegisterUrl(referralId, utmSource) {
  if (!config.lumaEventUrl) return '';
  const uid = String(referralId || '').trim();
  const params = new URLSearchParams();
  if (uid) params.set('referral', uid);
  if (utmSource) params.set('utm_source', utmSource);
  const coupon = String(config.lumaCouponCode || '').trim();
  if (coupon) params.set('coupon', coupon);
  const qs = params.toString();
  if (!qs) return config.lumaEventUrl;
  const sep = config.lumaEventUrl.includes('?') ? '&' : '?';
  return `${config.lumaEventUrl}${sep}${qs}`;
}

/** 合作方渠道 Luma 链接（无个人 referral，仅 partner 追踪） */
function buildLumaPartnerRegisterUrl(partnerSlug) {
  const slug = sanitizePartnerSlug(partnerSlug);
  if (!slug || !config.lumaEventUrl) return '';
  return buildLumaRegisterUrl('', `partner__${slug}`);
}

function normalizePartnerPayload(body) {
  const slug = sanitizePartnerSlug(body?.slug);
  if (!slug) return null;
  return {
    slug,
    partner_name: String(body.partner_name || '').trim(),
    headline: String(body.headline || '').trim(),
    subheadline: String(body.subheadline || '').trim(),
    body_text: String(body.body_text || '').trim(),
    logo_url: String(body.logo_url || '').trim(),
    hero_image_url: String(body.hero_image_url || '').trim(),
    cta_label: String(body.cta_label || '').trim(),
    cta_sub: String(body.cta_sub || '').trim(),
    accent_color: String(body.accent_color || '').trim(),
    badge_text: String(body.badge_text || '').trim(),
    social_proof: String(body.social_proof || '').trim(),
    enabled: body.enabled !== false && body.enabled !== 0,
  };
}

/** 根据合作伙伴名称自动生成落地页默认文案 */
function buildPartnerDefaults(slug, partnerName) {
  const name = String(partnerName || slug || '').trim() || 'Partner';
  return {
    slug,
    partner_name: name,
    headline: `${name} × Your Event 2026`,
    subheadline: EVENT_SUBLINE,
    body_text: `Join Your Event 2026 through ${name} — AI founders & builders welcome.`,
    logo_url: '',
    hero_image_url: '',
    cta_label: 'Get tickets',
    cta_sub: `Exclusive access via ${name} · Secure checkout on Luma`,
    accent_color: '#6366f1',
    badge_text: 'Partner invitation',
    social_proof: `via ${name}`,
    enabled: true,
  };
}

function resolveUniquePartnerSlug(preferred) {
  const base = sanitizePartnerSlug(preferred);
  if (!base) return '';
  if (!getPartnerPage(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = sanitizePartnerSlug(`${base}-${i}`);
    if (candidate && !getPartnerPage(candidate)) return candidate;
  }
  return '';
}

function resolveInvitePosterImageUrl() {
  return String(config.posterImageUrl || '').trim();
}

/** 邀请落地页 /i/ 海报（竖版/方版，与社交平台横版、Ins Story 方图分开） */
function resolveInviteLandingPosterImageUrl() {
  const landing = String(config.inviteLandingPosterImageUrl || '').trim();
  if (landing) return landing;
  return String(config.posterImageUrl || '').trim();
}

/** Instagram Story 方图底图（仅 /og/:uid.jpg?shape=square 动态合成 QR） */
function resolveInstagramStoryPosterImageUrl() {
  return String(
    config.instagramStoryPosterImageUrl
    || config.invitePosterImageUrl
    || config.posterImageUrl
    || '',
  ).trim();
}

function resolvePosterAvatarSlotForHero(heroUrl) {
  const landing = resolveInviteLandingPosterImageUrl();
  const igStory = resolveInstagramStoryPosterImageUrl();
  const hero = String(heroUrl || '').trim();
  if (landing && hero && hero === landing) return INVITE_LANDING_AVATAR_SLOT;
  if (igStory && hero && hero === igStory) return INSTAGRAM_STORY_AVATAR_SLOT;
  return POSTER_AVATAR_SLOT;
}

function partnerPublicUrl(req, slug) {
  const siteBase = resolveSiteBaseUrl(req);
  return `${siteBase}/p/${encodeURIComponent(slug)}`;
}

function buildPartnerLandingContext(partner, req) {
  const slug = sanitizePartnerSlug(partner?.slug);
  if (!slug || !partner) return null;
  const siteBase = resolveSiteBaseUrl(req);
  const pageUrl = `${siteBase}/p/${encodeURIComponent(slug)}`;
  const registerUrl = buildLumaPartnerRegisterUrl(slug);
  const heroImageUrl = partner.hero_image_url || config.posterImageUrl || '';
  const ogImageUrl = heroImageUrl || `${siteBase}/og/${encodeURIComponent(slug)}.jpg?company=${encodeURIComponent(partner.partner_name || slug)}`;
  return {
    slug,
    partnerName: partner.partner_name || slug,
    headline: partner.headline,
    subheadline: partner.subheadline,
    bodyText: partner.body_text,
    logoUrl: partner.logo_url,
    heroImageUrl,
    ctaLabel: partner.cta_label,
    ctaSub: partner.cta_sub,
    accentColor: partner.accent_color,
    badgeText: partner.badge_text,
    socialProof: partner.social_proof,
    pageUrl,
    registerUrl,
    ogImageUrl,
    fpLogoUrl: config.fpLogoUrl || '',
    eventSubline: EVENT_SUBLINE,
  };
}

/** 合作落地页：映射为与个人邀请页相同的 UI */
function buildPartnerInviteHtml(partner, req, options = {}) {
  const slug = sanitizePartnerSlug(partner?.slug);
  if (!slug) return '';
  const defaults = buildPartnerDefaults(slug, partner?.partner_name || slug);
  const p = { ...defaults, ...partner, slug };
  const siteBase = resolveSiteBaseUrl(req);
  const pageUrl = `${siteBase}/p/${encodeURIComponent(slug)}`;
  const registerUrl = buildLumaPartnerRegisterUrl(slug);
  const heroImageUrl = p.hero_image_url || config.posterImageUrl || '';
  const partnerName = p.partner_name || slug;
  const headline = p.headline || defaults.headline;
  const ogImageUrl = buildOgImageUrl(siteBase, slug, partnerName, partnerName, {
    avatarUrl: p.logo_url || '',
    posterSlogan: headline,
  });
  const ogDescription = `${partnerName} — Your Event 2026 · Your City`;

  return buildInviteLandingHtml({
    uid: slug,
    name: partnerName,
    company: partnerName,
    posterUrl: config.posterImageUrl || '',
    pageUrl,
    registerUrl,
    ogImageUrl,
    avatarUrl: p.logo_url || '',
    inviterSlogan: headline,
    inviterNote: p.body_text || defaults.body_text,
    heroImageUrl,
    posterAspectRatio: '1 / 1',
    posterAvatarSlot: resolvePosterAvatarSlotForHero(heroImageUrl),
    eventSubline: p.subheadline || EVENT_SUBLINE,
    ctaLabel: p.cta_label || 'Get tickets',
    ctaSub: p.cta_sub || defaults.cta_sub,
    message: ogDescription,
    fpLogoUrl: config.fpLogoUrl || '',
    pageMode: 'partner',
    socialProofText: p.social_proof || defaults.social_proof,
    sealTextEn: p.badge_text || 'Partner invitation',
    sealTextZh: '合作伙伴邀请',
    skipIntro: !!options.skipIntro,
    skipTracking: !!options.skipTracking,
  });
}

function normalizeSideEventKey(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function getSideEventsConfig() {
  return (Array.isArray(config.sideEvents) ? config.sideEvents : [])
    .filter((e) => e && e.enabled !== false && e.key && e.eventId);
}

/** 分享页 Side Sessions 总开关（config.sideSessionsShareEnabled） */
function isSideSessionsShareEnabled() {
  return config.sideSessionsShareEnabled === true;
}

function getSideEventByKey(key) {
  const k = normalizeSideEventKey(key);
  if (!k) return null;
  return getSideEventsConfig().find((e) => normalizeSideEventKey(e.key) === k) || null;
}

function getSideEventsPublicList() {
  return getSideEventsConfig().map((e) => ({
    key: normalizeSideEventKey(e.key),
    name: e.name || e.headline || e.key,
    headline: e.headline || e.name || '',
    subheadline: e.subheadline || '',
    bodyText: e.bodyText || e.body_text || '',
    ctaLabel: e.ctaLabel || e.cta_label || '',
  }));
}

function normalizeLumaEventUrl(url) {
  return String(url || '').replace(/\/$/, '').trim()
    .replace(/^https:\/\/lu\.ma\//i, 'https://luma.com/');
}

function isMainEventLumaUrl(url) {
  const u = normalizeLumaEventUrl(url);
  const main = normalizeLumaEventUrl(config.lumaEventUrl);
  return !!u && !!main && u === main;
}

/** 按 Luma 活动 URL 匹配 config.sideEvents 中的 Side Event */
function resolveSideEventFromLumaUrl(url) {
  const u = normalizeLumaEventUrl(url);
  if (!u) return null;
  return getSideEventsConfig().find((e) => normalizeLumaEventUrl(e.url) === u) || null;
}

function formatLumaEventSubheadline(lumaEvent) {
  if (!lumaEvent?.start_at) return '';
  const tz = lumaEvent.timezone || 'Asia/Your City';
  try {
    const start = new Date(lumaEvent.start_at);
    const parts = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: tz,
      timeZoneName: 'short',
      hour12: false,
    }).formatToParts(start);
    const get = (type) => parts.find((p) => p.type === type)?.value || '';
    const when = `${get('month')} ${get('day')}, ${get('hour')}:${get('minute')} ${get('timeZoneName')}`.trim();
    return `${when} · Free for ticket holders`;
  } catch {
    return '';
  }
}

function pickSideSessionDisplayFields(session, lumaEvent) {
  const key = normalizeSideEventKey(session.key);
  const lumaName = String(lumaEvent?.name || '').trim();
  const name = lumaName || session.name || session.headline || key;
  const headline = lumaName || session.headline || session.name || '';
  const configSub = String(session.subheadline || '').trim();
  const subheadline = configSub || formatLumaEventSubheadline(lumaEvent);
  const configBody = String(session.bodyText || session.body_text || '').trim();
  const lumaDesc = String(lumaEvent?.description || lumaEvent?.description_md || '').trim();
  const bodyText = configBody || lumaDesc;
  const heroImageUrl = session.heroImageUrl || session.hero_image_url || lumaEvent?.cover_url || '';

  return {
    ...session,
    name,
    headline,
    subheadline,
    bodyText,
    heroImageUrl,
    hero_image_url: heroImageUrl,
  };
}

/** 从 Luma 拉取活动名称/描述/封面等展示字段（config 为 fallback） */
async function enrichSideSessionFromLuma(session) {
  if (!session) return null;
  const eventId = String(session.eventId || '').trim();
  if (!isLumaApiConfigured() || !eventId) {
    return pickSideSessionDisplayFields(session, null);
  }
  try {
    const lumaEvent = await getEventById({ eventId });
    return pickSideSessionDisplayFields(session, lumaEvent);
  } catch (err) {
    console.warn('[分会场] Luma 活动信息同步失败:', { eventId, error: err.message });
    return pickSideSessionDisplayFields(session, null);
  }
}

function buildSideSessionPageUrl(req, eventKey, shareUid, sig) {
  const siteBase = resolveSiteBaseUrl(req).replace(/\/$/, '');
  const k = normalizeSideEventKey(eventKey);
  const params = new URLSearchParams();
  if (shareUid) params.set('uid', shareUid);
  if (sig) params.set('sig', sig);
  const qs = params.toString();
  return `${siteBase}/s/${encodeURIComponent(k)}${qs ? `?${qs}` : ''}`;
}

function resolveSideSessionJoined(shareUid, eventKey) {
  const row = getSideEventRsvp(shareUid, eventKey);
  return !!row && row.status === 'joined';
}

/** 以 Luma 后台为准同步分会场报名状态，并更新本地 side_event_rsvps */
async function syncSideSessionJoinState({ uid, registrant, session }) {
  const eventKey = normalizeSideEventKey(session?.key);
  if (!eventKey || !registrant) return false;

  const email = String(registrant.email || '').trim();
  const eventId = String(session.eventId || '').trim();
  if (!isLumaApiConfigured() || !eventId || !email) {
    return resolveSideSessionJoined(uid, eventKey);
  }

  try {
    const guest = await getGuestOnEvent({ eventId, email });
    const joined = isLumaGuestJoined(guest);

    if (joined) {
      const name = resolveSharerDisplayName(uid, registrant) || registrant.name || '';
      saveSideEventRsvp({
        referral_id: uid,
        email,
        name,
        side_event_key: eventKey,
        luma_event_id: eventId,
        luma_guest_id: guest?.id || guest?.api_id || '',
        source: 'api_one_click',
        status: 'joined',
      });
      return true;
    }

    if (!joined) {
      const row = getSideEventRsvp(uid, eventKey);
      if (row?.status === 'pending_approval') {
        return false;
      }
      deleteSideEventRsvp(uid, eventKey);
      return false;
    }
  } catch (err) {
    console.warn('[分会场] Luma 状态同步失败:', { eventKey, email, error: err.message });
    return resolveSideSessionJoined(uid, eventKey);
  }
}

/** 分会场详情页（无信封动画，视觉与邀请页一致） */
function buildSideSessionInviteHtml(session, registrant, req, options = {}) {
  const key = normalizeSideEventKey(session.key);
  const shareUid = sanitizeUid(registrant?.referral_id || options.shareUid);
  const name = resolveInviteDisplayName(registrant, options.name);
  const company = resolveInviteDisplayCompany(registrant, options.company, 'Your Org');
  const siteBase = resolveSiteBaseUrl(req);
  const sig = String(options.sig || signShareUid(shareUid) || '').trim();
  const pageUrl = buildSideSessionPageUrl(req, key, shareUid, sig);
  const headline = String(session.headline || session.name || `Session ${key.toUpperCase()}`).trim();
  const joined = options.joined != null ? !!options.joined : resolveSideSessionJoined(shareUid, key);
  const avatarUrl = getShareAvatar(shareUid);
  const heroImageUrl = session.heroImageUrl || session.hero_image_url || config.posterImageUrl || '';
  const joinLabel = String(session.ctaLabel || session.cta_label || `Join Session ${key.toUpperCase()}`).trim();
  const joinedLabel = String(session.joinedCtaLabel || session.joined_cta_label || 'Joined ✓').trim();

  return buildInviteLandingHtml({
    uid: shareUid,
    name,
    company,
    posterUrl: config.posterImageUrl || '',
    pageUrl,
    registerUrl: '#',
    ogImageUrl: buildOgImageUrl(siteBase, `side-${key}`, headline, name, {
      avatarUrl,
      posterSlogan: headline,
    }),
    avatarUrl,
    inviterSlogan: headline,
    inviterNote: session.bodyText || session.body_text || '',
    heroImageUrl,
    posterAspectRatio: '1 / 1',
    posterAvatarSlot: resolvePosterAvatarSlotForHero(heroImageUrl),
    eventSubline: session.subheadline || EVENT_SUBLINE,
    ctaLabel: joined ? joinedLabel : joinLabel,
    ctaSub: session.ctaSub || session.cta_sub || 'Free for main event ticket holders',
    message: `${headline} — Your Event 2026 · Your City`,
    fpLogoUrl: config.fpLogoUrl || '',
    pageMode: 'side',
    socialProofText: session.socialProof || session.social_proof || 'Free · Main event ticket holders',
    sealTextEn: 'Side session',
    sealTextZh: '分会场',
    skipIntro: true,
    skipTracking: !!options.skipTracking,
    sideEventKey: key,
    shareSig: sig,
    initialJoined: joined,
    joinedCtaLabel: joinedLabel,
    joinCtaLabel: joinLabel,
  });
}

/** 邀请卡 / OG 内容指纹（avatar、海报、版本变更时 ?v= 更新，用于 X 等爬虫刷新缓存） */
function buildOgImageVersionKey({ avatarUrl, posterImageUrl, shape = 'landscape', inviteUrl = '' } = {}) {
  const isSquare = shape === 'square';
  const poster = posterImageUrl
    || (isSquare ? resolveInstagramStoryPosterImageUrl() : (config.posterImageUrl || ''));
  const seed = [
    APP_VERSION,
    avatarUrl,
    poster,
    isSquare ? inviteUrl : '',
    isSquare ? '1200x1200' : `${OG_WIDTH}x${OG_HEIGHT}`,
    isSquare ? 'square' : 'landscape',
  ].filter(Boolean).join('|');
  if (!seed) return '';
  return crypto.createHash('sha256').update(seed).digest('base64url').slice(0, 10);
}

function buildOgEtag({ name, company, avatarUrl, posterImageUrl, shape = 'landscape', inviteUrl = '' } = {}) {
  const isSquare = shape === 'square';
  const poster = posterImageUrl
    || (isSquare ? resolveInstagramStoryPosterImageUrl() : (config.posterImageUrl || ''));
  const seed = [
    APP_VERSION,
    name,
    company,
    avatarUrl,
    poster,
    isSquare ? inviteUrl : '',
    EVENT_SUBLINE,
    isSquare ? '1200x1200' : `${OG_WIDTH}x${OG_HEIGHT}`,
    isSquare ? 'square' : 'landscape',
  ].filter(Boolean).join('|');
  return `"og-${crypto.createHash('sha256').update(seed).digest('base64url').slice(0, 32)}"`;
}

/** 拼接 OG 预览图 URL（横版 1200×630；shape=square 时为 1200×1200，供 Instagram 等） */
function buildOgImageUrl(siteBase, uid, name, company, options = {}) {
  const params = new URLSearchParams();
  if (name) params.set('name', name);
  if (company) params.set('company', company);
  const shape = options.shape === 'square' ? 'square' : 'landscape';
  if (shape === 'square') params.set('shape', 'square');
  const posterImageUrl = shape === 'square'
    ? resolveInstagramStoryPosterImageUrl()
    : (options.posterImageUrl || config.posterImageUrl || '');
  const v = buildOgImageVersionKey({
    avatarUrl: options.avatarUrl,
    posterImageUrl,
    shape,
  });
  if (v) params.set('v', v);
  const qs = params.toString();
  return `${siteBase}/og/${encodeURIComponent(uid)}.jpg${qs ? `?${qs}` : ''}`;
}

function resolveInviteCardVersion(uid) {
  const safeUid = sanitizeUid(uid);
  if (!safeUid) return '';
  const avatarUrl = sanitizeAvatarUrl(getShareAvatar(safeUid), config) || '';
  return buildOgImageVersionKey({
    avatarUrl,
    posterImageUrl: config.posterImageUrl || '',
  });
}

/** 邀请落地页 HTML（含 OG / Twitter Card，供爬虫抓取） */
function buildInviteLandingHtml({
  uid, name, company, posterUrl, pageUrl, registerUrl, ogImageUrl, message,
  avatarUrl, inviterSlogan, inviterNote, heroImageUrl, eventSubline, ctaLabel,
  fpLogoUrl, pageMode = 'invite', ctaSub = '', socialProofText = '',
  sealTextEn = 'Partner invitation', sealTextZh = '合作伙伴邀请',
  skipIntro = false, skipTracking = false,
  sideEventKey = '', shareSig = '', initialJoined = false,
  joinedCtaLabel = 'Joined ✓', joinCtaLabel = '',
  posterAspectRatio = '1 / 1',
  posterAvatarSlot = INVITE_LANDING_AVATAR_SLOT,
}) {
  const isPartner = pageMode === 'partner';
  const isSide = pageMode === 'side';
  const skipEnvelope = skipIntro || isSide;
  const safeName = escapeHtml(name || (isPartner || isSide ? 'Guest' : 'A friend'));
  const safeCompany = escapeHtml(company || 'Your Org');
  const avatarInitial = escapeHtml((name || 'A').trim().charAt(0).toUpperCase() || 'A');
  const safeAvatarUrl = escapeHtml(avatarUrl || '');
  const inviteAvatarHtml = safeAvatarUrl
    ? `<img class="invite-avatar invite-avatar-img" src="${safeAvatarUrl}" alt="" referrerpolicy="no-referrer" decoding="async" />`
    : `<div class="invite-avatar">${avatarInitial}</div>`;
  const sloganText = (inviterSlogan || DEFAULT_POSTER_SLOGAN || "I'm going!").trim();
  const noteText = (isPartner || isSide)
    ? String(inviterNote || '').trim()
    : String(inviterNote || defaultInviteNoteExcerpt()).trim();
  const safeSloganHtml = formatInviteNoteHtml(sloganText);
  let safeQuoteMainHtml = '';
  let safeQuoteExtraHtml = '';
  if (isPartner || isSide) {
    const bodyOnly = noteText && noteText !== sloganText ? noteText : (isSide ? noteText : '');
    if (bodyOnly) {
      safeQuoteMainHtml = formatInviteNoteHtml(clampInviteText(bodyOnly));
    } else if (isSide && sloganText) {
      safeQuoteMainHtml = formatInviteNoteHtml(clampInviteText(sloganText));
    }
  } else {
    const quoteMain = resolveInviteQuoteMain(noteText, sloganText);
    const quoteExtra = resolveInviteQuoteExtra(noteText, sloganText);
    safeQuoteMainHtml = formatInviteNoteHtml(quoteMain);
    safeQuoteExtraHtml = quoteExtra ? formatInviteNoteHtml(quoteExtra) : '';
  }
  const showQuoteBlock = isSide ? !!safeQuoteMainHtml : (!isPartner || !!safeQuoteMainHtml);
  const safePosterSubline = escapeHtml(isPartner || isSide ? (eventSubline || EVENT_SUBLINE) : invitePosterSubline(name));
  const envelopeWaxHtml = buildEnvelopeWaxHtml(avatarUrl, (name || 'A').trim().charAt(0).toUpperCase() || 'A');
  const pageTitle = isSide
    ? `${sloganText} · Your Event 2026`
    : isPartner
      ? `${name || 'Partner'} · Your Event 2026`
      : `${name || 'A friend'} invites you to Your Event 2026`;
  const ogTitle = isSide
    ? `${sloganText} · Your Event 2026`
    : isPartner
      ? `${name || 'Partner'} · Your Event 2026`
      : 'Your Event 2026 — Your City · Your dates';
  const ogDescription = message || (isSide
    ? `${sloganText} — Your Event 2026 in Your City. Free for main event ticket holders.`
    : isPartner
      ? `${name || 'Partner'} — Your Event 2026 in Your City — August 3–4 at Your Venue.`
      : `${name || 'A friend'} invites you · Your Venue · Grab your spot with my personal link.`);
  const safeHero = escapeHtml(heroImageUrl || posterUrl || ogImageUrl);
  const safeOgImage = escapeHtml(ogImageUrl || posterUrl);
  const safePageUrl = escapeHtml(pageUrl);
  const safeRegisterUrl = escapeHtml(registerUrl);
  const safeMessage = escapeHtml(ogDescription);
  const safeSubline = formatEventSublineHtml(eventSubline || 'Your dates · Your city · Your venue');
  const safeCta = escapeHtml(ctaLabel || 'Get tickets');
  const safeFpLogo = escapeHtml(fpLogoUrl || '');
  const sideHeadlineHtml = isSide ? safeSloganHtml : '';
  const ctaJoinedClass = isSide && initialJoined ? ' is-joined' : '';
  const ctaDisabledAttr = isSide && initialJoined ? ' disabled' : '';
  const ctaTag = isSide ? 'button' : 'a';
  const ctaPrimaryAttrs = isSide
    ? ` type="button" class="invite-cta${ctaJoinedClass}" id="registerBtn"${ctaDisabledAttr}`
    : ` class="invite-cta" id="registerBtn" href="${safeRegisterUrl}"`;
  const ctaStickyAttrs = isSide
    ? ` type="button" class="invite-cta${ctaJoinedClass}" id="registerBtnSticky"${ctaDisabledAttr}`
    : ` class="invite-cta" id="registerBtnSticky" href="${safeRegisterUrl}"`;

  const posterOverlayHtml = `<div class="invite-poster-overlay" aria-hidden="true">
            <div class="invite-poster-avatar-slot${isPartner ? ' invite-poster-avatar-slot--partner' : ''}">
              ${inviteAvatarHtml}
            </div>
          </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${buildGaHeadHtml(config.gaMeasurementId)}
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${safeMessage}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${safePageUrl}" />
  <meta property="og:title" content="${escapeHtml(ogTitle)}" />
  <meta property="og:description" content="${safeMessage}" />
  <meta property="og:image" content="${safeOgImage}" />
  <meta property="og:image:width" content="${OG_WIDTH}" />
  <meta property="og:image:height" content="${OG_HEIGHT}" />
  <meta property="og:image:alt" content="${escapeHtml(ogTitle)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:url" content="${safePageUrl}" />
  <meta name="twitter:title" content="${escapeHtml(ogTitle)}" />
  <meta name="twitter:description" content="${safeMessage}" />
  <meta name="twitter:image" content="${safeOgImage}" />
  <link rel="preload" as="image" href="${safeHero}" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --ease-out: cubic-bezier(.22, 1, .36, 1);
      --ease-spring: cubic-bezier(.34, 1.2, .64, 1);
      --text: #0f172a;
      --muted: #64748b;
      --accent: #4338ca;
      --accent-soft: #eef2ff;
    }
    body {
      min-height: 100vh;
      min-height: 100dvh;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      color: var(--text);
      background: #0b0f1a;
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
    }
    .invite-ambient {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 0;
      background:
        radial-gradient(ellipse 80% 60% at 20% 10%, rgba(99, 102, 241, .35) 0%, transparent 55%),
        radial-gradient(ellipse 70% 50% at 85% 85%, rgba(56, 189, 248, .2) 0%, transparent 50%),
        linear-gradient(165deg, #0f172a 0%, #1e1b4b 42%, #0f172a 100%);
    }
    .invite-ambient::after {
      content: "";
      position: absolute;
      inset: 0;
      opacity: .04;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    }
    .invite-page {
      position: relative;
      z-index: 1;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: max(12px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
    }
    .invite-topbar {
      width: min(420px, 100%);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 14px;
      padding-top: 2px;
    }
    .invite-lang {
      position: relative;
      z-index: 2;
      display: inline-flex;
      flex-shrink: 0;
      padding: 3px;
      border-radius: 999px;
      background: rgba(255, 255, 255, .08);
      border: 1px solid rgba(255, 255, 255, .14);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    .invite-lang-btn {
      border: none;
      background: transparent;
      color: #94a3b8;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .04em;
      min-width: 36px;
      padding: 7px 10px;
      border-radius: 999px;
      cursor: pointer;
      line-height: 1;
      transition: color .15s ease, background .15s ease;
    }
    .invite-lang-btn.is-active {
      color: #e2e8f0;
      background: rgba(99, 102, 241, .35);
    }
    .invite-card {
      width: min(420px, 100%);
      display: flex;
      flex-direction: column;
      gap: 0;
      min-width: 0;
      overflow: hidden;
    }
    .invite-reveal {
      opacity: 0;
      transform: translateY(18px) scale(.98);
    }
    body.invite-unlocked .invite-reveal {
      animation: inviteReveal .75s var(--ease-out) forwards;
    }
    body.invite-unlocked .invite-reveal.d1 { animation-delay: .08s; }
    body.invite-unlocked .invite-reveal.d2 { animation-delay: .18s; }
    body.invite-unlocked .invite-reveal.d3 { animation-delay: .28s; }
    body.invite-unlocked .invite-reveal.d4 { animation-delay: .38s; }
    body.invite-unlocked .invite-reveal.d5 { animation-delay: .48s; }
    body.invite-unlocked .invite-reveal.d6 { animation-delay: .58s; }
    @keyframes inviteReveal {
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes sealPop {
      0% { opacity: 0; transform: scale(.6) rotate(-8deg); }
      70% { transform: scale(1.06) rotate(2deg); }
      100% { opacity: 1; transform: scale(1) rotate(0); }
    }
    .invite-seal {
      display: flex;
      justify-content: flex-start;
      margin-bottom: 0;
      min-width: 0;
      flex: 1;
      opacity: 0;
    }
    body.invite-unlocked .invite-seal {
      animation: sealPop .65s var(--ease-spring) .05s both;
    }
    body.invite-unlocked .invite-topbar.invite-reveal {
      animation: inviteReveal .75s var(--ease-out) forwards;
      animation-delay: .05s;
    }
    .invite-seal-inner {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: 100%;
      padding: 8px 14px 8px 12px;
      border-radius: 999px;
      background: rgba(255, 255, 255, .1);
      border: 1px solid rgba(255, 255, 255, .18);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      color: #e2e8f0;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .12em;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .invite-seal-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: linear-gradient(135deg, #a5b4fc, #6366f1);
      box-shadow: 0 0 12px rgba(99, 102, 241, .8);
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: .7; transform: scale(.85); }
    }
    .invite-poster-wrap {
      background: transparent;
      border-radius: 0;
      padding: 0;
      box-shadow: none;
    }
    .invite-poster-frame {
      position: relative;
      border-radius: 20px;
      overflow: hidden;
      aspect-ratio: ${posterAspectRatio};
      background: #0f172a;
      box-shadow:
        0 20px 50px rgba(0, 0, 0, 0.42),
        0 0 0 0.5px rgba(255, 255, 255, 0.1);
    }
    .invite-poster {
      width: 100%;
      height: 100%;
      object-fit: contain;
      object-position: center;
      display: block;
      background: #f8fafc;
    }
    .invite-poster-overlay {
      position: absolute;
      pointer-events: none;
      z-index: 2;
      opacity: 0;
    }
    .invite-poster-frame.is-avatar-slot-ready .invite-poster-overlay {
      opacity: 1;
    }
    .invite-poster-avatar-slot {
      position: absolute;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      line-height: 0;
    }
    .invite-poster-avatar-slot .invite-avatar {
      width: 100%;
      height: 100%;
      max-width: none;
      min-width: 0;
      aspect-ratio: 1 / 1;
      box-shadow: none;
    }
    .invite-poster-avatar-slot--partner .invite-avatar,
    .invite-poster-avatar-slot--partner .invite-avatar.invite-avatar-img {
      border-radius: 20px;
    }
    .invite-avatar {
      border-radius: 50%;
      border: none;
      background: rgb(0, 248, 208);
      color: #0b0f1a;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: clamp(28px, 38%, 52px);
    }
    .invite-avatar.invite-avatar-img {
      object-fit: cover;
      display: block;
    }
    .invite-poster-tagline-main {
      font-size: 15px;
      font-weight: 700;
      color: #1d1d1f;
      letter-spacing: -.02em;
      line-height: 1.2;
    }
    .invite-poster-tagline-sub {
      font-size: 11px;
      color: #86868b;
      margin-top: 2px;
      line-height: 1.3;
    }
    .invite-body {
      margin-top: 22px;
      padding: 0 4px;
      color: #f1f5f9;
      min-width: 0;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .invite-headline {
      font-size: clamp(22px, 5.5vw, 26px);
      line-height: 1.25;
      font-weight: 800;
      letter-spacing: -.03em;
      color: #fff;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .invite-headline em {
      font-style: normal;
      background: linear-gradient(135deg, #c7d2fe 0%, #a5b4fc 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .invite-subhead {
      margin-top: 8px;
      font-size: 14px;
      line-height: 1.5;
      color: #94a3b8;
    }
    .invite-social-proof {
      margin-top: 10px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: .04em;
      color: #a5b4fc;
    }
    .invite-countdown {
      margin-top: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .invite-countdown-unit {
      min-width: 56px;
      padding: 8px 8px;
      border-radius: 10px;
      background: rgba(255, 255, 255, .06);
      border: 1px solid rgba(255, 255, 255, .1);
      text-align: center;
    }
    .invite-countdown-num {
      display: block;
      font-size: 20px;
      font-weight: 800;
      color: #f8fafc;
      letter-spacing: -.02em;
      line-height: 1.1;
    }
    .invite-countdown-label {
      display: block;
      margin-top: 2px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: .12em;
      text-transform: uppercase;
      color: #64748b;
    }
    .invite-countdown-timer {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      flex-wrap: wrap;
      width: 100%;
    }
    .invite-countdown.is-live .invite-countdown-timer,
    .invite-countdown.is-ended .invite-countdown-timer {
      display: none;
    }
    .invite-countdown-status {
      display: none;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 12px 16px;
      border-radius: 12px;
      background: rgba(255, 255, 255, .06);
      border: 1px solid rgba(255, 255, 255, .1);
      width: 100%;
      max-width: 320px;
    }
    .invite-countdown.is-live .invite-countdown-status,
    .invite-countdown.is-ended .invite-countdown-status {
      display: flex;
    }
    .invite-countdown-status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .invite-countdown.is-live .invite-countdown-status-dot {
      background: #22c55e;
      box-shadow: 0 0 0 0 rgba(34, 197, 94, .6);
      animation: invite-live-pulse 1.8s ease-out infinite;
    }
    @keyframes invite-live-pulse {
      0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, .55); }
      70% { box-shadow: 0 0 0 8px rgba(34, 197, 94, 0); }
      100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
    }
    .invite-countdown.is-ended .invite-countdown-status-dot {
      background: #64748b;
    }
    .invite-countdown-status-text {
      font-size: 14px;
      font-weight: 700;
      color: #f8fafc;
      letter-spacing: -.01em;
      text-align: center;
      line-height: 1.4;
    }
    .invite-countdown.is-ended .invite-countdown-status-text {
      color: #94a3b8;
      font-weight: 600;
    }
    @media (prefers-reduced-motion: reduce) {
      .invite-countdown.is-live .invite-countdown-status-dot { animation: none; }
    }
    .invite-quote {
      margin-top: 18px;
      padding: 16px 16px 14px;
      border-radius: 14px;
      background: rgba(255, 255, 255, .06);
      border: 1px solid rgba(255, 255, 255, .1);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      min-width: 0;
      overflow: hidden;
    }
    .invite-quote-slogan {
      font-size: 17px;
      font-weight: 700;
      line-height: 1.4;
      color: #f8fafc;
      letter-spacing: -.02em;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .invite-quote-detail {
      margin-top: 10px;
      font-size: 13px;
      line-height: 1.65;
      color: #cbd5e1;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .invite-quote-by {
      margin-top: 12px;
      font-size: 12px;
      font-weight: 600;
      color: #64748b;
    }
    .invite-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 18px;
    }
    .invite-chip {
      font-size: 11px;
      font-weight: 600;
      color: #c7d2fe;
      background: rgba(99, 102, 241, .15);
      border: 1px solid rgba(129, 140, 248, .25);
      padding: 6px 12px;
      border-radius: 999px;
      letter-spacing: .01em;
    }
    .invite-action {
      margin-top: 24px;
      padding: 0 4px;
    }
    .invite-cta {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
      padding: 16px 22px;
      border-radius: 14px;
      background: linear-gradient(135deg, #4f46e5 0%, #6366f1 48%, #818cf8 100%);
      color: #fff;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -.02em;
      text-decoration: none;
      box-shadow:
        0 4px 24px rgba(79, 70, 229, .5),
        inset 0 1px 0 rgba(255, 255, 255, .2);
      transition: transform .2s var(--ease-out), box-shadow .2s var(--ease-out);
      position: relative;
      overflow: hidden;
    }
    .invite-cta::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(105deg, transparent 40%, rgba(255,255,255,.18) 50%, transparent 60%);
      transform: translateX(-100%);
      transition: transform .6s var(--ease-out);
    }
    .invite-cta:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 32px rgba(79, 70, 229, .55), inset 0 1px 0 rgba(255, 255, 255, .25);
    }
    .invite-cta:hover::after { transform: translateX(100%); }
    .invite-cta:active { transform: translateY(0) scale(.98); }
    .invite-cta-arrow {
      font-size: 18px;
      line-height: 1;
      transition: transform .2s var(--ease-out);
    }
    .invite-cta:hover .invite-cta-arrow { transform: translateX(3px); }
    .invite-cta-sub {
      margin-top: 10px;
      text-align: center;
      font-size: 11px;
      color: #64748b;
      line-height: 1.45;
    }
    .invite-cta-dock {
      display: none;
    }
    .invite-footer {
      margin-top: 28px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      opacity: .7;
    }
    .invite-footer-logo {
      height: 18px;
      width: auto;
      object-fit: contain;
      filter: brightness(0) invert(1);
      opacity: .6;
    }
    .invite-footer-text {
      font-size: 11px;
      color: #475569;
      letter-spacing: .04em;
    }
    .event-subline-stacked {
      display: none;
    }
    @media (max-width: 767px) {
      .event-subline-inline {
        display: none;
      }
      .event-subline-stacked {
        display: inline;
      }
    }
    /* Envelope intro */
    .invite-intro {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: center;
      background:
        radial-gradient(ellipse 70% 55% at 50% 40%, rgba(99, 102, 241, .25) 0%, transparent 60%),
        rgba(11, 15, 26, .92);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      transition: opacity .55s var(--ease-out), visibility .55s;
    }
    .invite-intro.is-done {
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
    }
    .envelope-scene {
      perspective: 900px;
      animation: envFloatIn .55s var(--ease-spring) both;
    }
    @keyframes envFloatIn {
      from { opacity: 0; transform: translateY(24px) scale(.88); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .envelope {
      position: relative;
      width: min(280px, 72vw);
      height: 188px;
      transform-style: preserve-3d;
    }
    .envelope.is-opening .envelope-flap {
      animation: envFlapOpen .75s var(--ease-out) forwards;
    }
    .envelope.is-opening .envelope-wax {
      animation: waxFade .35s var(--ease-out) .15s forwards;
    }
    .envelope.is-opening .envelope-paper {
      animation: paperRise .65s var(--ease-out) .45s forwards;
    }
    .envelope.is-opening {
      animation: envLift .5s var(--ease-out) .85s forwards;
    }
    @keyframes envFlapOpen {
      0% { transform: rotateX(0deg); }
      100% { transform: rotateX(-175deg); opacity: .25; }
    }
    @keyframes waxFade {
      to { opacity: 0; transform: translateX(-50%) scale(.6); }
    }
    @keyframes paperRise {
      0% { transform: translateY(28px); opacity: 0; }
      100% { transform: translateY(-8px); opacity: 1; }
    }
    @keyframes envLift {
      to { transform: translateY(-20px) scale(1.04); opacity: 0; }
    }
    .envelope-body {
      position: absolute;
      inset: 0;
      border-radius: 6px;
      background: linear-gradient(160deg, #f1f5f9 0%, #e2e8f0 55%, #cbd5e1 100%);
      box-shadow:
        0 20px 50px rgba(0, 0, 0, .45),
        inset 0 1px 0 rgba(255, 255, 255, .8);
    }
    .envelope-paper {
      position: absolute;
      left: 14px;
      right: 14px;
      top: 22px;
      height: 120px;
      border-radius: 4px;
      background: linear-gradient(180deg, #fff 0%, #f8fafc 100%);
      box-shadow: 0 2px 12px rgba(15, 23, 42, .12);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 12px;
      opacity: 0;
      transform: translateY(28px);
      z-index: 1;
    }
    .envelope-paper-label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: .16em;
      text-transform: uppercase;
      color: #6366f1;
    }
    .envelope-paper-name {
      font-size: 15px;
      font-weight: 800;
      color: #0f172a;
      letter-spacing: -.02em;
      text-align: center;
      line-height: 1.3;
    }
    .envelope-paper-event {
      font-size: 11px;
      color: #64748b;
      text-align: center;
    }
    .envelope-front {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 58%;
      background: linear-gradient(180deg, #e2e8f0 0%, #cbd5e1 100%);
      clip-path: polygon(0 100%, 50% 0, 100% 100%);
      z-index: 2;
      border-radius: 0 0 6px 6px;
    }
    .envelope-flap {
      position: absolute;
      left: 0;
      right: 0;
      top: 0;
      height: 54%;
      background: linear-gradient(180deg, #eef2ff 0%, #c7d2fe 100%);
      clip-path: polygon(0 0, 50% 100%, 100% 0);
      transform-origin: top center;
      z-index: 4;
      backface-visibility: hidden;
      box-shadow: 0 4px 16px rgba(79, 70, 229, .2);
    }
    .envelope-wax {
      position: absolute;
      left: 50%;
      top: 46%;
      transform: translateX(-50%);
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: linear-gradient(145deg, #6366f1 0%, #4338ca 100%);
      box-shadow:
        0 4px 16px rgba(67, 56, 202, .5),
        inset 0 2px 4px rgba(255, 255, 255, .25);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 17px;
      font-weight: 800;
      z-index: 5;
    }
    .envelope-wax.envelope-wax-photo {
      padding: 0;
      overflow: hidden;
      border: 2px solid rgba(255, 255, 255, .35);
    }
    .envelope-wax-photo img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .invite-intro-hint {
      position: absolute;
      bottom: max(28px, env(safe-area-inset-bottom));
      left: 0;
      right: 0;
      text-align: center;
      font-size: 12px;
      color: #64748b;
      letter-spacing: .06em;
      animation: hintPulse 2s ease-in-out infinite;
    }
    @keyframes hintPulse {
      0%, 100% { opacity: .5; }
      50% { opacity: .9; }
    }
    @media (max-width: 479px) {
      .invite-page {
        padding-top: max(16px, calc(env(safe-area-inset-top) + 6px));
        padding-bottom: max(calc(92px + env(safe-area-inset-bottom)), 24px);
      }
      .invite-topbar {
        margin-bottom: 14px;
        gap: 8px;
        min-height: 36px;
      }
      .invite-seal {
        min-width: 0;
      }
      .invite-seal-inner {
        font-size: 10px;
        letter-spacing: .08em;
        padding: 7px 10px 7px 9px;
        gap: 6px;
        max-width: calc(100vw - 120px);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .invite-seal-dot {
        width: 7px;
        height: 7px;
      }
      .invite-lang-btn {
        min-width: 34px;
        padding: 7px 9px;
        font-size: 10px;
      }
      .invite-poster-wrap {
        border-radius: 0;
        padding: 0;
      }
      .invite-poster-frame {
        border-radius: 16px;
      }
      .invite-avatar {
        font-size: clamp(24px, 34%, 44px);
      }
      .invite-poster-partner-caption {
        display: none;
      }
      .invite-poster-tagline-main {
        display: none;
      }
      .invite-poster-tagline-sub {
        display: none;
      }
      .invite-body {
        margin-top: 20px;
        padding: 0;
        text-align: center;
      }
      .invite-headline {
        font-size: 22px;
        line-height: 1.3;
      }
      .invite-subhead,
      .invite-social-proof {
        text-align: center;
      }
      .invite-countdown {
        margin-top: 16px;
        gap: 6px;
        width: 100%;
      }
      .invite-countdown-unit {
        flex: 1;
        min-width: 0;
        max-width: 76px;
        padding: 8px 4px;
      }
      .invite-countdown-num {
        font-size: 18px;
      }
      .invite-quote {
        margin-top: 16px;
        text-align: left;
      }
      .invite-quote-slogan {
        font-size: 15px;
      }
      .invite-chips {
        justify-content: center;
        margin-top: 16px;
      }
      .invite-action {
        display: none;
      }
      .invite-cta-dock {
        display: none;
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 40;
        padding: 10px 16px max(12px, env(safe-area-inset-bottom));
        background: linear-gradient(180deg, transparent 0%, rgba(11, 15, 26, .88) 28%, rgba(11, 15, 26, .97) 100%);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        border-top: 1px solid rgba(255, 255, 255, .06);
      }
      body.invite-unlocked .invite-cta-dock {
        display: block;
      }
      .invite-cta-dock .invite-cta {
        padding: 15px 18px;
        font-size: 15px;
      }
      .invite-footer {
        margin-top: 22px;
        padding-bottom: 4px;
      }
    }
    @media (min-width: 480px) {
      .invite-page { padding-top: max(24px, env(safe-area-inset-top)); }
      .invite-topbar {
        position: relative;
        justify-content: center;
        margin-bottom: 18px;
      }
      .invite-lang {
        position: absolute;
        right: 0;
        top: 50%;
        transform: translateY(-50%);
      }
      .invite-seal {
        justify-content: center;
        flex: none;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .invite-intro { display: none; }
      body.invite-unlocked .invite-reveal,
      body.invite-unlocked .invite-seal,
      body.invite-unlocked .invite-topbar.invite-reveal,
      body.invite-unlocked .invite-cta-dock.invite-reveal { animation: none; opacity: 1; transform: none; }
      .invite-seal-dot { animation: none; }
      .invite-cta::after { display: none; }
      .invite-cta:hover { transform: none; }
    }
    .invite-cta.is-joined {
      background: linear-gradient(135deg, #059669 0%, #047857 100%);
      box-shadow: 0 4px 20px rgba(5, 150, 105, .35);
      cursor: default;
      pointer-events: none;
    }
    .invite-cta.is-loading {
      opacity: .72;
      pointer-events: none;
    }
    ${skipEnvelope ? `
    body.invite-preview-mode .invite-reveal,
    body.invite-preview-mode .invite-seal,
    body.invite-preview-mode .invite-topbar.invite-reveal,
    body.invite-preview-mode .invite-cta-dock.invite-reveal {
      animation: none !important;
      opacity: 1 !important;
      transform: none !important;
    }` : ''}
  </style>
</head>
<body${skipEnvelope ? ' class="invite-unlocked invite-preview-mode"' : ''}>
  ${skipEnvelope ? '' : `<div class="invite-intro" id="inviteIntro" aria-hidden="true">
    <div class="envelope-scene">
      <div class="envelope" id="envelope">
        <div class="envelope-body"></div>
        <div class="envelope-paper">
          <span class="envelope-paper-label" data-i18n="paper_label">You're invited</span>
          <span class="envelope-paper-name">${safeName}</span>
          <span class="envelope-paper-event" data-i18n="paper_event">Your Event 2026 · Your City</span>
        </div>
        <div class="envelope-front"></div>
        <div class="envelope-flap"></div>
        ${envelopeWaxHtml}
      </div>
    </div>
    <p class="invite-intro-hint" data-i18n="intro_hint">Opening your invitation…</p>
  </div>`}
  <div class="invite-ambient" aria-hidden="true"></div>
  <main class="invite-page">
    <div class="invite-topbar invite-reveal d1">
      <div class="invite-seal">
        <div class="invite-seal-inner">
          <span class="invite-seal-dot" aria-hidden="true"></span>
          <span data-i18n="seal">Personal invitation</span>
        </div>
      </div>
      <div class="invite-lang" role="group" aria-label="Language">
        <button type="button" class="invite-lang-btn is-active" data-lang="en">EN</button>
        <button type="button" class="invite-lang-btn" data-lang="zh">中文</button>
      </div>
    </div>
    <div class="invite-card">
      <div class="invite-poster-wrap invite-reveal d1">
        <div class="invite-poster-frame">
          <img class="invite-poster" src="${safeHero}" alt="Your Event 2026" width="800" height="800" decoding="async" />
          ${posterOverlayHtml}
        </div>
      </div>

      <div class="invite-body">
        <h1 class="invite-headline invite-reveal d2" id="inviteHeadline">${isSide ? sideHeadlineHtml : ''}</h1>
        <p class="invite-subhead invite-reveal d3" data-i18n="subhead">Your Event 2026 · Your City</p>
        <p class="invite-social-proof invite-reveal d3" data-i18n="social_proof">via Your Org community</p>

        <div class="invite-countdown invite-reveal d3 is-countdown" id="inviteCountdown" aria-live="polite">
          <div class="invite-countdown-timer" id="inviteCountdownTimer">
            <div class="invite-countdown-unit"><span class="invite-countdown-num" id="cdDays">--</span><span class="invite-countdown-label" data-i18n="cd_days">Days</span></div>
            <div class="invite-countdown-unit"><span class="invite-countdown-num" id="cdHours">--</span><span class="invite-countdown-label" data-i18n="cd_hours">Hours</span></div>
            <div class="invite-countdown-unit"><span class="invite-countdown-num" id="cdMins">--</span><span class="invite-countdown-label" data-i18n="cd_mins">Mins</span></div>
            <div class="invite-countdown-unit"><span class="invite-countdown-num" id="cdSecs">--</span><span class="invite-countdown-label" data-i18n="cd_secs">Secs</span></div>
          </div>
          <div class="invite-countdown-status" id="inviteCountdownStatus" hidden>
            <span class="invite-countdown-status-dot" aria-hidden="true"></span>
            <span class="invite-countdown-status-text" id="inviteCountdownStatusText"></span>
          </div>
        </div>

        ${showQuoteBlock ? `<div class="invite-quote invite-reveal d4">
          ${safeQuoteMainHtml ? `<div class="invite-quote-slogan">${safeQuoteMainHtml}</div>` : ''}
          ${safeQuoteExtraHtml ? `<div class="invite-quote-detail">${safeQuoteExtraHtml}</div>` : ''}
          <div class="invite-quote-by" id="inviteQuoteBy"></div>
        </div>` : ''}

        <div class="invite-chips invite-reveal d5">
          <span class="invite-chip" data-i18n="chip_date">Your dates, 2026</span>
          <span class="invite-chip" data-i18n="chip_venue">Your Venue</span>
          <span class="invite-chip" data-i18n="chip_audience">AI founders &amp; builders</span>
        </div>

        <div class="invite-action invite-reveal d6">
          <${ctaTag}${ctaPrimaryAttrs}>
            <span id="inviteCtaText">${safeCta}</span>
            <span class="invite-cta-arrow" aria-hidden="true">${isSide && initialJoined ? '✓' : '→'}</span>
          </${ctaTag}>
          <p class="invite-cta-sub" id="inviteCtaSub">${escapeHtml(isSide ? (ctaSub || 'Free for main event ticket holders') : '')}</p>
        </div>
      </div>
    </div>

    <footer class="invite-footer invite-reveal d6">
      ${safeFpLogo ? `<img class="invite-footer-logo" src="${safeFpLogo}" alt="Your Org" />` : ''}
      <span class="invite-footer-text">${safeSubline}</span>
    </footer>
  </main>
  <div class="invite-cta-dock invite-reveal d6" id="inviteCtaDock"${skipEnvelope ? '' : ' aria-hidden="true"'}>
    <${ctaTag}${ctaStickyAttrs}>
      <span id="inviteCtaTextSticky">${safeCta}</span>
      <span class="invite-cta-arrow" aria-hidden="true">${isSide && initialJoined ? '✓' : '→'}</span>
    </${ctaTag}>
  </div>
  <script>
    (function () {
      var uid = ${JSON.stringify(uid)};
      var inviterName = ${JSON.stringify(name || 'A friend')};
      var inviterCompany = ${JSON.stringify(company || '')};
      var posterUrl = ${JSON.stringify(posterUrl || heroImageUrl || '')};
      var pageMode = ${JSON.stringify(pageMode || 'invite')};
      var partnerHeadline = ${JSON.stringify(sloganText)};
      var partnerCta = ${JSON.stringify(ctaLabel || 'Get tickets')};
      var partnerCtaSub = ${JSON.stringify(ctaSub || '')};
      var partnerSocial = ${JSON.stringify(socialProofText || '')};
      var sealPartnerEn = ${JSON.stringify(sealTextEn)};
      var sealPartnerZh = ${JSON.stringify(sealTextZh)};
      var skipIntro = ${JSON.stringify(!!skipEnvelope)};
      var skipTracking = ${JSON.stringify(!!skipTracking)};
      var posterAvatarSlot = ${JSON.stringify(posterAvatarSlot)};
      var sideEventKey = ${JSON.stringify(sideEventKey || '')};
      var shareSig = ${JSON.stringify(shareSig || '')};
      var sideJoined = ${JSON.stringify(!!initialJoined)};
      var sideJoinLabel = ${JSON.stringify(joinCtaLabel || ctaLabel || 'Join session')};
      var sideJoinedLabel = ${JSON.stringify(joinedCtaLabel || 'Joined ✓')};
      var registerUrl = ${JSON.stringify(registerUrl)};
      var eventStartAt = ${JSON.stringify(config.mainEventStartAt || '2026-08-03T09:00:00+08:00')};
      var eventEndAt = ${JSON.stringify(config.mainEventEndAt || '2026-08-04T20:30:00+08:00')};
      var lumaPageUrl = ${JSON.stringify(config.lumaEventUrl || '')};
      var mainEventPhases = pageMode === 'invite' || pageMode === 'partner';
      var countdownTimerId = null;
      var currentPhase = '';
      var viewChannel = pageMode === 'partner' ? 'partner_view' : (pageMode === 'side' ? 'side_session_view' : 'invite_view');
      var clickChannel = pageMode === 'partner' ? 'partner_click' : (pageMode === 'side' ? 'side_session_click' : 'invite_click');
      var intro = document.getElementById('inviteIntro');
      var envelope = document.getElementById('envelope');
      var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var LANG_KEY = 'agi_invite_lang';

      var I18N = {
        en: {
          intro_hint: 'Opening your invitation…',
          seal: 'Personal invitation',
          paper_label: "You're invited",
          paper_event: 'Your Event 2026 · Your City',
          subhead: 'Your Event 2026 · Your City',
          social_proof: 'via Your Org community',
          cd_days: 'Days',
          cd_hours: 'Hours',
          cd_mins: 'Mins',
          cd_secs: 'Secs',
          chip_date: 'Your dates, 2026',
          chip_venue: 'Your Venue',
          chip_audience: 'AI founders & builders',
          headline: function (n) { return '<em>' + n + '</em> invited you'; },
          quote_by: function (n, c) { return '— ' + n + (c ? ' · ' + c : ''); },
          cta: function (n) { return 'Join ' + n + ' · Get tickets'; },
          cta_sub: function (n) { return 'Referred by ' + n + ' · Secure checkout on Luma'; },
          countdown_live: 'Countdown to Aug 3',
          countdown_started: 'Your Event 2026 is underway',
          status_live: 'Live now',
          status_live_sub: 'Your Event 2026 is underway in Your City',
          status_ended: 'Event ended',
          status_ended_sub: 'Thank you for joining us',
          cta_live: 'Event details',
          cta_live_sub: 'Schedule, venue & updates on Luma',
          cta_ended: 'Recap & updates',
          cta_ended_sub: "Photos, highlights & what's next",
        },
        zh: {
          intro_hint: '正在打开你的邀请…',
          seal: '专属邀请',
          paper_label: '你收到了邀请',
          paper_event: 'Your Event 2026 · Your City',
          subhead: 'Your Event 2026 · Your City',
          social_proof: '来自 Your Org 社区',
          cd_days: '天',
          cd_hours: '时',
          cd_mins: '分',
          cd_secs: '秒',
          chip_date: '2026年8月3–4日',
          chip_venue: '滨海湾花园',
          chip_audience: 'AI 创业者与建设者',
          headline: function (n) { return '<em>' + n + '</em> 邀请你参加'; },
          quote_by: function (n, c) { return '— ' + n + (c ? ' · ' + c : ''); },
          cta: function (n) { return '跟随 ' + n + ' · 获取门票'; },
          cta_sub: function (n) { return '由 ' + n + ' 推荐 · Luma 安全购票'; },
          countdown_live: '距离 8 月 3 日',
          countdown_started: 'Your Event 2026 正在进行',
          status_live: '正在进行',
          status_live_sub: 'Your Event 2026 Your City会场进行中',
          status_ended: '活动已结束',
          status_ended_sub: '感谢参与',
          cta_live: '活动详情',
          cta_live_sub: '议程、会场与最新动态',
          cta_ended: '回顾与动态',
          cta_ended_sub: '精彩瞬间与后续资讯',
        },
      };

      function unlockInvite() {
        document.body.classList.add('invite-unlocked');
        var dock = document.getElementById('inviteCtaDock');
        if (dock) dock.removeAttribute('aria-hidden');
      }

      function preloadPoster() {
        if (!posterUrl) return;
        var img = new Image();
        img.src = posterUrl;
      }

      function syncInvitePosterAvatar() {
        var frame = document.querySelector('.invite-poster-frame');
        var posterImg = frame && frame.querySelector('.invite-poster');
        var overlay = frame && frame.querySelector('.invite-poster-overlay');
        var slotEl = frame && frame.querySelector('.invite-poster-avatar-slot');
        if (!frame || !posterImg || !overlay || !slotEl) return;
        var nw = posterImg.naturalWidth;
        var nh = posterImg.naturalHeight;
        if (!nw || !nh) return;
        var fw = frame.clientWidth;
        var fh = frame.clientHeight;
        if (!fw || !fh) return;
        var scale = Math.min(fw / nw, fh / nh);
        var w = nw * scale;
        var h = nh * scale;
        var x = (fw - w) / 2;
        var y = (fh - h) / 2;
        overlay.style.left = x + 'px';
        overlay.style.top = y + 'px';
        overlay.style.width = w + 'px';
        overlay.style.height = h + 'px';
        var size = h * posterAvatarSlot.size;
        slotEl.style.width = size + 'px';
        slotEl.style.height = size + 'px';
        slotEl.style.left = (w * posterAvatarSlot.cx) + 'px';
        slotEl.style.top = (h * posterAvatarSlot.cy) + 'px';
        frame.classList.add('is-avatar-slot-ready');
      }

      function scheduleInvitePosterAvatarSync() {
        requestAnimationFrame(function () {
          requestAnimationFrame(syncInvitePosterAvatar);
        });
      }

      function bindInvitePoster() {
        var frame = document.querySelector('.invite-poster-frame');
        var posterImg = document.querySelector('.invite-poster');
        if (!frame || !posterImg) return;
        var run = function () { scheduleInvitePosterAvatarSync(); };
        if (posterImg.complete && posterImg.naturalWidth) run();
        else posterImg.addEventListener('load', run, { once: true });
        window.addEventListener('resize', run);
        if (typeof ResizeObserver !== 'undefined') {
          new ResizeObserver(run).observe(frame);
        }
      }

      bindInvitePoster();

      function escHtml(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }

      function inviteHeadlineHtml(lang) {
        var em = '<em>' + escHtml(inviterName) + '</em>';
        return lang === 'zh' ? em + ' 邀请你参加' : em + ' invited you';
      }

      function applyLang(lang) {
        var pack = I18N[lang] || I18N.en;
        document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
        document.querySelectorAll('[data-i18n]').forEach(function (el) {
          var key = el.getAttribute('data-i18n');
          if (pack[key]) el.textContent = pack[key];
        });
        var sealEl = document.querySelector('.invite-seal [data-i18n="seal"]');
        if ((pageMode === 'partner' || pageMode === 'side') && sealEl) {
          sealEl.textContent = lang === 'zh' ? sealPartnerZh : sealPartnerEn;
        }
        var headline = document.getElementById('inviteHeadline');
        if (headline) {
          if (pageMode === 'side') {
            /* rendered server-side */
          } else if (pageMode === 'partner') {
            headline.innerHTML = partnerHeadline.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          } else {
            headline.innerHTML = inviteHeadlineHtml(lang);
          }
        }
        var quoteBy = document.getElementById('inviteQuoteBy');
        if (quoteBy) {
          quoteBy.textContent = pageMode === 'partner'
            ? (partnerSocial || ('— ' + inviterName))
            : (pageMode === 'side'
              ? (lang === 'zh' ? '— 持主会场票免费参加' : '— Free for main event ticket holders')
              : pack.quote_by(inviterName, inviterCompany));
        }
        var socialEl = document.querySelector('.invite-social-proof');
        if (socialEl && pageMode === 'partner' && partnerSocial) {
          socialEl.textContent = partnerSocial;
        } else if (socialEl && pageMode === 'side') {
          socialEl.textContent = lang === 'zh' ? '持主会场票免费参加' : 'Free for main event ticket holders';
        }
        var ctaText = document.getElementById('inviteCtaText');
        if (ctaText && pageMode !== 'side') {
          if (mainEventPhases && (currentPhase === 'live' || currentPhase === 'ended')) {
            ctaText.textContent = currentPhase === 'live' ? pack.cta_live : pack.cta_ended;
          } else {
            ctaText.textContent = pageMode === 'partner' ? partnerCta : pack.cta(inviterName);
          }
        }
        var ctaTextSticky = document.getElementById('inviteCtaTextSticky');
        if (ctaTextSticky && pageMode !== 'side') {
          if (mainEventPhases && (currentPhase === 'live' || currentPhase === 'ended')) {
            ctaTextSticky.textContent = currentPhase === 'live' ? pack.cta_live : pack.cta_ended;
          } else {
            ctaTextSticky.textContent = pageMode === 'partner' ? partnerCta : pack.cta(inviterName);
          }
        }
        var ctaSub = document.getElementById('inviteCtaSub');
        if (ctaSub && pageMode !== 'side') {
          if (mainEventPhases && currentPhase === 'live') {
            ctaSub.textContent = pack.cta_live_sub;
          } else if (mainEventPhases && currentPhase === 'ended') {
            ctaSub.textContent = pack.cta_ended_sub;
          } else {
            ctaSub.textContent = pageMode === 'partner'
              ? (partnerCtaSub || ('Exclusive access via ' + inviterName + ' · Secure checkout on Luma'))
              : pack.cta_sub(inviterName);
          }
        }
        document.querySelectorAll('.invite-lang-btn').forEach(function (btn) {
          btn.classList.toggle('is-active', btn.getAttribute('data-lang') === lang);
        });
        try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
        updateCountdown(lang);
      }

      function detectLang() {
        try {
          var saved = localStorage.getItem(LANG_KEY);
          if (saved === 'en' || saved === 'zh') return saved;
        } catch (e) {}
        return 'en';
      }

      function stopCountdownTimer() {
        if (countdownTimerId) {
          clearInterval(countdownTimerId);
          countdownTimerId = null;
        }
      }

      function getEventPhase() {
        if (!mainEventPhases) return 'countdown';
        var now = Date.now();
        var start = new Date(eventStartAt).getTime();
        var end = new Date(eventEndAt).getTime();
        if (now >= end) return 'ended';
        if (now >= start) return 'live';
        return 'countdown';
      }

      function applyPhaseCta(lang, phase) {
        if (!mainEventPhases || pageMode === 'side') return;
        var pack = I18N[lang] || I18N.en;
        var ctaText = document.getElementById('inviteCtaText');
        var ctaTextSticky = document.getElementById('inviteCtaTextSticky');
        var ctaSub = document.getElementById('inviteCtaSub');
        var btn = document.getElementById('registerBtn');
        var btnSticky = document.getElementById('registerBtnSticky');
        if (phase === 'live') {
          if (ctaText) ctaText.textContent = pack.cta_live;
          if (ctaTextSticky) ctaTextSticky.textContent = pack.cta_live;
          if (ctaSub) ctaSub.textContent = pack.cta_live_sub;
          [btn, btnSticky].forEach(function (el) {
            if (el && el.tagName === 'A' && lumaPageUrl) el.href = lumaPageUrl;
          });
        } else if (phase === 'ended') {
          if (ctaText) ctaText.textContent = pack.cta_ended;
          if (ctaTextSticky) ctaTextSticky.textContent = pack.cta_ended;
          if (ctaSub) ctaSub.textContent = pack.cta_ended_sub;
          [btn, btnSticky].forEach(function (el) {
            if (el && el.tagName === 'A' && lumaPageUrl) el.href = lumaPageUrl;
          });
        } else {
          if (ctaText) ctaText.textContent = pageMode === 'partner' ? partnerCta : pack.cta(inviterName);
          if (ctaTextSticky) ctaTextSticky.textContent = pageMode === 'partner' ? partnerCta : pack.cta(inviterName);
          if (ctaSub) {
            ctaSub.textContent = pageMode === 'partner'
              ? (partnerCtaSub || ('Exclusive access via ' + inviterName + ' · Secure checkout on Luma'))
              : pack.cta_sub(inviterName);
          }
          [btn, btnSticky].forEach(function (el) {
            if (el && el.tagName === 'A') el.href = registerUrl;
          });
        }
      }

      function updateCountdown(lang) {
        var phase = getEventPhase();
        var cd = document.getElementById('inviteCountdown');
        var status = document.getElementById('inviteCountdownStatus');
        var statusText = document.getElementById('inviteCountdownStatusText');
        var dEl = document.getElementById('cdDays');
        var hEl = document.getElementById('cdHours');
        var mEl = document.getElementById('cdMins');
        var sEl = document.getElementById('cdSecs');
        if (!cd || !dEl || !hEl || !mEl || !sEl) return;
        var pack = I18N[lang] || I18N.en;

        if (mainEventPhases && phase === 'live') {
          cd.classList.remove('is-countdown', 'is-ended');
          cd.classList.add('is-live');
          if (status) status.hidden = false;
          if (statusText) statusText.textContent = pack.status_live;
          cd.setAttribute('aria-label', pack.status_live_sub);
          if (phase !== currentPhase) {
            currentPhase = phase;
            applyPhaseCta(lang, phase);
          }
          stopCountdownTimer();
          return;
        }

        if (mainEventPhases && phase === 'ended') {
          cd.classList.remove('is-countdown', 'is-live');
          cd.classList.add('is-ended');
          if (status) status.hidden = false;
          if (statusText) statusText.textContent = pack.status_ended + ' · ' + pack.status_ended_sub;
          cd.setAttribute('aria-label', pack.status_ended);
          if (phase !== currentPhase) {
            currentPhase = phase;
            applyPhaseCta(lang, phase);
          }
          stopCountdownTimer();
          return;
        }

        cd.classList.remove('is-live', 'is-ended');
        cd.classList.add('is-countdown');
        if (status) status.hidden = true;
        if (phase !== currentPhase && currentPhase !== 'countdown') {
          currentPhase = 'countdown';
          applyPhaseCta(lang, 'countdown');
        } else {
          currentPhase = 'countdown';
        }

        var target = new Date(eventStartAt).getTime();
        var diff = target - Date.now();
        if (diff <= 0) {
          if (!mainEventPhases) {
            dEl.textContent = '0';
            hEl.textContent = '0';
            mEl.textContent = '0';
            sEl.textContent = '0';
            cd.setAttribute('aria-label', pack.countdown_started);
          }
          return;
        }
        var days = Math.floor(diff / 86400000);
        var hours = Math.floor((diff % 86400000) / 3600000);
        var mins = Math.floor((diff % 3600000) / 60000);
        var secs = Math.floor((diff % 60000) / 1000);
        dEl.textContent = String(days);
        hEl.textContent = String(hours);
        mEl.textContent = String(mins);
        sEl.textContent = secs < 10 ? '0' + secs : String(secs);
        cd.setAttribute('aria-label', pack.countdown_live);
      }

      function runEnvelopeIntro() {
        preloadPoster();
        if (reduced || !intro || !envelope) {
          unlockInvite();
          if (intro) intro.remove();
          return;
        }
        window.setTimeout(function () {
          envelope.classList.add('is-opening');
        }, 420);
        window.setTimeout(function () {
          intro.classList.add('is-done');
          unlockInvite();
        }, 1450);
        window.setTimeout(function () {
          if (intro.parentNode) intro.remove();
        }, 2100);
      }

      if (skipIntro) {
        preloadPoster();
      } else {
        runEnvelopeIntro();
      }
      var currentLang = detectLang();
      var initialPhase = getEventPhase();
      if (mainEventPhases && pageMode === 'invite') {
        if (initialPhase === 'live') viewChannel = 'invite_view_live';
        else if (initialPhase === 'ended') viewChannel = 'invite_view_ended';
      }
      applyLang(currentLang);
      if (currentPhase !== 'live' && currentPhase !== 'ended') {
        countdownTimerId = window.setInterval(function () { updateCountdown(currentLang); }, 1000);
      }

      document.querySelectorAll('.invite-lang-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          currentLang = btn.getAttribute('data-lang') || 'en';
          applyLang(currentLang);
        });
      });

      if (!skipTracking) {
        var inviteUtm = '';
        try { inviteUtm = new URLSearchParams(window.location.search).get('utm_source') || ''; } catch (e) {}
        if (pageMode === 'side' && sideEventKey) {
          inviteUtm = inviteUtm || ('side__' + sideEventKey);
        }
        function getVisitorId() {
          var key = 'agi_visitor_id';
          try {
            var id = sessionStorage.getItem(key);
            if (!id) {
              id = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
              sessionStorage.setItem(key, id);
            }
            return id;
          } catch (e) {
            return 'v_' + Date.now();
          }
        }
        var visitorId = getVisitorId();
        fetch('/api/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid: uid, name: inviterName, channel: viewChannel, utm_source: inviteUtm, visitor_id: visitorId })
        }).catch(function () {});
      }
      var btn = document.getElementById('registerBtn');
      var btnSticky = document.getElementById('registerBtnSticky');

      function setSideJoinedUi() {
        sideJoined = true;
        [btn, btnSticky].forEach(function (el) {
          if (!el) return;
          el.classList.remove('is-loading');
          el.classList.add('is-joined');
          el.disabled = true;
          var label = el.querySelector('#inviteCtaText, #inviteCtaTextSticky, span');
          if (label) label.textContent = sideJoinedLabel;
          var arrow = el.querySelector('.invite-cta-arrow');
          if (arrow) arrow.textContent = '✓';
        });
        var sub = document.getElementById('inviteCtaSub');
        if (sub) sub.textContent = sideJoinedLabel;
      }

      function trackSideClick() {
        if (skipTracking) return;
        var visitorId = (function () {
          var key = 'agi_visitor_id';
          try { return sessionStorage.getItem(key) || ''; } catch (e) { return ''; }
        })();
        fetch('/api/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uid: uid,
            name: inviterName,
            channel: clickChannel,
            utm_source: sideEventKey ? ('side__' + sideEventKey) : '',
            visitor_id: visitorId,
          }),
        }).catch(function () {});
      }

      function handleSideJoin() {
        if (pageMode !== 'side' || sideJoined) return;
        [btn, btnSticky].forEach(function (el) { if (el) el.classList.add('is-loading'); });
        fetch('/api/side-events/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid: uid, sig: shareSig, eventKey: sideEventKey }),
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
          .then(function (res) {
            if (res.ok && res.data && res.data.success) {
              setSideJoinedUi();
              return;
            }
            var msg = (res.data && res.data.message) || 'Registration failed. Please try again.';
            alert(msg);
          })
          .catch(function () { alert('Network error. Please try again.'); })
          .finally(function () {
            [btn, btnSticky].forEach(function (el) {
              if (el && !sideJoined) el.classList.remove('is-loading');
            });
          });
      }

      function trackInviteClick() {
        if (skipTracking) return;
        var visitorId = (function () {
          var key = 'agi_visitor_id';
          try { return sessionStorage.getItem(key) || ''; } catch (e) { return ''; }
        })();
        fetch('/api/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid: uid, name: inviterName, channel: clickChannel, visitor_id: visitorId })
        }).catch(function () {});
      }

      if (pageMode === 'side') {
        if (sideJoined) setSideJoinedUi();
        [btn, btnSticky].forEach(function (el) {
          if (!el) return;
          el.addEventListener('click', function (ev) {
            ev.preventDefault();
            if (sideJoined) return;
            trackSideClick();
            handleSideJoin();
          });
        });
      } else {
        [btn, btnSticky].forEach(function (el) {
          if (el) el.addEventListener('click', trackInviteClick);
        });
      }
    })();
  </script>
</body>
</html>`;
}

/** 获取测试邮箱列表 */
function getTestInboxes() {
  const raw = config.testInboxes || config.testInbox;
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((e) => e.trim()).filter(Boolean);
}

/** 注册邮箱是否在测试列表中 */
function isTestAccount(email) {
  return getTestInboxes().includes(email);
}
async function sendWelcomeEmail(record, siteBaseUrl, options = {}) {
  const transporter = createMailTransporter();
  const { name, referral_id, company } = record;
  const to = options.to || record.email;
  const shareLink = buildSharePageUrlForEmail(name, referral_id, siteBaseUrl, company);
  const subject = `${options.subjectPrefix || ''}${config.mailSubject}`;
  const siteBase = String(siteBaseUrl || config.siteBaseUrl || '').replace(/\/$/, '');
  const uid = String(referral_id || '').trim();
  const avatarUrl = uid ? sanitizeAvatarUrl(getShareAvatar(uid), config) : '';
  const posterImageUrl = uid
    ? buildOgImageUrl(siteBase, uid, name, company, { avatarUrl })
    : (config.posterImageUrl || '');
  const mailOpts = {
    posterImageUrl,
    lumaEventUrl: config.lumaEventUrl,
  };

  const info = await transporter.sendMail({
    from: config.mailFrom,
    to,
    replyTo: config.mailReplyTo || config.smtp.user,
    subject,
    text: buildEmailText(name, shareLink, config.lumaEventUrl),
    html: buildEmailHtml(name, shareLink, mailOpts),
    headers: {
      'X-Entity-Ref-ID': `agi-${referral_id || 'guest'}`,
    },
  });

  if (shareLink.includes('ngrok') || shareLink.includes('localhost')) {
    console.warn('[邮件] 链接含 ngrok/localhost，Gmail 易判垃圾邮件，建议上线正式域名');
  }

  console.log('[邮件] 发送成功:', {
    to,
    messageId: info.messageId,
    shareLink,
    previewImage: posterImageUrl,
  });
}

/** 邮件发送失败自动重试（Webhook 已 200，需本地补偿） */
async function sendWelcomeEmailWithRetry(record, siteBaseUrl, options = {}, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await sendWelcomeEmail(record, siteBaseUrl, options);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[邮件] 第 ${attempt}/${maxAttempts} 次失败 (${options.to || record.email}):`, err.message);
      if (attempt < maxAttempts) {
        await sleep(2000 * attempt);
      }
    }
  }
  throw lastErr;
}

/** utm_source 分隔符（Luma 会吃掉 |，改用 __） */
const UTM_SEP = '__';

/** 解析 utm_source：格式 channel__referrerUid（兼容 | 与 Luma 粘连的 copyusr-xxx） */
function parseUtmSource(utm) {
  if (!utm) return { register_channel: '', referred_by: '' };
  const s = String(utm);

  if (s.includes(UTM_SEP)) {
    const [register_channel, referred_by] = s.split(UTM_SEP, 2);
    return { register_channel: register_channel || '', referred_by: referred_by || '' };
  }
  if (s.includes('|')) {
    const [register_channel, referred_by] = s.split('|', 2);
    return { register_channel: register_channel || '', referred_by: referred_by || '' };
  }
  for (const ch of UTM_CHANNEL_PREFIXES) {
    if (s.startsWith(`${ch}usr-`)) {
      return { register_channel: ch, referred_by: s.slice(ch.length) };
    }
  }
  return { register_channel: s, referred_by: '' };
}

/** 从 Webhook 原始 payload 提取 Luma 活动信息（兼容多种 Luma 字段形态） */
function extractLumaEvent(payload) {
  const d = payload?.data;
  const nested = d?.event || payload?.event;
  if (nested?.url) {
    return {
      url: normalizeLumaEventUrl(nested.url),
      name: nested.name || '',
      apiId: nested.api_id || nested.id || '',
    };
  }

  const directUrl = d?.event_url || d?.luma_event_url || payload?.event_url;
  if (directUrl) {
    return {
      url: normalizeLumaEventUrl(directUrl),
      name: d?.event_name || payload?.event_name || '',
      apiId: d?.event_api_id || d?.event_id || '',
    };
  }

  const eventApiId = String(
    d?.event_api_id || d?.event_id || nested?.api_id || nested?.id || '',
  ).trim();
  if (eventApiId) {
    const side = getSideEventsConfig().find((e) => e.eventId === eventApiId);
    if (side?.url) {
      return {
        url: normalizeLumaEventUrl(side.url),
        name: side.name || '',
        apiId: eventApiId,
      };
    }
  }

  return null;
}

/** guest 类 Webhook 缺少 event 时，回退主会 URL（真实 Luma 推送常不带 data.event） */
function resolveWebhookEvent(payload) {
  const event = extractLumaEvent(payload);
  if (event?.url) return event;

  const type = String(payload?.type || '').trim();
  const guestTypes = new Set(['guest.registered', 'guest.updated', 'ticket.registered']);
  if (!guestTypes.has(type)) return null;

  const main = normalizeLumaEventUrl(config.lumaEventUrl);
  if (!main) return null;

  console.warn('[Webhook] payload 缺少 event.url，回退主会:', main, '| type:', type);
  return { url: main, name: '', apiId: '' };
}

/** 是否允许处理该 Webhook（按 allowedLumaEventUrls 过滤） */
function isWebhookEventAllowed(payload) {
  const allowed = config.allowedLumaEventUrls;
  if (!allowed || !allowed.length) return true;

  const type = payload?.type || '';
  if (!isProduction()) {
    if (type === 'local.test' || (payload?.email && !payload?.data)) return true;
  }

  const event = resolveWebhookEvent(payload);
  if (!event?.url) {
    console.warn('[Webhook] 无法识别活动 URL，已跳过');
    return false;
  }

  const normalized = allowed.map((u) => normalizeLumaEventUrl(u));
  if (!normalized.includes(event.url)) {
    console.warn('[Webhook] 活动 URL 不在允许列表，已跳过:', event.url);
    return false;
  }
  return true;
}

/** 从 Luma guest payload 提取报名来源信号 */
function extractRegistrationSignals(d) {
  const invitedAt = d?.invited_at ? String(d.invited_at).trim() : '';
  const registeredAt = d?.registered_at ? String(d.registered_at).trim() : '';
  const hasRegistrationAnswers = Array.isArray(d?.registration_answers) && d.registration_answers.length > 0;
  const hasTicketOrders = Array.isArray(d?.event_ticket_orders) && d.event_ticket_orders.length > 0;
  let couponApplied = false;

  if (hasTicketOrders) {
    couponApplied = d.event_ticket_orders.some((order) => {
      const coupon = order?.coupon_info;
      return !!(coupon && (coupon.api_id || coupon.code || coupon.percent_off != null || coupon.cents_off));
    });
  }

  if (!couponApplied && Array.isArray(d?.event_tickets)) {
    couponApplied = d.event_tickets.some((t) => !!(t?.coupon_info || t?.coupon_code));
  }
  if (!couponApplied && d?.event_ticket) {
    const t = d.event_ticket;
    couponApplied = !!(t?.coupon_info || t?.coupon_code);
  }

  return {
    invited_at: invitedAt,
    registered_at: registeredAt,
    coupon_applied: couponApplied,
    has_registration_answers: hasRegistrationAnswers,
    has_ticket_orders: hasTicketOrders,
  };
}

function getGuestTickets(meta) {
  return Array.isArray(meta?.tickets) ? meta.tickets : [];
}

/** 用户是否已完成报名/checkout（含确认参加） */
function hasUserCompletedRegistration(meta) {
  const status = String(meta.approval_status || '').trim();
  if (status === 'invited') return false;

  const invitedAt = String(meta.invited_at || '').trim();

  // 免费票码兑换 / 结账时用了优惠码
  if (meta.coupon_applied) return true;

  // 用户填写了报名表单
  if (meta.has_registration_answers) return true;

  // 自行报名（无 invited_at）：有票或订单即视为 checkout 成功（金额可为 $0）
  if (!invitedAt) {
    if (getGuestTickets(meta).length) return true;
    if (meta.has_ticket_orders) return true;
  }

  // 后台邀请：须用户确认参加（registered_at 晚于 invited_at）
  const registeredAt = String(meta.registered_at || '').trim();
  if (invitedAt && registeredAt && registeredAt > invitedAt) return true;

  return false;
}

/** 是否应向该用户发送分享欢迎邮件 */
function shouldSendWelcomeEmailForGuest(meta) {
  if (!shouldSendWelcomeEmail(meta.approval_status)) return false;

  if (config.welcomeEmailRequireUserConfirmation === false) return true;

  return hasUserCompletedRegistration(meta);
}

function welcomeEmailSkipReason(meta) {
  if (!shouldSendWelcomeEmail(meta.approval_status)) return '';
  if (config.welcomeEmailRequireUserConfirmation === false) return '';

  const status = String(meta.approval_status || '').trim();
  if (status === 'invited') return '已邀请，待用户确认参加';

  const invitedAt = String(meta.invited_at || '').trim();
  if (invitedAt && !hasUserCompletedRegistration(meta)) {
    return '后台已添加，待用户确认参加';
  }

  if (!hasUserCompletedRegistration(meta)) return '等待报名/checkout 完成';

  return '';
}

/**
 * 解析 Webhook 数据（Luma 官方 + 本地测试）
 */
function normalizeWebhookPayload(payload) {
  const type = payload.type || 'local.test';

  if (payload.email && !payload.data) {
    const utm = parseUtmSource(payload.utm_source || '');
    return {
      type,
      name: payload.name || '',
      email: payload.email || '',
      company: payload.company || '',
      referral_id: payload.referral_id || '',
      referred_by: payload.referred_by || utm.referred_by,
      register_channel: payload.register_channel || utm.register_channel,
      utm_source: payload.utm_source || '',
      approval_status: payload.approval_status || 'approved',
      invited_at: payload.invited_at || '',
      registered_at: payload.registered_at || '',
      coupon_applied: !!payload.coupon_applied,
      has_registration_answers: !!payload.has_registration_answers,
      has_ticket_orders: !!payload.has_ticket_orders,
      tickets: [],
    };
  }

  if (payload.data && typeof payload.data === 'object') {
    const d = payload.data;
    const {
      invited_at,
      registered_at,
      coupon_applied,
      has_registration_answers,
      has_ticket_orders,
    } = extractRegistrationSignals(d);
    let company = '';

    if (Array.isArray(d.registration_answers)) {
      for (const ans of d.registration_answers) {
        if (ans.question_type === 'company' && ans.value && typeof ans.value === 'object') {
          company = ans.value.company || '';
          if (company) break;
        }
      }
    }

    const name =
      d.user_name ||
      [d.user_first_name, d.user_last_name].filter(Boolean).join(' ') ||
      '';

    const utm = parseUtmSource(d.utm_source || d.custom_source || '');

    // 尝试从 Luma 数据中提取推荐人（不同版本字段名可能不同）
    const referred_by =
      d.referrer_user_id ||
      d.referred_by_user_id ||
      d.inviter_user_id ||
      d.referral_user_id ||
      utm.referred_by ||
      '';

    const tickets = [];
    if (d.event_ticket) tickets.push(d.event_ticket);
    if (Array.isArray(d.event_tickets)) tickets.push(...d.event_tickets);

    return {
      type,
      name,
      email: d.user_email || '',
      company,
      referral_id: d.user_id || d.id || '',
      luma_guest_id: d.id || d.api_id || '',
      referred_by,
      register_channel: utm.register_channel,
      utm_source: d.utm_source || d.custom_source || '',
      approval_status: d.approval_status || '',
      invited_at,
      registered_at,
      coupon_applied,
      has_registration_answers,
      has_ticket_orders,
      tickets,
    };
  }

  return {
    type,
    name: payload.name || '',
    email: payload.email || '',
    company: payload.company || '',
    referral_id: payload.referral_id || '',
    referred_by: '',
    register_channel: '',
    utm_source: '',
    approval_status: payload.approval_status || '',
    invited_at: '',
    registered_at: '',
    coupon_applied: false,
    has_registration_answers: false,
    has_ticket_orders: false,
    tickets: [],
  };
}

/** 是否应向该用户发送分享欢迎邮件 */
function shouldSendWelcomeEmail(approvalStatus) {
  const status = String(approvalStatus || '').trim();

  if (config.requireApprovalBeforeEmail) {
    return status === 'approved';
  }

  // 购票/即时确认活动：pending、declined 不发
  if (status === 'pending_approval' || status === 'declined') return false;
  return true;
}

/** 从 Webhook 记录购票信息 */
function processTickets(meta) {
  if (!meta.tickets || !meta.tickets.length) return;

  for (const t of meta.tickets) {
    const logged = logTicketEvent({
      luma_guest_id: meta.luma_guest_id || '',
      guest_email: meta.email,
      guest_name: meta.name,
      ticket_name: t.name || '',
      ticket_amount: t.amount || 0,
      ticket_currency: t.currency || '',
      referred_by: meta.referred_by,
      register_channel: meta.register_channel,
      is_captured: !!t.is_captured,
    });
    if (logged) {
      console.log('[购票] 已记录:', {
        email: meta.email,
        ticket: t.name,
        amount: t.amount,
        currency: t.currency,
        captured: !!t.is_captured,
      });
    }
  }
}

/** Side Event 本地报名状态：持主会票免审；否则跟随 Luma 审核 */
function resolveSideEventRsvpStatus(email, approvalStatus) {
  const mail = String(email || '').trim();
  const status = String(approvalStatus || '').trim();

  if (hasActiveMainEventRegistration(mail)) {
    return 'joined';
  }

  if (status === 'pending_approval') return 'pending_approval';
  if (status === 'approved' || !status) return 'joined';
  return 'pending_approval';
}

/** Side Event Webhook：只记 side_event_rsvps，不进主会名单、不发分享邮件 */
async function processSideEventWebhook(rawPayload, meta, session) {
  const { name, email, referral_id, approval_status, type } = meta;
  const eventKey = normalizeSideEventKey(session.key);

  console.log(
    '[Webhook] Side Event 分流:',
    session.name || eventKey,
    '| 类型:', type,
    '| 审核:', approval_status || '(无)',
  );

  if (type === 'ticket.registered') {
    processTickets(meta);
    return;
  }

  if (!email) {
    console.warn('[Webhook] Side Event 缺少 email，跳过');
    return;
  }

  const uid = String(referral_id || '').trim();
  if (!uid) {
    console.warn('[Webhook] Side Event 缺少 user_id，跳过:', email);
    return;
  }

  const status = String(approval_status || '').trim();

  if (status === 'declined') {
    const removed = deleteSideEventRsvp(uid, eventKey)
      || deleteSideEventRsvpByEmail(email.trim(), eventKey);
    console.log(
      '[Webhook] Side Event 不参加/已拒绝:',
      email,
      eventKey,
      removed ? '(已删除该场记录)' : '(无历史记录)',
    );
    return;
  }

  let rsvpStatus = resolveSideEventRsvpStatus(email, status);
  const mainHolder = hasActiveMainEventRegistration(email.trim());

  saveSideEventRsvp({
    referral_id: uid,
    email: email.trim(),
    name: name || '',
    side_event_key: eventKey,
    luma_event_id: session.eventId,
    luma_guest_id: meta.luma_guest_id || '',
    source: 'luma_webhook',
    status: rsvpStatus,
  });

  console.log('[Webhook] Side Event 已记录（不进主会名单）:', {
    email: email.trim(),
    eventKey,
    status: rsvpStatus,
    mainEventHolder: mainHolder,
  });
}

/** 异步处理 Webhook 业务逻辑 */
async function processWebhook(rawPayload, siteBaseUrl) {
  const lumaEvent = resolveWebhookEvent(rawPayload);
  const meta = normalizeWebhookPayload(rawPayload);
  const {
    name, email, company, referral_id, referred_by, register_channel, utm_source,
    approval_status, type,
  } = meta;

  if (lumaEvent?.url) {
    const sideSession = resolveSideEventFromLumaUrl(lumaEvent.url);
    if (sideSession && !isMainEventLumaUrl(lumaEvent.url)) {
      await processSideEventWebhook(rawPayload, meta, sideSession);
      return;
    }
    if (!isMainEventLumaUrl(lumaEvent.url)) {
      console.warn('[Webhook] 未映射的活动 URL，已跳过:', lumaEvent.url);
      return;
    }
    console.log('[Webhook] Main Event 分流:', lumaEvent.name || lumaEvent.url);
  }

  console.log('[Webhook] 事件类型:', type, '审核状态:', approval_status || '(无)');

  // 购票类 Webhook
  if (type === 'ticket.registered') {
    processTickets(meta);
    return;
  }

  if (!email) {
    console.warn('[Webhook] 缺少 email 字段，跳过处理:', rawPayload);
    return;
  }

  const record = {
    name: name || '',
    email: email.trim(),
    company: company || '',
    referral_id: referral_id || '',
    referred_by: referred_by || '',
    register_channel: register_channel || '',
    utm_source: utm_source || '',
  };

  const status = String(approval_status || '').trim();

  // 不参加 / 已拒绝：不算活动嘉宾，移出名单并终止后续流程
  if (status === 'declined') {
    processTickets(meta);
    const removed = removeRegistrantByEmail(record.email);
    console.log(
      '[Webhook] 不参加/已拒绝，已移出活动:',
      record.email,
      removed ? '(已删除记录)' : '(无历史记录)',
    );
    return;
  }

  const canSendEmail = shouldSendWelcomeEmailForGuest(meta);
  const emailSkipReason = canSendEmail ? '' : welcomeEmailSkipReason(meta);
  const statusToSave = status || (shouldSendWelcomeEmail(approval_status) ? 'approved' : 'pending_approval');

  console.log('[Webhook] 开始处理用户数据:', record, '状态:', statusToSave);

  try {
    processTickets(meta);

    const isNew = saveRegistrant({ ...record, approval_status: statusToSave });
    const testInboxes = getTestInboxes();
    const isSelfTest = config.testMode && isTestAccount(record.email);
    const shouldSendTestCopy = canSendEmail && !isWelcomeEmailSent(record.email);

    if (config.welcomeEmailEnabled !== false && config.testMode && testInboxes.length && shouldSendTestCopy) {
      const prefix = isSelfTest ? '' : `[测试→${record.email}] `;
      const targets = testInboxes.filter((addr) => addr !== record.email);

      for (const inbox of targets) {
        await sendWelcomeEmailWithRetry(record, siteBaseUrl, {
          to: inbox,
          subjectPrefix: prefix,
        });
      }
      if (targets.length) {
        console.log('[邮件] 测试副本已发送至:', targets.join(', '));
      }
    }

    if (!canSendEmail) {
      if (emailSkipReason) {
        console.log('[Webhook] 跳过欢迎邮件:', record.email, '—', emailSkipReason);
      } else {
        console.log('[Webhook] 暂不发送邮件（待审核）:', record.email, statusToSave);
        if (isNew) console.log('[Webhook] 待审核用户已暂存（不计入有效报名）:', record.email);
      }
      return;
    }

    if (config.welcomeEmailEnabled === false) {
      console.log('[Webhook] 欢迎邮件已关闭（welcomeEmailEnabled: false），用户已入库:', record.email);
      return;
    }

    if (!tryClaimWelcomeEmailSend(record.email)) {
      console.log('[Webhook] 分享邮件已发送过，跳过:', record.email);
      return;
    }

    if (isNew) {
      console.log('[Webhook] 新用户已入库:', record.email);
    } else {
      console.log('[Webhook] 审核通过，补发分享邮件:', record.email);
    }

    try {
      await sendWelcomeEmailWithRetry(record, siteBaseUrl);
    } catch (sendErr) {
      releaseWelcomeEmailSendClaim(record.email);
      throw sendErr;
    }
  } catch (err) {
    console.error('[Webhook] 处理失败:', {
      email: record.email,
      error: err.message,
      stack: err.stack,
    });
  }
}

/** Luma Webhook 接收接口 POST /api/luma-webhook */
app.post('/api/luma-webhook', webhookLimiter, (req, res) => {
  if (!verifyWebhookRequest(req)) {
    console.warn('[Webhook] 鉴权失败，已拒绝');
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }

  const payload = req.body;
  const siteBaseUrl = resolveSiteBaseUrl(req);
  console.log('[Webhook] 收到推送:', summarizeWebhookPayload(payload));
  console.log('[Webhook] 自动识别站点地址:', siteBaseUrl);

  // 立即返回 200，避免 Luma 重复重试
  res.status(200).json({ success: true, message: '数据已接收' });

  if (!isWebhookEventAllowed(payload)) {
    return;
  }

  processWebhook(payload, siteBaseUrl).catch((err) => {
    console.error('[Webhook] 异步处理异常:', err.message);
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', appVersion: APP_VERSION, time: new Date().toISOString() });
});

app.get('/api/public-config', (_req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({
    appVersion: APP_VERSION,
    defaultShareMessage: DEFAULT_SHARE_MESSAGE,
    defaultPosterSlogan: DEFAULT_POSTER_SLOGAN,
    defaultEmailSubject: DEFAULT_EMAIL_SUBJECT,
    platformShareMessages: PLATFORM_SHARE_MESSAGES,
    legacyPosterSlogans: LEGACY_POSTER_SLOGANS,
    eventSubline: EVENT_SUBLINE,
    legacyShareMessages: LEGACY_SHARE_MESSAGES,
    lumaEventUrl: buildLumaRegisterUrl('', '') || config.lumaEventUrl,
    posterImageUrl: config.posterImageUrl || '',
    posterAvatarSlot: POSTER_AVATAR_SLOT,
    invitePosterImageUrl: resolveInstagramStoryPosterImageUrl(),
    inviteLandingPosterImageUrl: resolveInviteLandingPosterImageUrl(),
    invitePosterAvatarSlot: INSTAGRAM_STORY_AVATAR_SLOT,
    inviteLandingPosterAvatarSlot: INVITE_LANDING_AVATAR_SLOT,
    fpLogoUrl: config.fpLogoUrl || '',
    geekparkLogoUrl: config.geekparkLogoUrl || '',
    siteBaseUrl: config.siteBaseUrl.replace(/\/$/, ''),
    shareLinkSigned: isShareLinkSecretConfigured(),
    sideSessionsShareEnabled: isSideSessionsShareEnabled(),
    sideEvents: getSideEventsPublicList(),
    sideEventsEnabled: isSideSessionsShareEnabled() && isLumaApiConfigured() && getSideEventsConfig().length > 0,
  });
});

/** 校验分享页访问权限：uid 签名 + 已报名 */
app.get('/api/verify-share-access', verifyAccessLimiter, (req, res) => {
  const uid = sanitizeUid(req.query.uid);
  const sig = String(req.query.sig || '').trim();

  if (!uid) {
    res.json({ valid: false, reason: 'missing_uid' });
    return;
  }
  if (!verifyShareUid(uid, sig)) {
    res.json({ valid: false, reason: 'invalid_sig' });
    return;
  }

  const seedUid = sanitizeUid(config.seedRegistrant?.referral_id);
  if (seedUid && uid === seedUid && config.seedRegistrant) {
    ensureSeedRegistrant(config.seedRegistrant);
  }

  const registrant = getRegistrantByReferralId(uid);
  if (!registrant) {
    res.json({ valid: false, reason: 'not_registered' });
    return;
  }

  res.json({
    valid: true,
    name: resolveInviteDisplayName(uid, registrant, ''),
    company: resolveInviteDisplayCompany(uid, registrant, '', 'Your Org'),
  });
});

/** 邀请落地页：社交平台链接预览 + 跳转 Luma 报名 */
app.get('/i/:uid', (req, res) => {
  const uid = String(req.params.uid || '').trim();
  if (!uid) {
    res.status(400).send('Invalid invite link');
    return;
  }

  const registrant = requireRegisteredUid(uid);
  if (!registrant) {
    sendNotFoundPage(res);
    return;
  }

  const name = resolveInviteDisplayName(uid, registrant, req.query.name);
  const company = resolveInviteDisplayCompany(uid, registrant, req.query.company, 'Your Org');
  const inviterNote = resolveInviteDisplayNote(uid, req.query.note);
  const inviterSlogan = resolveInvitePosterSlogan(uid);
  const utmSource = String(req.query.utm_source || `invite__${uid}`).trim();
  const siteBase = resolveSiteBaseUrl(req);
  const pageUrl = `${siteBase}${req.originalUrl}`;
  const registerUrl = buildLumaRegisterUrl(uid, utmSource);
  const inviteHeroUrl = resolveInviteLandingPosterImageUrl();
  const avatarUrl = sanitizeAvatarUrl(getShareAvatar(uid), config);
  const ogImageUrl = buildOgImageUrl(siteBase, uid, name, company, {
    avatarUrl,
    posterSlogan: inviterSlogan,
  });
  const ogDescription = `${name}: "${inviterSlogan}" — Your Event 2026 · Your City`;

  const html = buildInviteLandingHtml({
    uid,
    name,
    company,
    posterUrl: inviteHeroUrl,
    pageUrl,
    registerUrl,
    ogImageUrl,
    avatarUrl,
    inviterSlogan,
    inviterNote,
    heroImageUrl: inviteHeroUrl,
    posterAspectRatio: String(config.inviteLandingPosterAspectRatio || '1 / 1').trim(),
    posterAvatarSlot: INVITE_LANDING_AVATAR_SLOT,
    eventSubline: EVENT_SUBLINE,
    ctaLabel: `Join ${name || 'them'} · Get tickets`,
    message: ogDescription,
    fpLogoUrl: config.fpLogoUrl || '',
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(html);
});

/** 合作伙伴定制落地页 /p/{slug} */
app.get('/p/:slug', (req, res) => {
  const slug = sanitizePartnerSlug(req.params.slug);
  if (!slug) {
    res.status(400).send('Invalid partner link');
    return;
  }

  const partner = getPartnerPage(slug);
  if (!partner || !partner.enabled) {
    sendNotFoundPage(res);
    return;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildPartnerInviteHtml(partner, req));
});

/** 分会场详情页 /s/{key}?uid=&sig=（无信封动画，持票用户一键报名） */
app.get('/s/:key', async (req, res) => {
  const eventKey = normalizeSideEventKey(req.params.key);
  const session = getSideEventByKey(eventKey);
  if (!session) {
    sendNotFoundPage(res);
    return;
  }

  const shareUid = sanitizeUid(req.query.uid);
  const sig = String(req.query.sig || '').trim();
  if (!shareUid || !verifyShareUid(shareUid, sig)) {
    res.status(403).send('Invalid or missing access link. Please open from your sharing page.');
    return;
  }

  const seedUid = sanitizeUid(config.seedRegistrant?.referral_id);
  if (seedUid && shareUid === seedUid && config.seedRegistrant) {
    ensureSeedRegistrant(config.seedRegistrant);
  }

  const registrant = requireRegisteredUid(shareUid);
  if (!registrant) {
    res.status(403).send('Main event registration required before joining side sessions.');
    return;
  }

  const joined = await syncSideSessionJoinState({ uid: shareUid, registrant, session });
  const displaySession = await enrichSideSessionFromLuma(session);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(buildSideSessionInviteHtml(displaySession, registrant, req, { sig, joined }));
});

/** 分会场报名状态（分享页加载） */
app.get('/api/side-events/status', async (req, res) => {
  const uid = sanitizeUid(req.query.uid);
  const sig = String(req.query.sig || '').trim();
  if (!uid || !verifyShareUid(uid, sig)) {
    res.status(403).json({ success: false, message: '签名无效' });
    return;
  }
  const registrant = requireRegisteredUid(uid);
  if (!registrant) {
    res.json({
      success: true,
      eligible: false,
      mainEventRegistered: false,
      sessions: [],
    });
    return;
  }

  const sessions = getSideEventsPublicList();
  const joinedKeys = new Set();
  const enrichedSessions = [];
  for (const s of sessions) {
    const session = getSideEventByKey(s.key);
    if (!session) continue;
    const joined = await syncSideSessionJoinState({ uid, registrant, session });
    if (joined) joinedKeys.add(s.key);
    const display = await enrichSideSessionFromLuma(session);
    enrichedSessions.push({
      key: s.key,
      name: display.name,
      headline: display.headline,
      subheadline: display.subheadline,
      bodyText: display.bodyText,
      ctaLabel: display.ctaLabel || s.ctaLabel,
      joined: joinedKeys.has(s.key),
      detailUrl: buildSideSessionPageUrl(req, s.key, uid, sig),
    });
  }

  res.setHeader('Cache-Control', 'no-cache');
  res.json({
    success: true,
    eligible: true,
    mainEventRegistered: true,
    sessions: enrichedSessions,
  });
});

/** 分会场一键报名（Luma API 代加，不进 Luma 页面） */
app.post('/api/side-events/join', trackLimiter, async (req, res) => {
  const uid = sanitizeUid(req.body?.uid);
  const sig = String(req.body?.sig || '').trim();
  const eventKey = normalizeSideEventKey(req.body?.eventKey);

  if (!uid || !verifyShareUid(uid, sig)) {
    res.status(403).json({ success: false, message: 'Invalid access' });
    return;
  }
  if (!eventKey) {
    res.status(400).json({ success: false, message: 'Invalid session' });
    return;
  }

  const session = getSideEventByKey(eventKey);
  if (!session) {
    res.status(404).json({ success: false, message: 'Session not found' });
    return;
  }

  const registrant = requireRegisteredUid(uid);
  if (!registrant) {
    res.status(403).json({ success: false, message: 'Main event registration required' });
    return;
  }

  if (await syncSideSessionJoinState({ uid, registrant, session })) {
    res.json({ success: true, alreadyJoined: true, eventKey });
    return;
  }

  if (!isLumaApiConfigured()) {
    res.status(503).json({ success: false, message: 'Side session registration is not configured' });
    return;
  }

  const email = String(registrant.email || '').trim();
  const name = resolveSharerDisplayName(uid, registrant) || registrant.name || '';
  if (!email) {
    res.status(400).json({ success: false, message: 'Missing registrant email' });
    return;
  }

  try {
    const lumaResult = await addGuestsToEvent({
      eventId: session.eventId,
      email,
      name,
    });

    let lumaGuestId = '';
    if (lumaResult && typeof lumaResult === 'object') {
      const entries = lumaResult.entries || lumaResult.guests || lumaResult.data;
      if (Array.isArray(entries) && entries[0]) {
        lumaGuestId = entries[0].guest_id || entries[0].id || entries[0].api_id || '';
      }
    }

    saveSideEventRsvp({
      referral_id: uid,
      email,
      name,
      side_event_key: eventKey,
      luma_event_id: session.eventId,
      luma_guest_id: lumaGuestId,
      source: 'api_one_click',
      status: 'joined',
    });

    recordShareTrackEvent({
      sharer_uid: uid,
      sharer_name: name,
      channel: 'side_session_join',
      utm_source: `side__${eventKey}`,
    });

    console.log('[分会场] 一键报名成功:', { uid, eventKey, email });
    res.json({ success: true, alreadyJoined: false, eventKey });
  } catch (err) {
    const msg = String(err.message || '');
    const already = err.status === 409 || /already|duplicate|registered/i.test(msg);
    if (already) {
      saveSideEventRsvp({
        referral_id: uid,
        email,
        name,
        side_event_key: eventKey,
        luma_event_id: session.eventId,
        source: 'api_one_click',
        status: 'joined',
      });
      res.json({ success: true, alreadyJoined: true, eventKey });
      return;
    }
    console.error('[分会场] Luma API 失败:', err.message, err.response || '');
    res.status(502).json({ success: false, message: 'Could not register for session. Please try again.' });
  }
});

/** 动态 OG 预览图 1200×630（X / LinkedIn / WhatsApp / iMessage） */
app.get('/og/:uid.jpg', ogLimiter, async (req, res) => {
  const uid = String(req.params.uid || '').trim();
  if (!uid) {
    res.status(400).send('Invalid uid');
    return;
  }

  const registrant = requireRegisteredUid(uid);
  const partner = registrant ? null : getEnabledPartnerBySlug(uid);
  if (!registrant && !partner) {
    res.status(404).type('text/plain').send('Not found');
    return;
  }

  let name;
  let company;
  let avatarUrl;
  let posterSlogan;

  if (partner) {
    name = String(partner.partner_name || partner.slug || uid).trim();
    company = name;
    avatarUrl = sanitizeAvatarUrl(partner.logo_url || '', config);
    posterSlogan = String(partner.headline || partner.partner_name || '').trim();
  } else {
    name = resolveInviteDisplayName(uid, registrant, req.query.name);
    company = resolveInviteDisplayCompany(uid, registrant, req.query.company, 'Your Org');
    avatarUrl = sanitizeAvatarUrl(getShareAvatar(uid), config);
    posterSlogan = resolveInvitePosterSlogan(uid);
  }

  try {
    const isSquare = req.query.shape === 'square';
    const posterUrl = isSquare
      ? resolveInstagramStoryPosterImageUrl()
      : (config.posterImageUrl || '');
    const siteBase = resolveSiteBaseUrl(req);
    const inviteUrl = isSquare && registrant
      ? `${siteBase}/i/${encodeURIComponent(uid)}`
      : '';
    const buffer = await generateOgImage({
      name,
      posterUrl,
      avatarUrl: avatarUrl || '',
      config,
      shape: isSquare ? 'square' : 'landscape',
      inviteUrl,
    });
    const etag = buildOgEtag({
      name,
      company,
      avatarUrl,
      posterImageUrl: posterUrl,
      shape: isSquare ? 'square' : 'landscape',
      inviteUrl,
    });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.send(buffer);
  } catch (err) {
    console.error('[OG] 生成失败:', err.message);
    if (config.posterImageUrl) {
      res.redirect(302, isSquare ? resolveInstagramStoryPosterImageUrl() : config.posterImageUrl);
      return;
    }
    res.status(500).send('OG image error');
  }
});

/** 图床 URL 统一为 https */
function normalizeUploadedImageUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (raw.startsWith('http://')) return `https://${raw.slice(7)}`;
  return raw;
}

/** 分享头像：居中 cover 裁正方形；PNG 先铺白底避免透明转 JPEG 发黑 */
async function processAvatarUpload(file) {
  const Jimp = require('jimp');
  let img = await Jimp.read(file.buffer);
  if (img.bitmap.width > 1024 || img.bitmap.height > 1024) {
    img.scaleToFit(1024, 1024);
  }
  const flat = new Jimp(img.bitmap.width, img.bitmap.height, 0xffffffff);
  flat.composite(img, 0, 0);
  flat.cover(512, 512).quality(90);
  const jpegBuffer = await flat.getBufferAsync(Jimp.MIME_JPEG);
  const imageBaseUrl = config.imageUpload?.baseUrl || 'https://your-upload.example.com';
  const url = await uploadImageBuffer(jpegBuffer, {
    baseUrl: imageBaseUrl,
    filename: `avatar-${Date.now()}.jpg`,
    mime: 'image/jpeg',
  });
  return normalizeUploadedImageUrl(url);
}

/** 合作落地页图片处理并上传图床 */
async function processPartnerImageUpload(file, kind) {
  const Jimp = require('jimp');
  const img = await Jimp.read(file.buffer);
  const isHero = kind === 'hero';

  if (isHero) {
    const maxW = 1920;
    if (img.bitmap.width > maxW) {
      img.resize(maxW, Jimp.AUTO);
    }
    img.quality(88);
  } else {
    img.cover(512, 512).quality(88);
  }

  const jpegBuffer = await img.getBufferAsync(Jimp.MIME_JPEG);
  const imageBaseUrl = config.imageUpload?.baseUrl || 'https://your-upload.example.com';
  const prefix = isHero ? 'partner-hero' : 'partner-logo';
  const url = await uploadImageBuffer(jpegBuffer, {
    baseUrl: imageBaseUrl,
    filename: `${prefix}-${Date.now()}.jpg`,
    mime: 'image/jpeg',
  });
  return normalizeUploadedImageUrl(url);
}

/**
 * 合作落地页图片上传（需看板登录）
 * POST /api/partners/upload-image
 * multipart: upload_file + kind=logo|hero
 */
app.post(
  '/api/partners/upload-image',
  requireStatsAuth,
  uploadLimiter,
  avatarUpload.single('upload_file'),
  async (req, res) => {
    const kind = String(req.body?.kind || '').trim().toLowerCase();
    const file = req.file;

    if (!['logo', 'hero'].includes(kind)) {
      res.status(400).json({ success: false, message: 'kind 须为 logo 或 hero' });
      return;
    }
    if (!file) {
      res.status(400).json({ success: false, message: '请用 upload_file 字段上传图片' });
      return;
    }

    try {
      const url = await processPartnerImageUpload(file, kind);
      console.log('[合作页] 图片已上传图床:', kind, url);
      res.json({ success: true, url, kind });
    } catch (err) {
      console.error('[合作页] 图片上传失败:', err.message);
      res.status(500).json({ success: false, message: err.message || '图片上传失败' });
    }
  },
);

/**
 * 上传分享头像 → YourOrg通用图床
 * POST /api/upload-avatar
 * multipart/form-data: uid + upload_file（与图床字段一致）
 */
app.post('/api/upload-avatar', uploadLimiter, avatarUpload.single('upload_file'), async (req, res) => {
  const uid = sanitizeUid(req.body?.uid);
  const sig = String(req.body?.sig || req.headers['x-share-sig'] || '').trim();
  const file = req.file;

  if (!uid) {
    res.status(400).json({ success: false, message: 'uid 无效' });
    return;
  }
  if (!verifyShareUid(uid, sig)) {
    res.status(403).json({ success: false, message: '签名无效' });
    return;
  }
  if (!requireRegisteredUid(uid)) {
    res.status(403).json({ success: false, message: 'uid 未注册' });
    return;
  }
  if (!file) {
    res.status(400).json({ success: false, message: '请用 upload_file 字段上传图片' });
    return;
  }

  try {
    const url = await processAvatarUpload(file);

    saveShareAvatar(uid, url);
    flushPersist();
    console.log('[头像] 已上传图床:', uid, url);
    res.json({ success: true, url });
  } catch (err) {
    console.error('[头像] 上传失败:', err.message);
    res.status(500).json({ success: false, message: err.message || '图片上传失败' });
  }
});

/** 读取邀请落地页展示文案（需 uid 签名，防枚举） */
app.get('/api/share-message/:uid', readApiLimiter, (req, res) => {
  const uid = sanitizeUid(req.params.uid);
  const sig = String(req.query.sig || '').trim();
  if (!guardRegisteredShareRead(res, uid, sig)) return;
  const rawMessage = getShareMessage(uid);
  let message = String(rawMessage || '').trim();
  if (message && isLegacyShareMessage(message)) {
    saveShareMessage(uid, '');
    message = '';
  }
  const posterSlogan = getPosterSlogan(uid);
  const displayName = getShareDisplayName(uid);
  const displayCompany = getShareDisplayCompany(uid);
  res.json({
    success: true,
    message,
    posterSlogan,
    displayName,
    displayCompany,
    cardVersion: resolveInviteCardVersion(uid),
  });
});

/** 保存分享文案与海报标语（需 uid 签名） */
app.post('/api/share-profile', profileWriteLimiter, (req, res) => {
  const uid = sanitizeUid(req.body?.uid);
  const sig = String(req.body?.sig || req.headers['x-share-sig'] || '').trim();
  const message = String(req.body?.message || '').trim();
  const posterSlogan = String(req.body?.posterSlogan || '').trim();
  const displayName = String(req.body?.displayName || req.body?.name || '').trim();
  const displayCompany = String(req.body?.displayCompany || req.body?.company || '').trim();
  const avatarUrl = String(req.body?.avatarUrl || req.body?.avatar || '').trim();

  if (!uid) {
    res.status(400).json({ success: false, message: 'uid 无效' });
    return;
  }
  if (!verifyShareUid(uid, sig)) {
    res.status(403).json({ success: false, message: '签名无效' });
    return;
  }
  if (!requireRegisteredUid(uid)) {
    res.status(403).json({ success: false, message: 'uid 未注册' });
    return;
  }
  if (!message && !posterSlogan && !displayName && !displayCompany && !avatarUrl) {
    res.status(400).json({ success: false, message: '至少填写一项分享资料' });
    return;
  }

  if (message) saveShareMessage(uid, message);
  if (posterSlogan) savePosterSlogan(uid, posterSlogan);
  if (displayName) saveShareDisplayName(uid, sanitizeDisplayText(displayName, 80));
  if (displayCompany) saveShareDisplayCompany(uid, sanitizeDisplayText(displayCompany, 120));
  if (avatarUrl) {
    if (!isAllowedAvatarUrl(avatarUrl, config)) {
      res.status(400).json({ success: false, message: '头像 URL 不在允许范围内' });
      return;
    }
    saveShareAvatar(uid, avatarUrl);
  }
  res.json({ success: true });
});

/** 查询用户是否已上传头像（需 uid 签名，防枚举） */
app.get('/api/avatar/:uid', readApiLimiter, (req, res) => {
  const uid = sanitizeUid(req.params.uid);
  const sig = String(req.query.sig || '').trim();
  if (!guardRegisteredShareRead(res, uid, sig)) return;
  const url = getShareAvatar(uid);
  const safeUrl = sanitizeAvatarUrl(normalizeUploadedImageUrl(url), config);
  if (!url || !safeUrl) {
    sendNotFoundApi(res);
    return;
  }
  res.json({ success: true, url: safeUrl });
});

/** 分享页埋点：记录页面浏览 / 复制 / LinkedIn / 邮件等 */
app.post('/api/track', trackLimiter, (req, res) => {
  const { uid, channel, utm_source: utmSource, visitor_id: visitorId } = req.body || {};
  const allowed = [
    'page_view', 'copy', 'download', 'linkedin', 'email', 'whatsapp', 'x', 'instagram',
    'invite_view', 'invite_view_live', 'invite_view_ended', 'invite_click', 'partner_view', 'partner_click',
    'side_session_view', 'side_session_click', 'side_session_join',
  ];

  if (!uid || !channel || !allowed.includes(channel)) {
    res.status(400).json({ success: false, message: '参数无效' });
    return;
  }

  const partnerChannels = ['partner_view', 'partner_click'];
  if (partnerChannels.includes(channel)) {
    const slug = sanitizePartnerSlug(uid);
    if (!slug) {
      res.status(400).json({ success: false, message: 'partner slug 无效' });
      return;
    }
    const partner = getPartnerPage(slug);
    const sharerName = String(req.body?.name || '').trim() || partner?.partner_name || slug;
    recordShareTrackEvent({ sharer_uid: slug, sharer_name: sharerName, channel, visitor_id: visitorId });
    console.log('[统计] 合作渠道:', { slug, name: sharerName, channel });
    res.json({ success: true });
    return;
  }

  const safeUid = sanitizeUid(uid);
  const registrant = requireRegisteredUid(safeUid);
  if (!registrant) {
    res.status(404).json({ success: false, message: 'Invite not found' });
    return;
  }

  if (SHARER_TRACK_CHANNELS.has(channel)) {
    const sig = String(req.body?.sig || req.headers['x-share-sig'] || '').trim();
    if (!verifyShareUid(safeUid, sig)) {
      res.status(403).json({ success: false, message: '签名无效' });
      return;
    }
  }

  const sharerName = resolveSharerDisplayName(safeUid, registrant);
  recordShareTrackEvent({
    sharer_uid: safeUid,
    sharer_name: sharerName,
    channel,
    utm_source: utmSource,
    visitor_id: visitorId,
  });
  console.log('[统计] 分享行为:', { uid: safeUid, name: sharerName, channel });
  res.json({ success: true });
});

/** 合作落地页列表（管理） */
app.get('/api/partners', requireStatsAuth, (_req, res) => {
  res.json({ success: true, partners: listPartnerPages({ includeDisabled: true }) });
});

/** 合作落地页详情（管理） */
app.get('/api/partners/:slug', requireStatsAuth, (req, res) => {
  const slug = sanitizePartnerSlug(req.params.slug);
  if (!slug) {
    res.status(400).json({ success: false, message: 'slug 无效' });
    return;
  }
  const partner = getPartnerPage(slug);
  if (!partner) {
    res.status(404).json({ success: false, message: '页面不存在' });
    return;
  }
  const siteBase = resolveSiteBaseUrl(req);
  res.json({
    success: true,
    partner,
    public_url: `${siteBase}/p/${encodeURIComponent(slug)}`,
    luma_url: buildLumaPartnerRegisterUrl(slug),
  });
});

/** 一键生成合作链接（只需合作伙伴名称） */
app.post('/api/partners/generate', requireStatsAuth, (req, res) => {
  const partnerName = String(req.body?.partner_name || '').trim();
  if (!partnerName) {
    res.status(400).json({ success: false, message: '请填写合作伙伴名称' });
    return;
  }

  const preferred = sanitizePartnerSlug(req.body?.slug) || sanitizePartnerSlug(partnerName);
  const slug = resolveUniquePartnerSlug(preferred);
  if (!slug) {
    res.status(400).json({ success: false, message: '无法生成有效链接标识' });
    return;
  }

  const existing = getPartnerPage(slug);
  const payload = existing
    ? { ...existing, partner_name: partnerName, enabled: true }
    : buildPartnerDefaults(slug, partnerName);
  const saved = savePartnerPage(payload);

  res.json({
    success: true,
    created: !existing,
    partner: saved,
    public_url: partnerPublicUrl(req, slug),
    luma_url: buildLumaPartnerRegisterUrl(slug),
  });
});

/** 保存合作落地页（新建或更新） */
app.put('/api/partners/:slug', requireStatsAuth, (req, res) => {
  const slug = sanitizePartnerSlug(req.params.slug);
  if (!slug) {
    res.status(400).json({ success: false, message: 'slug 无效（仅小写字母、数字、连字符）' });
    return;
  }
  const payload = normalizePartnerPayload({ ...req.body, slug });
  if (!payload) {
    res.status(400).json({ success: false, message: '参数无效' });
    return;
  }
  if (!payload.partner_name) {
    res.status(400).json({ success: false, message: '请填写合作伙伴名称' });
    return;
  }
  const saved = savePartnerPage(payload);
  const siteBase = resolveSiteBaseUrl(req);
  res.json({
    success: true,
    partner: saved,
    public_url: `${siteBase}/p/${encodeURIComponent(slug)}`,
    luma_url: buildLumaPartnerRegisterUrl(slug),
  });
});

/** 删除合作落地页 */
app.delete('/api/partners/:slug', requireStatsAuth, (req, res) => {
  const slug = sanitizePartnerSlug(req.params.slug);
  if (!slug) {
    res.status(400).json({ success: false, message: 'slug 无效' });
    return;
  }
  if (!deletePartnerPage(slug)) {
    res.status(404).json({ success: false, message: '页面不存在' });
    return;
  }
  res.json({ success: true });
});

/** 实时预览 HTML（管理，未保存也可预览） */
app.post('/api/partners/render', requireStatsAuth, (req, res) => {
  const payload = normalizePartnerPayload(req.body);
  if (!payload || !payload.partner_name) {
    res.status(400).json({ success: false, message: '请填写 slug 与合作伙伴名称' });
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildPartnerInviteHtml(payload, req, { skipIntro: true, skipTracking: true }));
});

/** 统计数据 JSON 接口 ?range=day|week|all */
app.get('/api/stats', requireStatsAuth, (req, res) => {
  const range = normalizeStatsRange(req.query.range);
  const now = Date.now();
  if (statsCache.byRange[range] && now - statsCache.at < STATS_CACHE_MS) {
    res.json(enrichStatsResponse(statsCache.byRange[range], req));
    return;
  }
  if (statsQueryBusy && respondWithStatsCache(res, req, range, { _stats_cached: true })) {
    return;
  }

  statsQueryBusy = true;
  try {
    const raw = getStats({ range });
    if (raw?.overview?._degraded) {
      if (respondWithStatsCache(res, req, range, { _stats_cached: true })) return;
      res.status(503).json({ success: false, message: '统计数据暂时不可用，请稍后再试' });
      return;
    }
    statsCache.byRange[range] = raw;
    statsCache.at = now;
    res.json(enrichStatsResponse(raw, req));
  } catch (err) {
    console.error('[统计] /api/stats 异常:', err.message);
    if (isSqlWasmError(err)) recoverDatabaseFromDisk();
    if (respondWithStatsCache(res, req, range, { _stats_cached: true })) return;
    res.status(503).json({ success: false, message: '统计数据暂时不可用，请稍后再试' });
  } finally {
    statsQueryBusy = false;
  }
});

/** 生成带签名的分享页链接（供统计看板使用） */
app.get('/api/signed-share-link', requireStatsAuth, (req, res) => {
  if (!isShareLinkSecretConfigured()) {
    res.status(503).json({ success: false, message: 'SHARE_LINK_SECRET 未配置' });
    return;
  }

  const fallbackUid = sanitizeUid(config.seedRegistrant?.referral_id);
  const uid = sanitizeUid(req.query.uid) || fallbackUid;
  if (!uid) {
    res.status(400).json({ success: false, message: 'uid 无效' });
    return;
  }

  if (fallbackUid && uid === fallbackUid && config.seedRegistrant) {
    ensureSeedRegistrant(config.seedRegistrant);
  }

  const registrant = getRegistrantByReferralId(uid);
  if (!registrant) {
    res.status(404).json({ success: false, message: '用户未报名' });
    return;
  }

  const displayName = resolveSharerDisplayName(uid, registrant);
  const displayCompany = resolveInviteDisplayCompany(uid, registrant, '', registrant.company || '');
  const siteBase = resolveSiteBaseUrl(req);
  res.json({
    success: true,
    url: buildSharePageUrl(displayName, uid, siteBase, displayCompany),
    invite_url: buildInviteLandingUrl(uid, siteBase, 'invite'),
  });
});

/** 单个推荐人带来的报名明细 */
app.get('/api/referrer/:uid', requireStatsAuth, (req, res) => {
  try {
    const data = getReferrerStats(req.params.uid);
    if (!data) {
      res.status(404).json({ success: false, message: 'uid 无效或统计暂不可用' });
      return;
    }
    res.json({
      ...data,
      display_name: data.display_name || resolveSharerDisplayName(req.params.uid, data.referrer),
    });
  } catch (err) {
    console.error('[统计] /api/referrer 异常:', err.message);
    if (isSqlWasmError(err)) recoverDatabaseFromDisk();
    res.status(503).json({ success: false, message: '统计数据暂时不可用，请稍后再试' });
  }
});

/** 未匹配路由：API 返回 JSON，页面返回友好 404 */
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ success: false, message: '接口不存在' });
    return;
  }
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? `图片不能超过 ${Math.round(AVATAR_UPLOAD_MAX_BYTES / (1024 * 1024))}MB`
      : (err.message || '上传失败');
    res.status(400).json({ success: false, message: msg });
    return;
  }
  if (/图片|upload/i.test(String(err.message || ''))) {
    res.status(400).json({ success: false, message: err.message || '上传失败' });
    return;
  }
  if (isSqlWasmError(err)) {
    console.error('[数据库] 未捕获异常:', err.message, req.method, req.path);
    recoverDatabaseFromDisk();
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: '服务繁忙，请稍后再试' });
    }
    return;
  }
  next(err);
});

/** 启动服务 */
async function start() {
  validateConfig();
  await initDatabase(config.dbPath);

  if (config.seedRegistrant) {
    ensureSeedRegistrant(config.seedRegistrant);
  }

  app.listen(config.port, () => {
    console.log(`[服务] 已启动 v${APP_VERSION}，监听端口 ${config.port}`);
    console.log(`[服务] Webhook 地址: http://localhost:${config.port}/api/luma-webhook`);
    console.log(`[服务] 分享页地址: http://localhost:${config.port}/share.html`);
    console.log(`[服务] 邀请落地页: http://localhost:${config.port}/i/{uid}`);
    console.log(`[服务] 合作落地页: http://localhost:${config.port}/p/{slug}`);
    console.log(`[服务] 分会场页: http://localhost:${config.port}/s/{key}?uid=&sig=`);
    console.log(`[服务] 合作页管理: http://localhost:${config.port}/partners.html`);
    console.log(`[服务] 统计看板: http://localhost:${config.port}/stats.html`);
    const seed = config.seedRegistrant;
    if (seed?.referral_id) {
      const base = (config.siteBaseUrl || `http://localhost:${config.port}`).replace(/\/$/, '');
      console.log('[服务] 预览分享页:', buildSharePageUrl(seed.name, seed.referral_id, base, seed.company));
    }
  });
}

start().catch((err) => {
  console.error('[服务] 启动失败:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[服务] 正在关闭...');
  closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[服务] 正在关闭...');
  closeDatabase();
  process.exit(0);
});
