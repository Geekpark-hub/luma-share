/**
 * Luma Plus API（分会场代报名）
 * @see https://docs.luma.com/reference/post_v1-events-guests-add
 */
const config = require('./config');

const LUMA_API_BASE = 'https://public-api.luma.com';

function getLumaApiKey() {
  return String(process.env.LUMA_API_KEY || config.lumaApiKey || '').trim();
}

function isLumaApiConfigured() {
  return !!getLumaApiKey();
}

async function lumaApiRequest(method, path, body) {
  const apiKey = getLumaApiKey();
  if (!apiKey) {
    const err = new Error('Luma API key not configured');
    err.code = 'LUMA_API_KEY_MISSING';
    throw err;
  }

  const res = await fetch(`${LUMA_API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-luma-api-key': apiKey,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `Luma API ${res.status}`);
    err.code = 'LUMA_API_ERROR';
    err.status = res.status;
    err.response = data;
    throw err;
  }

  return data;
}

/** 将嘉宾加入活动（默认 Going / approved） */
async function addGuestsToEvent({ eventId, email, name, registrationAnswers }) {
  const guest = {
    email: String(email || '').trim(),
    name: String(name || '').trim() || undefined,
  };
  if (registrationAnswers?.length) {
    guest.registration_answers = registrationAnswers;
  }

  return lumaApiRequest('POST', '/v1/events/guests/add', {
    event_id: String(eventId || '').trim(),
    guests: [guest],
  });
}

/** 按邮箱查询活动嘉宾（GET /v1/events/guests/get） */
async function getGuestOnEvent({ eventId, email }) {
  const eid = String(eventId || '').trim();
  const mail = String(email || '').trim();
  if (!eid || !mail) return null;

  const qs = new URLSearchParams({ event_id: eid, id: mail });
  try {
    return await lumaApiRequest('GET', `/v1/events/guests/get?${qs}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Luma 嘉宾是否视为「已参加/已通过」 */
function isLumaGuestJoined(guest) {
  if (!guest) return false;
  const status = String(guest.approval_status || '').trim().toLowerCase();
  if (!status) return true;
  if (status === 'declined') return false;
  if (status === 'pending_approval' || status === 'waitlist') return false;
  return status === 'approved' || status === 'session' || status === 'invited';
}

const lumaEventCache = new Map();
const LUMA_EVENT_CACHE_TTL_MS = 60 * 1000;

/** 查询活动详情（GET /v1/events/get），带 60s 内存缓存 */
async function getEventById({ eventId }) {
  const eid = String(eventId || '').trim();
  if (!eid) return null;

  const cached = lumaEventCache.get(eid);
  if (cached && Date.now() - cached.at < LUMA_EVENT_CACHE_TTL_MS) {
    return cached.data;
  }

  const qs = new URLSearchParams({ event_id: eid });
  const data = await lumaApiRequest('GET', `/v1/events/get?${qs}`);
  lumaEventCache.set(eid, { at: Date.now(), data });
  return data;
}

module.exports = {
  getLumaApiKey,
  isLumaApiConfigured,
  addGuestsToEvent,
  getGuestOnEvent,
  isLumaGuestJoined,
  getEventById,
};
