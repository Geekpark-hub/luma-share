/**
 * 分享页邮件链接签名（仅签 uid，防篡改）
 */
const crypto = require('crypto');

function getShareLinkSecret() {
  try {
    const config = require('./config');
    return String(process.env.SHARE_LINK_SECRET || config.shareLinkSecret || '').trim();
  } catch {
    return String(process.env.SHARE_LINK_SECRET || '').trim();
  }
}

function normalizeUid(uid) {
  return String(uid || '').trim().replace(/[^a-zA-Z0-9._-]/g, '');
}

function signShareUid(uid) {
  const safe = normalizeUid(uid);
  const secret = getShareLinkSecret();
  if (!secret || !safe) return '';
  return crypto.createHmac('sha256', secret).update(safe).digest('base64url');
}

function verifyShareUid(uid, sig) {
  const safe = normalizeUid(uid);
  if (!safe) return false;

  const secret = getShareLinkSecret();
  if (!secret) {
    // 生产环境未配置密钥时拒绝，避免签名校验被绕过
    return process.env.NODE_ENV !== 'production';
  }

  const token = String(sig || '').trim();
  if (!token) return false;

  const expected = signShareUid(safe);
  if (!expected || expected.length !== token.length) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  } catch {
    return false;
  }
}

function isShareLinkSecretConfigured() {
  return !!getShareLinkSecret();
}

function buildSharePageUrl(name, referralId, siteBaseUrl, company) {
  const uid = normalizeUid(referralId);
  const params = new URLSearchParams();
  if (uid) params.set('uid', uid);
  if (name) params.set('name', name);
  if (company) params.set('company', company);

  const sig = signShareUid(uid);
  if (sig) params.set('sig', sig);

  const base = String(siteBaseUrl || '').replace(/\/$/, '');
  const qs = params.toString();
  return `${base}/share.html${qs ? `?${qs}` : ''}`;
}

module.exports = {
  signShareUid,
  verifyShareUid,
  isShareLinkSecretConfigured,
  buildSharePageUrl,
  normalizeUid,
};
