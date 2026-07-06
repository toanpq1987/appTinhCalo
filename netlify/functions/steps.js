// Netlify Function — lưu số bước (steps) để đồng bộ giữa iOS Shortcuts và app.
//
// App PWA cài trên iPhone có bộ nhớ tách khỏi Safari, nên không thể nhận steps
// qua ?steps= trực tiếp. Thay vào đó: iOS Shortcuts POST số bước lên đây (chạy
// ngầm, không mở trình duyệt), app GET lại khi mở. Dữ liệu lưu trong Netlify
// Blobs, khóa theo "syncKey" ngẫu nhiên của từng máy.
//
//   GET  /api/steps?key=ck_xxx           -> { days: { "YYYY-MM-DD": count, ... } }
//   POST /api/steps  { key, date, steps } -> gộp 1 ngày
//   POST /api/steps  { key, days:{...} }   -> gộp nhiều ngày
//   POST /api/steps  { key, steps:"YYYY-MM-DD:count,..." } -> chuỗi gọn

const { getStore } = require('@netlify/blobs');

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(obj),
});

const KEY_RE = /^ck_[a-z0-9]{8,64}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Ngày hôm nay theo giờ Việt Nam (UTC+7) — dùng khi Shortcut không gửi date
const vnDate = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

exports.handler = async (event) => {
  let store;
  try {
    store = getStore('caloviet-steps');
  } catch (e) {
    return json(500, { error: 'Blobs chưa sẵn sàng.' });
  }

  // ----- Đọc steps đã lưu -----
  if (event.httpMethod === 'GET') {
    const key = (event.queryStringParameters || {}).key || '';
    if (!KEY_RE.test(key)) return json(400, { error: 'key không hợp lệ' });
    const days = (await store.get(key, { type: 'json' })) || {};
    return json(200, { days });
  }

  // ----- Ghi steps -----
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'JSON lỗi' }); }
    const key = body.key || '';
    if (!KEY_RE.test(key)) return json(400, { error: 'key không hợp lệ' });

    const incoming = {};
    const put = (d, c) => {
      d = String(d || '').trim();
      const n = Number(c);
      if (DATE_RE.test(d) && Number.isFinite(n) && n >= 0) incoming[d] = Math.round(n);
    };

    if (body.days && typeof body.days === 'object') {
      for (const [d, c] of Object.entries(body.days)) put(d, c);
    }
    if (typeof body.steps === 'string' && body.steps.includes(':')) {
      body.steps.split(',').forEach(p => { const b = p.split(':'); put(b[0], b[1]); });
    } else if (body.steps != null) {
      // Không gửi date -> mặc định hôm nay theo giờ VN
      put(body.date != null ? body.date : vnDate(), body.steps);
    }

    if (!Object.keys(incoming).length) return json(400, { error: 'không có dữ liệu steps hợp lệ' });

    const existing = (await store.get(key, { type: 'json' })) || {};
    const merged = Object.assign({}, existing, incoming);
    // giữ tối đa 400 ngày gần nhất cho gọn
    const dates = Object.keys(merged).sort();
    if (dates.length > 400) for (const d of dates.slice(0, dates.length - 400)) delete merged[d];

    await store.setJSON(key, merged);
    return json(200, { ok: true, saved: Object.keys(incoming).length });
  }

  return json(405, { error: 'Method Not Allowed' });
};
