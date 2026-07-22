/**
 * 头像 URL 白名单 + SSRF 防护；展示名 HTML 剥离
 */
const net = require('net');
const { URL } = require('url');

const BLOCKED_HOSTS = new Set(['localhost', '0.0.0.0']);

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIpv6(ip) {
  const n = ip.toLowerCase();
  return n === '::1' || n.startsWith('fc') || n.startsWith('fd') || n.startsWith('fe80');
}

function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) return isPrivateIpv6(host);
  return false;
}

function collectAllowedAvatarHosts(config = {}) {
  const hosts = new Set([
    'your-cdn.example.com',
    'your-upload.example.com',
  ]);
  const candidates = [
    config.imageUpload?.baseUrl,
    config.posterImageUrl,
    config.inviteLandingPosterImageUrl,
    config.instagramStoryPosterImageUrl,
    config.invitePosterImageUrl,
    config.fpLogoUrl,
    config.geekparkLogoUrl,
  ];
  for (const raw of candidates) {
    try {
      const u = new URL(String(raw || '').trim());
      if (u.hostname) hosts.add(u.hostname.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  return hosts;
}

function isAllowedAvatarHost(hostname, config = {}) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  if (host === 'example.com' || host.endsWith('.example.com')) return true;
  return collectAllowedAvatarHosts(config).has(host);
}

function isAllowedAvatarUrl(rawUrl, config = {}) {
  const value = String(rawUrl || '').trim();
  if (!value) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (isPrivateOrLocalHost(parsed.hostname)) return false;
  if (!isAllowedAvatarHost(parsed.hostname, config)) return false;
  return true;
}

function sanitizeAvatarUrl(rawUrl, config = {}) {
  const value = String(rawUrl || '').trim();
  return isAllowedAvatarUrl(value, config) ? value : '';
}

function sanitizeDisplayText(raw, maxLen = 80) {
  return String(raw || '')
    .trim()
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, maxLen);
}

module.exports = {
  isAllowedAvatarUrl,
  sanitizeAvatarUrl,
  sanitizeDisplayText,
};
