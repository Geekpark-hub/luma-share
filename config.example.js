/**
 * Config example — copy to config.js and fill in real values.
 * Never commit config.js or real secrets.
 */
const port = 3000;

module.exports = {
  port,
  dbPath: './luma_data.db',

  smtp: {
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    user: 'you@example.com',
    pass: 'your-smtp-app-password',
  },

  mailFrom: '"Your Event" <you@example.com>',
  mailReplyTo: 'you@example.com',

  // Production: inject via deploy/env.sh (e.g. https://share.example.com)
  siteBaseUrl: process.env.SITE_BASE_URL || `http://localhost:${port}`,

  lumaEventUrl: 'https://luma.com/your-event-id',

  // Optional coupon appended as ?coupon=… (leave empty to skip)
  lumaCouponCode: '',

  allowedLumaEventUrls: [
    'https://luma.com/your-event-id',
  ],

  // false = send share email as soon as registration succeeds
  requireApprovalBeforeEmail: false,

  /**
   * Welcome email with share-page link
   * false = webhook still stores guests, but no email is sent
   */
  welcomeEmailEnabled: true,

  /**
   * true = only send after the guest has confirmed attendance
   */
  welcomeEmailRequireUserConfirmation: true,

  // Google Analytics 4 (empty = no gtag). Or set GA_MEASUREMENT_ID.
  gaMeasurementId: process.env.GA_MEASUREMENT_ID || '',

  // Landscape poster for share page + LinkedIn/X OG (1200×630)
  posterImageUrl: 'https://your-cdn.example.com/poster-1200x630.png',

  // Invite landing /i/ poster
  inviteLandingPosterImageUrl: 'https://your-cdn.example.com/invite-poster.png',
  inviteLandingPosterAspectRatio: '1 / 1',

  // Instagram Story poster base (avatar + dynamic QR)
  instagramStoryPosterImageUrl: 'https://your-cdn.example.com/ig-story-poster.png',

  // Deprecated: use instagramStoryPosterImageUrl
  invitePosterImageUrl: '',

  // Optional logos on invite pages
  fpLogoUrl: '',
  geekparkLogoUrl: '',

  imageUpload: {
    // Your image upload API origin (optional)
    baseUrl: 'https://your-upload.example.com',
  },

  mailSubject: "You're in! Your Event — now tell your network",

  // Share-page link signing (set SHARE_LINK_SECRET in production)
  shareLinkSecret: process.env.SHARE_LINK_SECRET || '',

  // Luma webhook auth (?secret= or X-Webhook-Secret)
  webhookSecret: process.env.WEBHOOK_SECRET || '',

  // Luma Plus API key (side-event auto-register). Set LUMA_API_KEY in production.
  lumaApiKey: process.env.LUMA_API_KEY || '',

  mainEventUrl: 'https://luma.com/your-main-event-id',

  // Side sessions shown on the share page (optional)
  sideEvents: [
    {
      key: 'session-a',
      name: 'Session A',
      headline: 'Session A title',
      bodyText: 'Description for ticket holders.',
      url: 'https://luma.com/your-side-event-a',
      eventId: 'evt-xxxxxxxx',
      ctaLabel: 'Join Session A',
      ctaSub: 'Free for main event ticket holders',
      enabled: false,
    },
  ],

  sideSessionsShareEnabled: false,

  // Stats dashboard Basic Auth (/stats.html, /api/stats)
  statsAuth: {
    user: process.env.STATS_USER || 'admin',
    pass: process.env.STATS_PASS || 'change-me-stats-password',
  },

  testMode: false,
  testInboxes: [],

  // Seeded preview guest for local share-page testing
  seedRegistrant: {
    referral_id: 'admin-preview',
    name: 'Admin Preview',
    email: 'admin-preview@example.com',
    company: 'Your Org',
  },
};
