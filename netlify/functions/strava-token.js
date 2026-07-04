// Netlify Function — cầu nối OAuth Strava cho PWA tĩnh.
//
// Vì đây là app tĩnh (không có server riêng), Client Secret của Strava KHÔNG
// được để trong JS trình duyệt (ai cũng xem được). Function này chạy trên
// server Netlify, giữ Secret trong biến môi trường, và làm giúp bước đổi token.
//
// Cấu hình trên Netlify → Site settings → Environment variables:
//   STRAVA_CLIENT_ID       (công khai được)
//   STRAVA_CLIENT_SECRET   (bí mật — chỉ nằm ở đây)
//
//   GET  /api/strava-token  -> { client_id }             (frontend build link cấp quyền)
//   POST /api/strava-token  -> đổi authorization_code / refresh_token lấy access token

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
  const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return json(500, { error: 'Server chưa cấu hình STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET.' });
  }

  // GET: trả về Client ID (công khai) để frontend dựng link cấp quyền
  if (event.httpMethod === 'GET') {
    return json(200, { client_id: CLIENT_ID });
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Body không hợp lệ.' });
  }

  const body = new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET });

  if (payload.grant_type === 'authorization_code') {
    if (!payload.code) return json(400, { error: 'Thiếu code.' });
    body.set('grant_type', 'authorization_code');
    body.set('code', payload.code);
  } else if (payload.grant_type === 'refresh_token') {
    if (!payload.refresh_token) return json(400, { error: 'Thiếu refresh_token.' });
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', payload.refresh_token);
  } else {
    return json(400, { error: 'grant_type không hợp lệ.' });
  }

  let data;
  try {
    const res = await fetch('https://www.strava.com/oauth/token', { method: 'POST', body });
    data = await res.json();
    if (!res.ok) {
      return json(res.status, { error: (data && data.message) || 'Strava từ chối yêu cầu.', detail: data });
    }
  } catch (e) {
    return json(502, { error: 'Không gọi được Strava.' });
  }

  // Chỉ trả về đúng những trường frontend cần (không lộ gì thừa)
  return json(200, {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    athlete: data.athlete
      ? { firstname: data.athlete.firstname || '', lastname: data.athlete.lastname || '' }
      : undefined,
  });
};
