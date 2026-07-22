/**
 * 一次性测试邮件脚本（检查 Gmail 是否判为垃圾邮件）
 * 用法: node send-test-email.js [收件邮箱]
 */
const nodemailer = require('nodemailer');
const config = require('./config');
const { buildSharePageUrl } = require('./share-auth');
const { buildEmailText, buildEmailHtml } = require('./email-content');

function buildTestOgImageUrl(siteBase, uid, name, company) {
  const params = new URLSearchParams();
  if (name) params.set('name', name);
  if (company) params.set('company', company);
  const qs = params.toString();
  return `${siteBase}/og/${encodeURIComponent(uid)}.jpg${qs ? `?${qs}` : ''}`;
}

async function main() {
  const to = (process.argv[2] || 'you@example.com').trim();
  const seed = config.seedRegistrant || {};
  const uid = String(seed.referral_id || 'admin-preview').trim();
  const name = seed.name || 'Admin Preview';
  const company = seed.company || 'YourOrg';
  const siteBase = (process.env.SITE_BASE_URL || config.siteBaseUrl || 'http://localhost:3000').replace(/\/$/, '');
  const shareLink = buildSharePageUrl(name, uid, siteBase, company);
  const posterImageUrl = buildTestOgImageUrl(siteBase, uid, name, company);

  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
  });

  const subject = `[TEST] ${config.mailSubject}`;

  const info = await transporter.sendMail({
    from: config.mailFrom,
    to,
    replyTo: config.mailReplyTo || config.smtp.user,
    subject,
    text: buildEmailText(name, shareLink, config.lumaEventUrl),
    html: buildEmailHtml(name, shareLink, {
      posterImageUrl,
      lumaEventUrl: config.lumaEventUrl,
    }),
    headers: {
      'X-Entity-Ref-ID': `agi-${uid}`,
    },
  });

  console.log('[测试邮件] 已发送');
  console.log('  收件人:', to);
  console.log('  主题:', subject);
  console.log('  Message-ID:', info.messageId);
  console.log('  分享链接:', shareLink);
  console.log('  预览图:', posterImageUrl);
}

main().catch((err) => {
  console.error('[测试邮件] 发送失败:', err.message);
  process.exit(1);
});
