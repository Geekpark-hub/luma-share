/**
 * SQLite 数据库模块（better-sqlite3 原生驱动，直接读写 db 文件）
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

let db = null;
let dbPath = './luma_data.db';

function isSqlWasmError(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || err || '');
  if (/SQLITE_CORRUPT|SQLITE_NOTADB|SQLITE_CANTOPEN|SQLITE_IOERR/i.test(code)) return true;
  return /database disk image is malformed|file is not a database|memory access out of bounds/i.test(msg);
}

/** 连接异常后重新打开库文件 */
function recoverDatabaseFromDisk() {
  if (!dbPath) return false;
  try {
    if (db) {
      try { db.close(); } catch {}
    }
    db = openDatabase(dbPath);
    console.warn('[数据库] 已从磁盘重新打开连接');
    return true;
  } catch (err) {
    console.error('[数据库] 恢复失败:', err.message);
    return false;
  }
}

function openDatabase(filePath) {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const conn = new Database(resolved);
  conn.pragma('journal_mode = WAL');
  conn.pragma('busy_timeout = 5000');
  conn.pragma('foreign_keys = ON');
  return conn;
}

/** 兼容旧 sql.js API：better-sqlite3 写入即时落盘，无需 export */
function flushPersist() {}

function persist() {}

function exec(sql) {
  db.exec(sql);
}

function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

