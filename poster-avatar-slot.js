/**
 * 海报头像槽位（相对海报图宽高，0–1）
 * 换海报时按设计稿微调 cx / cy / size
 */
module.exports = {
  /** 1200×630 横版 — 分享页预览、社交平台 OG（LinkedIn / X 等） */
  POSTER_AVATAR_SLOT: {
    cx: 0.137,
    cy: 0.221,
    size: 0.34,
  },
  /** 邀请落地页 /i/ 竖版/方版海报（zz1200 等） */
  INVITE_LANDING_AVATAR_SLOT: {
    cx: 0.21,
    cy: 0.28,
    size: 0.31,
  },
  /** Instagram Story 方图（ecc4a7af 设计稿实测） */
  INSTAGRAM_STORY_AVATAR_SLOT: {
    cx: 0.211,
    cy: 0.281,
    size: 0.324,
  },
  /** Instagram Story 方图右下角 QR */
  INSTAGRAM_STORY_QR_SLOT: {
    cx: 0.779,
    cy: 0.799,
    size: 0.22,
  },
};
