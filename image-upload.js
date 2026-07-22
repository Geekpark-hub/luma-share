/**
 * Optional image upload helper.
 * POST {baseUrl}/api/v1/admin/images
 * multipart field: upload_file
 *
 * Uses native http(s) multipart (compatible with Node 16 without global FormData/fetch).
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

function extractImageUrl(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.url === 'string') return payload.url;
  if (payload.image && typeof payload.image.url === 'string') return payload.image.url;
  if (payload.data) return extractImageUrl(payload.data);
  return '';
}

function buildMultipartBody(buffer, { fieldName, filename, mime }) {
  const boundary = `----Upload${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const header = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n`
    + `Content-Type: ${mime}\r\n\r\n`,
    'utf8'
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([header, buffer, footer]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function postBuffer(url, body, contentType) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function uploadImageBuffer(buffer, {
  baseUrl = 'https://your-upload.example.com',
  filename = 'avatar.jpg',
  mime = 'image/jpeg',
} = {}) {
  const endpoint = `${String(baseUrl).replace(/\/$/, '')}/api/v1/admin/images`;
  const { body, contentType } = buildMultipartBody(buffer, {
    fieldName: 'upload_file',
    filename,
    mime,
  });

  const { status, text } = await postBuffer(endpoint, body, contentType);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`图床响应非 JSON (${status})`);
  }

  const url = extractImageUrl(data);
  if (status < 200 || status >= 300 || !url) {
    throw new Error(`图床上传失败 (${status}): ${text.slice(0, 200)}`);
  }
  const normalized = String(url).trim();
  return normalized.startsWith('http://') ? `https://${normalized.slice(7)}` : normalized;
}

module.exports = {
  uploadImageBuffer,
  extractImageUrl,
};
