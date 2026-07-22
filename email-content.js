/**
 * Welcome email body (plain text + HTML).
 * Text-first layout with poster at the bottom to reduce image-only spam scoring.
 */

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEmailText(name, shareLink) {
  return `REGISTRATION CONFIRMED

Hi ${name}, welcome to Your Event!

You're confirmed. One thing before you go: let people know you're coming.

Attendees who post about the event get found by the right people before day one — collaborators, investors, future teammates. Your sharing page has a ready-to-post invite message and your unique link. Copy, tweak, post. It takes 30 seconds.

What to do next
- Post your invite on X or LinkedIn with #YourEvent
- Share your unique link with 2–3 people you'd want in the room
- Add the event to your calendar

Share that I'm going:
${shareLink}

If the button does not work, copy and paste this link into your browser:
${shareLink}`;
}

function buildEmailHtml(name, shareLink, options = {}) {
  const posterUrl = options.posterImageUrl || '';
  const safeName = escapeHtml(name);
  const safeLink = escapeHtml(shareLink);

  const posterBlock = posterUrl
    ? `<div style="margin-top:24px;padding-top:20px;border-top:1px solid #e2e8f0;">
        <p style="color:#64748b;font-size:12px;line-height:1.5;margin:0 0 10px 0;">Your share preview</p>
        <a href="${safeLink}" style="text-decoration:none;">
          <img src="${escapeHtml(posterUrl)}" width="480" alt="Your Event preview" style="max-width:100%;width:480px;height:auto;border-radius:8px;display:block;border:1px solid #e2e8f0;" />
        </a>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en"><body style="margin:0;padding:0;background:#f1f5f9;">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <div style="padding:32px 28px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;">
    <p style="margin:0 0 8px 0;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#1d4ed8;">Registration confirmed</p>
    <h1 style="color:#0f172a;margin:0 0 16px 0;font-size:22px;line-height:1.35;font-weight:700;">Hi ${safeName}, welcome to Your Event!</h1>
    <p style="color:#334155;line-height:1.75;margin:0 0 14px 0;font-size:15px;">You're confirmed. One thing before you go: let people know you're coming.</p>
    <p style="color:#334155;line-height:1.75;margin:0 0 14px 0;font-size:15px;">Attendees who post about the event get found by the right people before day one — collaborators, investors, future teammates. Your sharing page has a ready-to-post invite message and your unique link. Copy, tweak, post. It takes 30 seconds.</p>
    <p style="color:#334155;font-size:14px;line-height:1.7;margin:0 0 8px 0;font-weight:600;">What to do next</p>
    <ul style="color:#334155;font-size:14px;line-height:1.75;margin:0 0 18px 0;padding-left:20px;">
      <li style="margin-bottom:6px;">Post your invite on X or LinkedIn with #YourEvent</li>
      <li style="margin-bottom:6px;">Share your unique link with 2–3 people you'd want in the room</li>
      <li style="margin-bottom:0;">Add the event to your calendar</li>
    </ul>
    <div style="margin:24px 0;">
      <a href="${safeLink}" style="display:inline-block;padding:14px 28px;background:#1d4ed8;color:#ffffff;border-radius:8px;text-decoration:none;font-size:15px;font-weight:600;">Share that I'm going</a>
    </div>
    <p style="color:#64748b;font-size:13px;line-height:1.65;margin:0 0 6px 0;">If the button does not work, copy and paste this link into your browser:</p>
    <p style="color:#1d4ed8;font-size:13px;line-height:1.65;margin:0 0 18px 0;word-break:break-all;"><a href="${safeLink}" style="color:#1d4ed8;">${safeLink}</a></p>
    ${posterBlock}
    <p style="color:#64748b;font-size:12px;line-height:1.65;margin:20px 0 0 0;padding-top:16px;border-top:1px solid #e2e8f0;">Questions? Reply to this email.<br>Your Event</p>
  </div>
</div>
</body></html>`.trim();
}

module.exports = {
  escapeHtml,
  buildEmailText,
  buildEmailHtml,
};
