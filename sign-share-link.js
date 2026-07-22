/**
 * 本地生成带签名的分享页链接
 * 用法: node sign-share-link.js <uid> [name] [company]
 */
const { buildSharePageUrl } = require('./share-auth');
const config = require('./config');

const uid = process.argv[2];
if (!uid) {
  console.error('用法: node sign-share-link.js <uid> [name] [company]');
  process.exit(1);
}

const name = process.argv[3] || 'friend';
const company = process.argv[4] || '';
const siteBase = (process.env.SITE_BASE_URL || config.siteBaseUrl || 'http://localhost:3000').replace(/\/$/, '');

console.log(buildSharePageUrl(name, uid, siteBase, company));
