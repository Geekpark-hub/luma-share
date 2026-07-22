/**
 * App version + default share copy templates.
 * Customize these strings for your event in config / here before deploy.
 */
const DEFAULT_SHARE_MESSAGE =
  "I'll be at #YourEvent — come meet builders with me.\n\nGrab your ticket with my invite link 👇\n\n#YourEvent #AI #Startups";

const PLATFORM_SHARE_MESSAGES = {
  x:
    "I'll be at #YourEvent hosted by @YourHost.\nBuilders, come say hi!\nInvite link 👇\n\n{{link}}\n\n#YourEvent #AI",
  linkedin:
    "I'll be at #YourEvent. If you're building something nearby, I want to meet you.\n\nGrab your ticket with this invite link 👇\n{{link}}\n\n#YourEvent #AI #Startups",
  whatsapp:
    "I'm going to Your Event. If you're building anything over there, you're exactly who I want to meet. Come? Grab your ticket with my invite link 👇\n{{link}}",
  email:
    "I'll be at Your Event. I'm trying to meet the builders worth knowing. If that's you, grab a spot with this invite link:\n\n{{link}}",
  instagram:
    "Going to Your Event 🎉\n\nBuilding nearby? Share this in your Story!\n\nScan the poster to grab your ticket\n\n#YourEvent #AI #Startups",
};

const LEGACY_SHARE_MESSAGES = [
  DEFAULT_SHARE_MESSAGE,
  PLATFORM_SHARE_MESSAGES.x,
  PLATFORM_SHARE_MESSAGES.linkedin,
  PLATFORM_SHARE_MESSAGES.whatsapp,
  PLATFORM_SHARE_MESSAGES.email,
  PLATFORM_SHARE_MESSAGES.instagram,
];

function stripShareLinkPlaceholder(text) {
  return String(text || '')
    .replace(/\n?\{\{link\}\}\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeShareTemplateText(text) {
  return stripShareLinkPlaceholder(text)
    .replace(/\r\n/g, '\n')
    .trim();
}

function isLegacyShareMessage(message) {
  const msg = normalizeShareTemplateText(message);
  if (!msg) return true;
  if (msg === normalizeShareTemplateText(DEFAULT_SHARE_MESSAGE)) return true;
  if (Object.values(PLATFORM_SHARE_MESSAGES).some((tpl) => normalizeShareTemplateText(tpl) === msg)) {
    return true;
  }
  return LEGACY_SHARE_MESSAGES.some((tpl) => normalizeShareTemplateText(tpl) === msg);
}

module.exports = {
  APP_VERSION: '1.0.0',

  DEFAULT_SHARE_MESSAGE,
  DEFAULT_EMAIL_SUBJECT: 'See you at the event — who should I meet?',
  PLATFORM_SHARE_MESSAGES,
  DEFAULT_POSTER_SLOGAN: "Count me in — see you there!",
  EVENT_SUBLINE: 'Your dates · Your city · Your venue',
  LEGACY_SHARE_MESSAGES,
  LEGACY_POSTER_SLOGANS: ["I'm going!", 'Count me in — see you there!'],

  stripShareLinkPlaceholder,
  normalizeShareTemplateText,
  isLegacyShareMessage,
};