/** 安全添加列（已存在则忽略） */
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = cols.some((row) => row.name === column);
  if (!exists) {
    exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function initDatabase(filePath) {
  dbPath = filePath;
  const exists = fs.existsSync(path.resolve(dbPath));
  db = openDatabase(dbPath);
  console.log(exists ? `[数据库] 已加载: ${dbPath}` : `[数据库] 已创建: ${dbPath}`);

  exec(`
    CREATE TABLE IF NOT EXISTS registrant (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE,
      company TEXT,
      referral_id TEXT,
      referred_by TEXT,
      register_channel TEXT,
      utm_source TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      reward_status INTEGER DEFAULT 0
    )
  `);

  ensureColumn('registrant', 'referred_by', 'TEXT');
  ensureColumn('registrant', 'register_channel', 'TEXT');
  ensureColumn('registrant', 'utm_source', 'TEXT');
  ensureColumn('registrant', 'welcome_email_sent', 'INTEGER DEFAULT 0');
  ensureColumn('registrant', 'approval_status', "TEXT DEFAULT 'approved'");

  exec(`
    CREATE TABLE IF NOT EXISTS share_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sharer_uid TEXT,
      sharer_name TEXT,
      channel TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  exec(`
    CREATE TABLE IF NOT EXISTS ticket_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      luma_guest_id TEXT,
      guest_email TEXT,
      guest_name TEXT,
      ticket_name TEXT,
      ticket_amount REAL,
      ticket_currency TEXT,
      referred_by TEXT,
      register_channel TEXT,
      is_captured INTEGER DEFAULT 0,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  exec(`
    CREATE TABLE IF NOT EXISTS share_profiles (
      uid TEXT PRIMARY KEY,
      avatar_url TEXT,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  ensureColumn('share_profiles', 'share_message', 'TEXT');
  ensureColumn('share_profiles', 'poster_slogan', 'TEXT');
  ensureColumn('share_profiles', 'display_name', 'TEXT');
  ensureColumn('share_profiles', 'display_company', 'TEXT');
  ensureColumn('share_events', 'visitor_id', 'TEXT');

  exec(`
    CREATE TABLE IF NOT EXISTS partner_pages (
      slug TEXT PRIMARY KEY,
      partner_name TEXT NOT NULL,
      headline TEXT,
      subheadline TEXT,
      body_text TEXT,
      logo_url TEXT,
      hero_image_url TEXT,
      cta_label TEXT,
      cta_sub TEXT,
      accent_color TEXT,
      badge_text TEXT,
      social_proof TEXT,
      enabled INTEGER DEFAULT 1,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  exec(`
    CREATE TABLE IF NOT EXISTS side_event_rsvps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referral_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      side_event_key TEXT NOT NULL,
      luma_event_id TEXT NOT NULL,
      luma_guest_id TEXT,
      source TEXT DEFAULT 'api_one_click',
      status TEXT DEFAULT 'joined',
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(referral_id, side_event_key)
    )
  `);

  console.log('[数据库] 数据表 registrant / share_events / ticket_events / share_profiles / partner_pages / side_event_rsvps 已就绪');

  run('CREATE INDEX IF NOT EXISTS idx_registrant_referral_id ON registrant(referral_id)');
  run('CREATE INDEX IF NOT EXISTS idx_registrant_referred_by ON registrant(referred_by)');
  run('CREATE INDEX IF NOT EXISTS idx_share_events_uid_channel ON share_events(sharer_uid, channel)');
  run('CREATE INDEX IF NOT EXISTS idx_share_events_channel ON share_events(channel)');
  run('CREATE INDEX IF NOT EXISTS idx_share_events_create ON share_events(create_time)');

  repairMangledUtmRecords();
}

/** 有效参会者：approved；历史空值视为已通过；pending/declined 不算在活动内 */
function sqlActiveRegistrant(alias = '') {
  const col = alias ? `${alias}.approval_status` : 'approval_status';
  if (config.requireApprovalBeforeEmail) {
    return `(${col} = 'approved' OR ${col} IS NULL OR ${col} = '')`;
  }
  return `(${col} NOT IN ('declined', 'pending_approval') OR ${col} IS NULL OR ${col} = '')`;
}

/** 启动时注入预览/管理员模拟报名（便于看板打开分享页） */
function ensureSeedRegistrant(seed) {
  if (!seed?.referral_id || !seed?.email) return null;

  const referralId = String(seed.referral_id).trim();
  const existing = getRegistrantByReferralId(referralId);
  if (existing) {
    return existing;
  }

  saveRegistrant({
    name: seed.name || 'Admin Preview',
    email: String(seed.email).trim(),
    company: seed.company || '',
    referral_id: referralId,
    referred_by: '',
    register_channel: 'seed',
    utm_source: '',
    approval_status: 'approved',
  });
  markWelcomeEmailSent(String(seed.email).trim());

  const created = getRegistrantByReferralId(referralId);
  if (created) {
    console.log('[数据库] 已注入预览用户:', referralId, created.email);
  }
  return created;
}

function normalizeSideEventKeyDb(key) {
  return String(key || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function getSideEventRsvp(referralId, eventKey) {
  const uid = String(referralId || '').trim();
  const key = normalizeSideEventKeyDb(eventKey);
  if (!uid || !key) return null;
  const rows = queryAll(
    `SELECT * FROM side_event_rsvps WHERE referral_id = ? AND side_event_key = ? LIMIT 1`,
    [uid, key]
  );
  return rows[0] || null;
}

function listSideEventRsvpsForUser(referralId) {
  const uid = String(referralId || '').trim();
  if (!uid) return [];
  return queryAll(
    `SELECT * FROM side_event_rsvps WHERE referral_id = ? ORDER BY create_time DESC`,
    [uid]
  );
}

function saveSideEventRsvp({
  referral_id, email, name, side_event_key, luma_event_id, luma_guest_id, source, status,
}) {
  const uid = String(referral_id || '').trim();
  const key = normalizeSideEventKeyDb(side_event_key);
  const mail = String(email || '').trim();
  if (!uid || !key || !mail) return null;

  run(
    `INSERT INTO side_event_rsvps (
      referral_id, email, name, side_event_key, luma_event_id, luma_guest_id, source, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(referral_id, side_event_key) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      luma_event_id = excluded.luma_event_id,
      luma_guest_id = COALESCE(excluded.luma_guest_id, side_event_rsvps.luma_guest_id),
      source = excluded.source,
      status = excluded.status`,
    [
      uid,
      mail,
      String(name || '').trim(),
      key,
      String(luma_event_id || '').trim(),
      String(luma_guest_id || '').trim(),
      String(source || 'api_one_click').trim(),
      String(status || 'joined').trim(),
    ]
  );
  persist();
  return getSideEventRsvp(uid, key);
}

function deleteSideEventRsvp(referralId, eventKey) {
  const uid = String(referralId || '').trim();
  const key = normalizeSideEventKeyDb(eventKey);
  if (!uid || !key) return false;
  const result = run(`DELETE FROM side_event_rsvps WHERE referral_id = ? AND side_event_key = ?`, [uid, key]);
  const removed = result.changes > 0;
  if (removed) persist();
  return removed;
}

/** Side Event declined：按邮箱删除（referral_id 不一致时的兜底） */
function deleteSideEventRsvpByEmail(email, eventKey) {
  const mail = String(email || '').trim();
  const key = normalizeSideEventKeyDb(eventKey);
  if (!mail || !key) return false;
  const result = run(`DELETE FROM side_event_rsvps WHERE email = ? AND side_event_key = ?`, [mail, key]);
  const removed = result.changes > 0;
  if (removed) persist();
  return removed;
}

/** 修复 Luma 吃掉 | 后粘连的 utm（如 copyusr-xxx → copy + usr-xxx） */
function repairMangledUtmRecords() {
  const rows = queryAll(
    `SELECT id, register_channel, referred_by, utm_source FROM registrant
     WHERE referred_by IS NULL OR referred_by = ''`
  );
  let fixed = 0;
  for (const row of rows) {
    const raw = row.utm_source || row.register_channel || '';
    const parsed = parseUtmFromStored(raw);
    if (!parsed.referred_by) continue;
    run(
      `UPDATE registrant SET register_channel = ?, referred_by = ? WHERE id = ?`,
      [parsed.register_channel, parsed.referred_by, row.id]
    );
    fixed++;
  }
  if (fixed) {
    persist();
    console.log(`[数据库] 已修复 ${fixed} 条推荐追踪记录`);
  }
}

function parseUtmFromStored(utm) {
  if (!utm) return { register_channel: '', referred_by: '' };
  const s = String(utm);
  if (s.includes('__')) {
    const [register_channel, referred_by] = s.split('__', 2);
    return { register_channel: register_channel || '', referred_by: referred_by || '' };
  }
  if (s.includes('|')) {
    const [register_channel, referred_by] = s.split('|', 2);
    return { register_channel: register_channel || '', referred_by: referred_by || '' };
  }
  for (const ch of ['copy', 'download', 'linkedin', 'email', 'whatsapp', 'x', 'instagram', 'invite', 'partner']) {
    if (s.startsWith(`${ch}usr-`)) {
      return { register_channel: ch, referred_by: s.slice(ch.length) };
    }
  }
  return { register_channel: s, referred_by: '' };
}

/** 写入注册用户（幂等）；已存在则更新可变字段 */
function saveRegistrant(data) {
  const approvalStatus = String(data.approval_status || 'approved').trim() || 'approved';
  const insertResult = run(
    `INSERT OR IGNORE INTO registrant
     (name, email, company, referral_id, referred_by, register_channel, utm_source, approval_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.name,
      data.email,
      data.company,
      data.referral_id,
      data.referred_by || '',
      data.register_channel || '',
      data.utm_source || '',
      approvalStatus,
    ]
  );
  const isNew = insertResult.changes > 0;
  if (!isNew) {
    run(
      `UPDATE registrant SET
         name = CASE WHEN ? != '' THEN ? ELSE name END,
         company = CASE WHEN ? != '' THEN ? ELSE company END,
         referral_id = CASE WHEN ? != '' THEN ? ELSE referral_id END,
         referred_by = CASE WHEN ? != '' THEN ? ELSE referred_by END,
         register_channel = CASE WHEN ? != '' THEN ? ELSE register_channel END,
         utm_source = CASE WHEN ? != '' THEN ? ELSE utm_source END,
         approval_status = ?
       WHERE email = ?`,
      [
        data.name, data.name,
        data.company, data.company,
        data.referral_id, data.referral_id,
        data.referred_by || '', data.referred_by || '',
        data.register_channel || '', data.register_channel || '',
        data.utm_source || '', data.utm_source || '',
        approvalStatus,
        data.email,
      ]
    );
  }
  persist();
  return isNew;
}

/** 不参加 / 已拒绝：从活动名单中移除 */
function removeRegistrantByEmail(email) {
  const safe = String(email || '').trim();
  if (!safe) return false;
  const result = run(`DELETE FROM registrant WHERE email = ?`, [safe]);
  const removed = result.changes > 0;
  if (removed) persist();
  return removed;
}

function isWelcomeEmailSent(email) {
  const row = queryAll(
    `SELECT welcome_email_sent FROM registrant WHERE email = ? LIMIT 1`,
    [email]
  )[0];
  return !!row?.welcome_email_sent;
}

function markWelcomeEmailSent(email) {
  run(`UPDATE registrant SET welcome_email_sent = 1 WHERE email = ?`, [email]);
  persist();
}

/** 原子占位：仅当尚未发信时标记为已发，防止并发 Webhook 重复发信 */
function tryClaimWelcomeEmailSend(email) {
  const safe = String(email || '').trim();
  if (!safe) return false;
  const result = run(
    `UPDATE registrant SET welcome_email_sent = 1
     WHERE email = ? AND COALESCE(welcome_email_sent, 0) = 0`,
    [safe]
  );
  return result.changes > 0;
}

/** 发信失败时释放占位，允许后续 Webhook 重试 */
function releaseWelcomeEmailSendClaim(email) {
  const safe = String(email || '').trim();
  if (!safe) return;
  run(`UPDATE registrant SET welcome_email_sent = 0 WHERE email = ?`, [safe]);
  persist();
}

/** UV 去重键：有 visitor_id 用访客，否则每条事件单独计（兼容旧数据） */
const SQL_EVENT_UV_KEY = `COALESCE(NULLIF(TRIM(visitor_id), ''), 'ev-' || id)`;
const SQL_SE_EVENT_UV_KEY = `COALESCE(NULLIF(TRIM(se.visitor_id), ''), 'ev-' || se.id)`;

function resolveStatsRange(range) {
  const key = ['day', 'week', 'all'].includes(String(range || '').toLowerCase())
    ? String(range).toLowerCase()
    : 'all';
  if (key === 'day') {
    return {
      key,
      seTime: `date(se.create_time) = date('now', 'localtime')`,
      evTime: `date(create_time) = date('now', 'localtime')`,
      regTime: `date(create_time) = date('now', 'localtime')`,
      chartSince: `datetime(create_time) >= datetime('now', '-1 days', 'localtime')`,
      chartDays: 7,
    };
  }
  if (key === 'week') {
    return {
      key,
      seTime: `datetime(se.create_time) >= datetime('now', '-7 days', 'localtime')`,
      evTime: `datetime(create_time) >= datetime('now', '-7 days', 'localtime')`,
      regTime: `datetime(create_time) >= datetime('now', '-7 days', 'localtime')`,
      chartSince: `datetime(create_time) >= datetime('now', '-7 days', 'localtime')`,
      chartDays: 7,
    };
  }
  return {
    key: 'all',
    seTime: '1=1',
    evTime: '1=1',
    regTime: '1=1',
    chartSince: `datetime(create_time) >= datetime('now', '-30 days', 'localtime')`,
    chartDays: 30,
  };
}

function channelPvUv(channel, evTime) {
  const ch = String(channel).replace(/'/g, "''");
  const rows = queryAll(
    `SELECT COUNT(*) AS pv,
            COUNT(DISTINCT ${SQL_EVENT_UV_KEY}) AS uv
     FROM share_events
     WHERE channel = '${ch}' AND ${evTime}`,
  );
  return {
    pv: Number(rows[0]?.pv) || 0,
    uv: Number(rows[0]?.uv) || 0,
  };
}

function channelPvUvSharer(channel, evTime) {
  const ch = String(channel).replace(/'/g, "''");
  const rows = queryAll(
    `SELECT COUNT(*) AS pv,
            COUNT(DISTINCT CASE WHEN sharer_uid != '' THEN sharer_uid END) AS uv
     FROM share_events
     WHERE channel = '${ch}' AND ${evTime}`,
  );
  return {
    pv: Number(rows[0]?.pv) || 0,
    uv: Number(rows[0]?.uv) || 0,
  };
}

/** 记录分享/点击行为（PV：每次请求记一条；UV 在查询时 DISTINCT） */
function logShareEvent({ sharer_uid, sharer_name, channel, visitor_id = '' }) {
  const ch = channel || 'unknown';
  const uid = sharer_uid || '';
  const vid = String(visitor_id || '').trim().slice(0, 64);
  run(
    `INSERT INTO share_events (sharer_uid, sharer_name, channel, visitor_id) VALUES (?, ?, ?, ?)`,
    [uid, sharer_name || '', ch, vid]
  );
  persist();
  return true;
}

/** 记录购票 */
function logTicketEvent(data) {
  run(
    `INSERT INTO ticket_events
     (luma_guest_id, guest_email, guest_name, ticket_name, ticket_amount, ticket_currency,
      referred_by, register_channel, is_captured)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.luma_guest_id || '',
      data.guest_email || '',
      data.guest_name || '',
      data.ticket_name || '',
      data.ticket_amount || 0,
      data.ticket_currency || '',
      data.referred_by || '',
      data.register_channel || '',
      data.is_captured ? 1 : 0,
    ]
  );
  persist();
  return true;
}

function queryAll(sql, params = []) {
  const execQuery = () => db.prepare(sql).all(...params);

  try {
    return execQuery();
  } catch (err) {
    if (!isSqlWasmError(err)) throw err;
    console.error('[数据库] 查询异常:', err.message);
    if (recoverDatabaseFromDisk()) {
      try {
        return execQuery();
      } catch (retryErr) {
        console.error('[数据库] 恢复后重试仍失败:', retryErr.message);
        throw retryErr;
      }
    }
    throw err;
  }
}

/**
 * SQL：按 sharer_uid / referral_id 解析展示名
 * share_profiles.display_name > registrant.name > share_events.sharer_name > uid
 */
const SQL_SHARER_NAME = `COALESCE(
  MAX(NULLIF(TRIM(sp.display_name), '')),
  MAX(NULLIF(TRIM(reg.name), '')),
  MAX(NULLIF(TRIM(se.sharer_name), '')),
  se.sharer_uid
)`;

const SQL_REFERRER_NAME = (uidCol) => `COALESCE(
  MAX(NULLIF(TRIM(sp_ref.display_name), '')),
  MAX(NULLIF(TRIM(ref.name), '')),
  MAX(NULLIF(TRIM(se.sharer_name), '')),
  ${uidCol}
)`;

/** 从库中解析展示名（供单用户 API 使用） */
function resolveSharerDisplayNameFromDb(uid) {
  const safeUid = String(uid || '').trim();
  if (!safeUid) return '';
  const fromShare = getShareDisplayName(safeUid);
  if (fromShare) return fromShare;
  const reg = queryAll(
    `SELECT name FROM registrant WHERE referral_id = ? LIMIT 1`,
    [safeUid]
  )[0];
  const regName = String(reg?.name || '').trim();
  if (regName) return regName;
  const evt = queryAll(
    `SELECT sharer_name FROM share_events
     WHERE sharer_uid = ? AND sharer_name != '' ORDER BY id DESC LIMIT 1`,
    [safeUid]
  )[0];
  return String(evt?.sharer_name || safeUid).trim();
}

/** 汇总统计数据（内部实现） */
function computeStats({ range = 'all' } = {}) {
  const rg = resolveStatsRange(range);
  const regActive = sqlActiveRegistrant();
  const regActiveR = sqlActiveRegistrant('r');
  const pageView = channelPvUvSharer('page_view', rg.evTime);
  const inviteView = channelPvUv('invite_view', rg.evTime);
  const inviteClick = channelPvUv('invite_click', rg.evTime);

  const referralRegs = queryAll(
    `SELECT COUNT(*) AS c FROM registrant
     WHERE referred_by IS NOT NULL AND referred_by != '' AND ${regActive} AND ${rg.regTime}`,
  )[0]?.c || 0;

  const overview = {
    range: rg.key,
    total_registrants: queryAll(
      `SELECT COUNT(*) AS c FROM registrant WHERE ${regActive} AND ${rg.regTime}`,
    )[0]?.c || 0,
    total_share_events: queryAll(
      `SELECT COUNT(*) AS c FROM share_events WHERE ${rg.evTime}`,
    )[0]?.c || 0,
    total_tickets: queryAll(
      `SELECT COUNT(*) AS c FROM ticket_events WHERE is_captured = 1 AND ${rg.regTime.replace(/create_time/g, 'ticket_events.create_time')}`,
    )[0]?.c || 0,
    page_views_pv: pageView.pv,
    page_views_uv: pageView.uv,
    invite_views_pv: inviteView.pv,
    invite_views_uv: inviteView.uv,
    invite_clicks_pv: inviteClick.pv,
    invite_clicks_uv: inviteClick.uv,
    page_views: pageView.pv,
    invite_views: inviteView.pv,
    invite_clicks: inviteClick.pv,
    referral_registrations: referralRegs,
  };

  const dailySeries = queryAll(`
    SELECT date(create_time, 'localtime') AS day,
           SUM(CASE WHEN channel = 'invite_view' THEN 1 ELSE 0 END) AS invite_views_pv,
           COUNT(DISTINCT CASE WHEN channel = 'invite_view' THEN ${SQL_EVENT_UV_KEY} END) AS invite_views_uv,
           SUM(CASE WHEN channel = 'invite_click' THEN 1 ELSE 0 END) AS invite_clicks_pv,
           COUNT(DISTINCT CASE WHEN channel = 'invite_click' THEN ${SQL_EVENT_UV_KEY} END) AS invite_clicks_uv,
           SUM(CASE WHEN channel = 'page_view' THEN 1 ELSE 0 END) AS page_views_pv
    FROM share_events
    WHERE ${rg.chartSince}
    GROUP BY day
    ORDER BY day ASC
  `);

  const dailyRegs = queryAll(`
    SELECT date(create_time, 'localtime') AS day, COUNT(*) AS registrations
    FROM registrant
    WHERE referred_by IS NOT NULL AND referred_by != '' AND ${regActive}
      AND ${rg.chartSince.replace(/create_time/g, 'registrant.create_time')}
    GROUP BY day
    ORDER BY day ASC
  `);

  const regByDay = Object.fromEntries(dailyRegs.map((r) => [r.day, Number(r.registrations) || 0]));
  const mergedDaily = dailySeries.map((row) => ({
    ...row,
    registrations: regByDay[row.day] || 0,
  }));

  return {
    overview,
    dailySeries: mergedDaily,
    shareByChannel: queryAll(`
      SELECT channel,
             COUNT(*) AS count_pv,
             COUNT(DISTINCT ${SQL_EVENT_UV_KEY}) AS count_uv
      FROM share_events
      WHERE ${rg.evTime}
      GROUP BY channel ORDER BY count_pv DESC
    `),
    shareByUser: queryAll(`
      SELECT se.sharer_uid,
             ${SQL_SHARER_NAME} AS sharer_name,
             se.channel,
             COUNT(*) AS count_pv,
             COUNT(DISTINCT ${SQL_SE_EVENT_UV_KEY}) AS count_uv
      FROM share_events se
      LEFT JOIN share_profiles sp ON sp.uid = se.sharer_uid
      LEFT JOIN registrant reg ON reg.referral_id = se.sharer_uid
      WHERE se.channel != 'page_view' AND se.sharer_uid != '' AND ${rg.seTime}
      GROUP BY se.sharer_uid, se.channel
      ORDER BY count_pv DESC LIMIT 50
    `),
    pageViewsByUser: queryAll(`
      SELECT se.sharer_uid,
             ${SQL_SHARER_NAME} AS sharer_name,
             COUNT(*) AS count_pv,
             1 AS count_uv
      FROM share_events se
      LEFT JOIN share_profiles sp ON sp.uid = se.sharer_uid
      LEFT JOIN registrant reg ON reg.referral_id = se.sharer_uid
      WHERE se.channel = 'page_view' AND se.sharer_uid != '' AND ${rg.seTime}
      GROUP BY se.sharer_uid
      ORDER BY count_pv DESC LIMIT 50
    `),
    referralLeaderboard: queryAll(`
      SELECT r.referred_by AS referrer_uid,
             ${SQL_REFERRER_NAME('r.referred_by')} AS referrer_name,
             MAX(ref.email) AS referrer_email,
             COUNT(*) AS new_registrations
      FROM registrant r
      LEFT JOIN registrant ref ON ref.referral_id = r.referred_by
      LEFT JOIN share_profiles sp_ref ON sp_ref.uid = r.referred_by
      LEFT JOIN (
        SELECT sharer_uid, MAX(sharer_name) AS sharer_name
        FROM share_events WHERE sharer_uid != '' AND sharer_name != ''
        GROUP BY sharer_uid
      ) se ON se.sharer_uid = r.referred_by
      WHERE r.referred_by IS NOT NULL AND r.referred_by != '' AND ${regActiveR} AND ${rg.regTime.replace(/create_time/g, 'r.create_time')}
      GROUP BY r.referred_by ORDER BY new_registrations DESC LIMIT 50
    `),
    registerByChannel: queryAll(`
      SELECT register_channel, COUNT(*) AS count
      FROM registrant WHERE register_channel != '' AND ${regActive} AND ${rg.regTime}
      GROUP BY register_channel ORDER BY count DESC
    `),
    ticketByReferrer: queryAll(`
      SELECT te.referred_by AS referrer_uid,
             ${SQL_REFERRER_NAME('te.referred_by')} AS referrer_name,
             COUNT(*) AS ticket_count,
             SUM(te.ticket_amount) AS total_amount
      FROM ticket_events te
      LEFT JOIN registrant ref ON ref.referral_id = te.referred_by
      LEFT JOIN share_profiles sp_ref ON sp_ref.uid = te.referred_by
      LEFT JOIN (
        SELECT sharer_uid, MAX(sharer_name) AS sharer_name
        FROM share_events WHERE sharer_uid != '' AND sharer_name != ''
        GROUP BY sharer_uid
      ) se ON se.sharer_uid = te.referred_by
      WHERE te.is_captured = 1 AND te.referred_by != '' AND ${rg.regTime.replace(/create_time/g, 'te.create_time')}
      GROUP BY te.referred_by ORDER BY ticket_count DESC LIMIT 50
    `),
    recentRegistrants: queryAll(`
      SELECT r.name, r.email, r.referral_id, r.referred_by,
             ${SQL_REFERRER_NAME('r.referred_by')} AS referrer_name,
             MAX(ref.email) AS referrer_email,
             r.register_channel, r.create_time
      FROM registrant r
      LEFT JOIN registrant ref ON ref.referral_id = r.referred_by
      LEFT JOIN share_profiles sp_ref ON sp_ref.uid = r.referred_by
      LEFT JOIN (
        SELECT sharer_uid, MAX(sharer_name) AS sharer_name
        FROM share_events WHERE sharer_uid != '' AND sharer_name != ''
        GROUP BY sharer_uid
      ) se ON se.sharer_uid = r.referred_by
      WHERE ${regActiveR} AND ${rg.regTime.replace(/create_time/g, 'r.create_time')}
      GROUP BY r.id
      ORDER BY r.id DESC LIMIT 20
    `),
    inviteFunnelByUser: queryAll(`
      WITH uids AS (
        SELECT sharer_uid FROM share_events
        WHERE sharer_uid != '' AND channel IN ('invite_view', 'invite_click') AND ${rg.evTime}
        UNION
        SELECT referred_by FROM registrant WHERE referred_by != '' AND ${regActive} AND ${rg.regTime}
      )
      SELECT
        u.sharer_uid AS referrer_uid,
        ${SQL_REFERRER_NAME('u.sharer_uid')} AS referrer_name,
        COALESCE(v.cnt_pv, 0) AS invite_views_pv,
        COALESCE(v.cnt_uv, 0) AS invite_views_uv,
        COALESCE(c.cnt_pv, 0) AS invite_clicks_pv,
        COALESCE(c.cnt_uv, 0) AS invite_clicks_uv,
        COALESCE(v.cnt_pv, 0) AS invite_views,
        COALESCE(c.cnt_pv, 0) AS invite_clicks,
        COALESCE(rg.cnt, 0) AS registrations
      FROM uids u
      LEFT JOIN (
        SELECT sharer_uid,
               COUNT(*) AS cnt_pv,
               COUNT(DISTINCT ${SQL_EVENT_UV_KEY}) AS cnt_uv
        FROM share_events
        WHERE channel = 'invite_view' AND ${rg.evTime}
        GROUP BY sharer_uid
      ) v ON v.sharer_uid = u.sharer_uid
      LEFT JOIN (
        SELECT sharer_uid,
               COUNT(*) AS cnt_pv,
               COUNT(DISTINCT ${SQL_EVENT_UV_KEY}) AS cnt_uv
        FROM share_events
        WHERE channel = 'invite_click' AND ${rg.evTime}
        GROUP BY sharer_uid
      ) c ON c.sharer_uid = u.sharer_uid
      LEFT JOIN (
        SELECT referred_by AS sharer_uid, COUNT(*) AS cnt FROM registrant
        WHERE referred_by != '' AND ${regActive} AND ${rg.regTime}
        GROUP BY referred_by
      ) rg ON rg.sharer_uid = u.sharer_uid
      LEFT JOIN registrant ref ON ref.referral_id = u.sharer_uid
      LEFT JOIN share_profiles sp_ref ON sp_ref.uid = u.sharer_uid
      LEFT JOIN (
        SELECT sharer_uid, MAX(sharer_name) AS sharer_name
        FROM share_events WHERE sharer_uid != '' GROUP BY sharer_uid
      ) se ON se.sharer_uid = u.sharer_uid
      GROUP BY u.sharer_uid
      ORDER BY invite_views_pv DESC, invite_clicks_pv DESC, registrations DESC
      LIMIT 50
    `),
    partnerFunnel: queryAll(`
      SELECT
        p.slug,
        p.partner_name,
        COALESCE(v.cnt, 0) AS partner_views,
        COALESCE(c.cnt, 0) AS partner_clicks,
        COALESCE(r.cnt, 0) AS registrations
      FROM partner_pages p
      LEFT JOIN (
        SELECT sharer_uid, COUNT(*) AS cnt FROM share_events
        WHERE channel = 'partner_view' AND ${rg.evTime} GROUP BY sharer_uid
      ) v ON v.sharer_uid = p.slug
      LEFT JOIN (
        SELECT sharer_uid, COUNT(*) AS cnt FROM share_events
        WHERE channel = 'partner_click' AND ${rg.evTime} GROUP BY sharer_uid
      ) c ON c.sharer_uid = p.slug
      LEFT JOIN (
        SELECT referred_by, COUNT(*) AS cnt FROM registrant
        WHERE register_channel = 'partner' AND referred_by != '' AND ${regActive} AND ${rg.regTime}
        GROUP BY referred_by
      ) r ON r.referred_by = p.slug
      WHERE p.enabled = 1
      ORDER BY registrations DESC, partner_views DESC, p.partner_name ASC
    `),
    inviteInboundByChannel: queryAll(`
      SELECT replace(channel, 'invite_inbound_', '') AS inbound_channel,
             COUNT(*) AS count_pv,
             COUNT(DISTINCT ${SQL_EVENT_UV_KEY}) AS count_uv
      FROM share_events
      WHERE channel LIKE 'invite_inbound_%' AND ${rg.evTime}
      GROUP BY channel ORDER BY count_pv DESC
    `),
  };
}

function buildEmptyStats(range = 'all') {
  const rg = resolveStatsRange(range);
  return {
    overview: {
      range: rg.key,
      total_registrants: 0,
      total_share_events: 0,
      total_tickets: 0,
      page_views_pv: 0,
      page_views_uv: 0,
      invite_views_pv: 0,
      invite_views_uv: 0,
      invite_clicks_pv: 0,
      invite_clicks_uv: 0,
      page_views: 0,
      invite_views: 0,
      invite_clicks: 0,
      referral_registrations: 0,
      _degraded: true,
    },
    dailySeries: [],
    shareByChannel: [],
    shareByUser: [],
    pageViewsByUser: [],
    referralLeaderboard: [],
    registerByChannel: [],
    ticketByReferrer: [],
    recentRegistrants: [],
    inviteFunnelByUser: [],
    partnerFunnel: [],
    inviteInboundByChannel: [],
  };
}

/** 汇总统计数据（失败时返回降级空数据，避免拖垮进程） */
function getStats({ range = 'all' } = {}) {
  try {
    return computeStats({ range });
  } catch (err) {
    console.error('[统计] getStats 失败:', err.message);
    return buildEmptyStats(range);
  }
}

function normalizePartnerRow(row) {
  if (!row) return null;
  return {
    slug: row.slug || '',
    partner_name: row.partner_name || '',
    headline: row.headline || '',
    subheadline: row.subheadline || '',
    body_text: row.body_text || '',
    logo_url: row.logo_url || '',
    hero_image_url: row.hero_image_url || '',
    cta_label: row.cta_label || '',
    cta_sub: row.cta_sub || '',
    accent_color: row.accent_color || '',
    badge_text: row.badge_text || '',
    social_proof: row.social_proof || '',
    enabled: row.enabled !== 0,
    create_time: row.create_time || '',
    update_time: row.update_time || '',
  };
}

function listPartnerPages({ includeDisabled = false } = {}) {
  const sql = includeDisabled
    ? `SELECT * FROM partner_pages ORDER BY partner_name ASC, slug ASC`
    : `SELECT * FROM partner_pages WHERE enabled = 1 ORDER BY partner_name ASC, slug ASC`;
  return queryAll(sql).map(normalizePartnerRow);
}

function getPartnerPage(slug) {
  const safe = String(slug || '').trim();
  if (!safe) return null;
  const row = queryAll(`SELECT * FROM partner_pages WHERE slug = ? LIMIT 1`, [safe])[0];
  return normalizePartnerRow(row);
}

function savePartnerPage(data) {
  const slug = String(data.slug || '').trim();
  if (!slug) return null;
  const existing = getPartnerPage(slug);
  const payload = {
    partner_name: String(data.partner_name || '').trim() || slug,
    headline: String(data.headline || '').trim(),
    subheadline: String(data.subheadline || '').trim(),
    body_text: String(data.body_text || '').trim(),
    logo_url: String(data.logo_url || '').trim(),
    hero_image_url: String(data.hero_image_url || '').trim(),
    cta_label: String(data.cta_label || '').trim(),
    cta_sub: String(data.cta_sub || '').trim(),
    accent_color: String(data.accent_color || '').trim(),
    badge_text: String(data.badge_text || '').trim(),
    social_proof: String(data.social_proof || '').trim(),
    enabled: data.enabled === false || data.enabled === 0 ? 0 : 1,
  };

  if (existing) {
    run(
      `UPDATE partner_pages SET
         partner_name = ?, headline = ?, subheadline = ?, body_text = ?,
         logo_url = ?, hero_image_url = ?, cta_label = ?, cta_sub = ?,
         accent_color = ?, badge_text = ?, social_proof = ?, enabled = ?,
         update_time = CURRENT_TIMESTAMP
       WHERE slug = ?`,
      [
        payload.partner_name, payload.headline, payload.subheadline, payload.body_text,
        payload.logo_url, payload.hero_image_url, payload.cta_label, payload.cta_sub,
        payload.accent_color, payload.badge_text, payload.social_proof, payload.enabled,
        slug,
      ]
    );
  } else {
    run(
      `INSERT INTO partner_pages
       (slug, partner_name, headline, subheadline, body_text, logo_url, hero_image_url,
        cta_label, cta_sub, accent_color, badge_text, social_proof, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        slug, payload.partner_name, payload.headline, payload.subheadline, payload.body_text,
        payload.logo_url, payload.hero_image_url, payload.cta_label, payload.cta_sub,
        payload.accent_color, payload.badge_text, payload.social_proof, payload.enabled,
      ]
    );
  }
  persist();
  return getPartnerPage(slug);
}

function deletePartnerPage(slug) {
  const safe = String(slug || '').trim();
  if (!safe) return false;
  const result = run(`DELETE FROM partner_pages WHERE slug = ?`, [safe]);
  persist();
  return result.changes > 0;
}

/** 按 referral_id 查报名用户 */
function getRegistrantByReferralId(referralId) {
  const safe = String(referralId || '').trim();
  if (!safe) return null;
  return (
    queryAll(
      `SELECT name, email, company, referral_id FROM registrant
       WHERE referral_id = ? AND ${sqlActiveRegistrant()} LIMIT 1`,
      [safe]
    )[0] || null
  );
}

/** 按邮箱查有效主会报名（持票判断） */
function getRegistrantByEmail(email) {
  const safe = String(email || '').trim();
  if (!safe) return null;
  return (
    queryAll(
      `SELECT name, email, company, referral_id, approval_status FROM registrant
       WHERE email = ? AND ${sqlActiveRegistrant()} LIMIT 1`,
      [safe]
    )[0] || null
  );
}

function hasActiveMainEventRegistration(email) {
  return !!getRegistrantByEmail(email);
}

/** 保存分享页用户头像 URL（YourOrg图床） */
function saveShareAvatar(uid, avatarUrl) {
  const safeUid = String(uid || '').trim();
  const url = String(avatarUrl || '').trim();
  if (!safeUid || !url) return false;
  run(
    `INSERT INTO share_profiles (uid, avatar_url, update_time)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(uid) DO UPDATE SET
       avatar_url = excluded.avatar_url,
       update_time = datetime('now')`,
    [safeUid, url]
  );
  persist();
  return true;
}

/** 读取分享页用户头像 URL */
function getShareAvatar(uid) {
  const safeUid = String(uid || '').trim();
  if (!safeUid) return '';
  const row = queryAll(
    `SELECT avatar_url FROM share_profiles WHERE uid = ? LIMIT 1`,
    [safeUid]
  )[0];
  return row?.avatar_url || '';
}

/** 清除分享页用户头像（恢复首字母占位） */
function clearShareAvatar(uid) {
  const safeUid = String(uid || '').trim();
  if (!safeUid) return false;
  run(
    `UPDATE share_profiles SET avatar_url = NULL, update_time = datetime('now') WHERE uid = ?`,
    [safeUid]
  );
  persist();
  return true;
}

const SHARE_MESSAGE_MAX_LEN = 1800;

/** 保存分享文案（邀请落地页读取） */
function saveShareMessage(uid, message) {
  const safeUid = String(uid || '').trim();
  const text = String(message || '').trim().slice(0, SHARE_MESSAGE_MAX_LEN);
  if (!safeUid || !text) return false;
  run(
    `INSERT INTO share_profiles (uid, share_message, update_time)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(uid) DO UPDATE SET
       share_message = excluded.share_message,
       update_time = datetime('now')`,
    [safeUid, text]
  );
  persist();
  return true;
}

/** 读取分享文案 */
function getShareMessage(uid) {
  const safeUid = String(uid || '').trim();
  if (!safeUid) return '';
  const row = queryAll(
    `SELECT share_message FROM share_profiles WHERE uid = ? LIMIT 1`,
    [safeUid]
  )[0];
  return String(row?.share_message || '').trim();
}

const POSTER_SLOGAN_MAX_LEN = 80;

/** 保存海报短标语 */
function savePosterSlogan(uid, slogan) {
  const safeUid = String(uid || '').trim();
  const text = String(slogan || '').trim().slice(0, POSTER_SLOGAN_MAX_LEN);
  if (!safeUid || !text) return false;
  run(
    `INSERT INTO share_profiles (uid, poster_slogan, update_time)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(uid) DO UPDATE SET
       poster_slogan = excluded.poster_slogan,
       update_time = datetime('now')`,
    [safeUid, text]
  );
  persist();
  return true;
}

/** 读取海报短标语 */
function getPosterSlogan(uid) {
  const safeUid = String(uid || '').trim();
  if (!safeUid) return '';
  const row = queryAll(
    `SELECT poster_slogan FROM share_profiles WHERE uid = ? LIMIT 1`,
    [safeUid]
  )[0];
  return String(row?.poster_slogan || '').trim();
}

const DISPLAY_NAME_MAX_LEN = 120;
const DISPLAY_COMPANY_MAX_LEN = 120;

/** 保存分享页展示名（OG / 落地页优先于报名姓名） */
function saveShareDisplayName(uid, name) {
  const safeUid = String(uid || '').trim();
  const text = String(name || '').trim().slice(0, DISPLAY_NAME_MAX_LEN);
  if (!safeUid || !text) return false;
  run(
    `INSERT INTO share_profiles (uid, display_name, update_time)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(uid) DO UPDATE SET
       display_name = excluded.display_name,
       update_time = datetime('now')`,
    [safeUid, text]
  );
  persist();
  return true;
}

function getShareDisplayName(uid) {
  const safeUid = String(uid || '').trim();
  if (!safeUid) return '';
  const row = queryAll(
    `SELECT display_name FROM share_profiles WHERE uid = ? LIMIT 1`,
    [safeUid]
  )[0];
  return String(row?.display_name || '').trim();
}

/** 保存分享页展示公司名 */
function saveShareDisplayCompany(uid, company) {
  const safeUid = String(uid || '').trim();
  const text = String(company || '').trim().slice(0, DISPLAY_COMPANY_MAX_LEN);
  if (!safeUid || !text) return false;
  run(
    `INSERT INTO share_profiles (uid, display_company, update_time)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(uid) DO UPDATE SET
       display_company = excluded.display_company,
       update_time = datetime('now')`,
    [safeUid, text]
  );
  persist();
  return true;
}

function getShareDisplayCompany(uid) {
  const safeUid = String(uid || '').trim();
  if (!safeUid) return '';
  const row = queryAll(
    `SELECT display_company FROM share_profiles WHERE uid = ? LIMIT 1`,
    [safeUid]
  )[0];
  return String(row?.display_company || '').trim();
}

/** 单个推荐人带来的报名明细（失败时返回 null） */
function getReferrerStats(uid) {
  try {
    return computeReferrerStats(uid);
  } catch (err) {
    console.error('[统计] getReferrerStats 失败:', err.message);
    return null;
  }
}

function computeReferrerStats(uid) {
  const safeUid = String(uid || '').trim();
  if (!safeUid) return null;

  const referrer = queryAll(
    `SELECT name, email, referral_id, company, create_time
     FROM registrant WHERE referral_id = ? AND ${sqlActiveRegistrant()} LIMIT 1`,
    [safeUid]
  )[0] || null;

  const referredUsers = queryAll(
    `SELECT name, email, company, register_channel, utm_source, create_time
     FROM registrant WHERE referred_by = ? AND ${sqlActiveRegistrant()} ORDER BY id DESC`,
    [safeUid]
  );

  const registrationsByChannel = queryAll(
    `SELECT register_channel, COUNT(*) AS count
     FROM registrant WHERE referred_by = ? AND register_channel != '' AND ${sqlActiveRegistrant()}
     GROUP BY register_channel ORDER BY count DESC`,
    [safeUid]
  );

  const shareActions = queryAll(
    `SELECT channel, COUNT(*) AS count
     FROM share_events WHERE sharer_uid = ? AND channel != 'page_view'
     GROUP BY channel ORDER BY count DESC`,
    [safeUid]
  );

  const pageViews =
    queryAll(
      `SELECT COUNT(*) AS c FROM share_events WHERE sharer_uid = ? AND channel = 'page_view'`,
      [safeUid]
    )[0]?.c || 0;

  const inviteViews =
    queryAll(
      `SELECT COUNT(*) AS c FROM share_events WHERE sharer_uid = ? AND channel = 'invite_view'`,
      [safeUid]
    )[0]?.c || 0;

  const inviteClicks =
    queryAll(
      `SELECT COUNT(*) AS c FROM share_events WHERE sharer_uid = ? AND channel = 'invite_click'`,
      [safeUid]
    )[0]?.c || 0;

  const tickets =
    queryAll(
      `SELECT COUNT(*) AS ticket_count, COALESCE(SUM(ticket_amount), 0) AS total_amount
       FROM ticket_events WHERE referred_by = ? AND is_captured = 1`,
      [safeUid]
    )[0] || { ticket_count: 0, total_amount: 0 };

  const displayName = resolveSharerDisplayNameFromDb(safeUid);

  return {
    uid: safeUid,
    display_name: displayName,
    referrer: referrer
      ? { ...referrer, display_name: displayName }
      : (displayName ? { name: displayName, email: '', referral_id: safeUid, display_name: displayName } : null),
    total_registrations: referredUsers.length,
    registrations_by_channel: registrationsByChannel,
    referred_users: referredUsers,
    share_actions: shareActions,
    page_views: pageViews,
    invite_views: inviteViews,
    invite_clicks: inviteClicks,
    tickets,
  };
}

function closeDatabase() {
  if (db) {
    flushPersist();
    db.close();
    db = null;
  }
}

module.exports = {
  initDatabase,
  saveRegistrant,
  removeRegistrantByEmail,
  isWelcomeEmailSent,
  markWelcomeEmailSent,
  tryClaimWelcomeEmailSend,
  releaseWelcomeEmailSendClaim,
  logShareEvent,
  logTicketEvent,
  getStats,
  getReferrerStats,
  getRegistrantByReferralId,
  getRegistrantByEmail,
  hasActiveMainEventRegistration,
  ensureSeedRegistrant,
  saveShareAvatar,
  getShareAvatar,
  clearShareAvatar,
  saveShareMessage,
  getShareMessage,
  savePosterSlogan,
  getPosterSlogan,
  saveShareDisplayName,
  getShareDisplayName,
  saveShareDisplayCompany,
  getShareDisplayCompany,
  listPartnerPages,
  getPartnerPage,
  savePartnerPage,
  deletePartnerPage,
  getSideEventRsvp,
  listSideEventRsvpsForUser,
  saveSideEventRsvp,
  deleteSideEventRsvp,
  deleteSideEventRsvpByEmail,
  closeDatabase,
  flushPersist,
  recoverDatabaseFromDisk,
  isSqlWasmError,
};
