// Netlify Function — lưu dữ liệu giấc ngủ (đọc từ Apple Health qua iOS Shortcuts).
// Cùng cơ chế với /api/steps: Shortcut POST ngầm, app GET khi mở.
//
// Cần env BLOBS_SITE_ID + BLOBS_TOKEN (giống steps).
//
//   GET  /api/sleep?key=ck_xxx  -> { days: { "YYYY-MM-DD": {total,deep,core,rem,awake} } }
//   POST /api/sleep  { key, date?, total?, deep?, core?, rem?, awake? }  (phút)
//        - không gửi date -> mặc định hôm nay (giờ VN)
//        - total tự tính = deep+core+rem nếu không gửi

const { getStore } = require('@netlify/blobs');

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(obj),
});

const KEY_RE = /^ck_[a-z0-9]{8,64}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STAGES = ['total', 'deep', 'core', 'rem', 'awake'];
const vnDate = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

function sleepStore() {
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  if (siteID && token) return getStore({ name: 'caloviet-sleep', siteID, token });
  return getStore('caloviet-sleep');
}

// Xây 1 bản ghi giấc ngủ từ object thô (phút, không âm)
function buildRec(src) {
  const rec = {};
  for (const s of STAGES) {
    const n = Number(src[s]);
    if (Number.isFinite(n) && n >= 0) rec[s] = Math.round(n);
  }
  if (rec.total == null && (rec.deep != null || rec.core != null || rec.rem != null)) {
    rec.total = (rec.deep || 0) + (rec.core || 0) + (rec.rem || 0);
  }
  return rec;
}

// Gom các đoạn ngủ thô "nhãn=thờilượng;nhãn=thờilượng" thành {deep,core,rem,awake,total}.
// Chịu được mọi kiểu tên (Apple/COROS) bằng cách khớp chuỗi con; tự nhận diện
// đơn vị giây/phút. Trả null nếu không đọc được gì.
function bucketSegments(segments) {
  const b = { deep: 0, core: 0, rem: 0, awake: 0 };
  String(segments).split(/[;,\n]+/).forEach(seg => {
    const parts = seg.split(/[=:|]/);
    if (parts.length < 2) return;
    const label = parts[0].toLowerCase();
    const dur = parseFloat(String(parts[1]).replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(dur) || dur <= 0) return;
    if (label.includes('deep')) b.deep += dur;
    else if (label.includes('rem')) b.rem += dur;
    else if (label.includes('awake') || label.includes('wake')) b.awake += dur;
    else if (label.includes('core') || label.includes('asleep') || label.includes('unspecified')) b.core += dur;
    // "in bed" bỏ qua
  });
  let sum = b.deep + b.core + b.rem + b.awake;
  if (sum <= 0) return null;
  // 1 đêm hợp lý < ~1500 phút; nếu tổng lớn hơn nhiều -> đơn vị là giây, quy ra phút
  if (sum > 1500) for (const k in b) b[k] = b[k] / 60;
  const rec = { deep: Math.round(b.deep), core: Math.round(b.core), rem: Math.round(b.rem), awake: Math.round(b.awake) };
  rec.total = rec.deep + rec.core + rec.rem;
  return rec;
}

exports.handler = async (event) => {
  try {
    const store = sleepStore();

    if (event.httpMethod === 'GET') {
      const key = (event.queryStringParameters || {}).key || '';
      if (!KEY_RE.test(key)) return json(400, { error: 'key không hợp lệ' });
      const days = (await store.get(key, { type: 'json' })) || {};
      return json(200, { days });
    }

    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'JSON lỗi' }); }
      const key = body.key || '';
      if (!KEY_RE.test(key)) return json(400, { error: 'key không hợp lệ' });

      const existing = (await store.get(key, { type: 'json' })) || {};
      let echo = null;

      if (typeof body.segments === 'string' && body.segments.trim()) {
        // Các đoạn ngủ thô từ Shortcut -> server tự gom nhóm
        const date = DATE_RE.test(body.date || '') ? body.date : vnDate();
        const rec = bucketSegments(body.segments);
        if (!rec) return json(400, { error: 'segments không đọc được', got: String(body.segments).slice(0, 200) });
        existing[date] = rec;
        echo = Object.assign({ date }, rec);
      } else if (body.days && typeof body.days === 'object') {
        // Nhiều đêm: { days: { date: {stages} } }
        for (const [d, src] of Object.entries(body.days)) {
          if (!DATE_RE.test(d) || typeof src !== 'object') continue;
          const rec = buildRec(src);
          if (Object.keys(rec).length) existing[d] = rec;
        }
      } else {
        // 1 đêm, gửi sẵn số phút mỗi giai đoạn
        const date = DATE_RE.test(body.date || '') ? body.date : vnDate();
        const rec = buildRec(body);
        if (!Object.keys(rec).length) return json(400, { error: 'không có dữ liệu giấc ngủ hợp lệ' });
        existing[date] = rec;
        echo = Object.assign({ date }, rec);
      }

      const dates = Object.keys(existing).sort();
      if (dates.length > 400) for (const d of dates.slice(0, dates.length - 400)) delete existing[d];

      await store.setJSON(key, existing);
      return json(200, { ok: true, parsed: echo });
    }

    return json(405, { error: 'Method Not Allowed' });
  } catch (e) {
    return json(500, { error: 'Lỗi lưu trữ giấc ngủ', detail: (e && (e.name + ': ' + e.message)) || String(e) });
  }
};
