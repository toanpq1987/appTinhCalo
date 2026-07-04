// ===== Kết nối Strava =====
// Coros / Garmin không mở API cho cá nhân, nhưng cả hai đều tự động sync
// sang Strava. Kết nối Strava = lấy được workout từ Coros/Garmin/Strava.
//
// OAuth đi qua Netlify Function (/api/strava-token): Client Secret của Strava
// được giữ trên server (biến môi trường), KHÔNG nằm trong máy người dùng.
// Người dùng chỉ bấm 1 nút "Kết nối Strava" — không cần nhập key.

const Strava = {
  AUTH_URL: 'https://www.strava.com/oauth/authorize',
  FN_URL: '/api/strava-token',
  API: 'https://www.strava.com/api/v3',

  get cfg() { return Store.strava; },

  isConnected() { return !!this.cfg.refreshToken; },

  // B1: chuyển tới trang cấp quyền Strava (lấy Client ID công khai từ server)
  async authorize() {
    let clientId;
    try {
      const res = await fetch(this.FN_URL);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'config');
      clientId = data.client_id;
    } catch (e) {
      throw new Error('Chưa kết nối được máy chủ Strava. Cần triển khai app lên Netlify (không chạy được ở bản xem thử offline).');
    }
    if (!clientId) throw new Error('Server chưa cấu hình Strava (thiếu STRAVA_CLIENT_ID).');

    const redirect = location.origin + location.pathname;
    const url = `${this.AUTH_URL}?client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirect)}` +
      `&response_type=code&approval_prompt=auto&scope=read,activity:read_all`;
    location.href = url;
  },

  // B2: khi Strava redirect về với ?code=..., đổi code lấy token qua function
  async handleRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (!code) return false;
    history.replaceState(null, '', location.pathname); // dọn URL
    try {
      const tok = await this._token({ grant_type: 'authorization_code', code });
      Store.setStrava({
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token,
        expiresAt: tok.expires_at,
        athlete: tok.athlete ? `${tok.athlete.firstname || ''} ${tok.athlete.lastname || ''}`.trim() : '',
      });
      return true;
    } catch (e) {
      console.error('Strava token error', e);
      throw new Error('Không đổi được mã Strava: ' + e.message);
    }
  },

  async _token(extra) {
    const res = await fetch(this.FN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(extra),
    });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const e = await res.json(); if (e && e.error) msg = e.error; } catch { /* giữ msg mặc định */ }
      throw new Error(msg);
    }
    return res.json();
  },

  async _accessToken() {
    const c = this.cfg;
    if (c.accessToken && c.expiresAt && c.expiresAt * 1000 > Date.now() + 60000) {
      return c.accessToken;
    }
    const tok = await this._token({ grant_type: 'refresh_token', refresh_token: c.refreshToken });
    Store.setStrava({ accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: tok.expires_at });
    return tok.access_token;
  },

  async _get(path) {
    const token = await this._accessToken();
    const res = await fetch(this.API + path, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error('api ' + res.status);
    return res.json();
  },

  // Đồng bộ activities N ngày gần nhất -> workouts trong app
  async sync(days = 7) {
    const after = Math.floor((Date.now() - days * 86400000) / 1000);
    const acts = await this._get(`/athlete/activities?after=${after}&per_page=60`);
    const profile = Store.profile;
    let added = 0, moved = 0;

    for (const a of acts) {
      // start_date_local là giờ địa phương nhưng Strava gắn đuôi "Z" (UTC),
      // nên KHÔNG parse qua new Date() (sẽ lệch +7h) — lấy thẳng phần YYYY-MM-DD
      const day = (a.start_date_local || a.start_date).slice(0, 10);

      const existing = Store.findStravaActivity(a.id);
      if (existing) {
        // tự sửa các buổi tập đã sync trước đây bị lệch ngày
        if (existing.dayKey !== day) {
          Store.moveWorkout(existing.dayKey, existing.workout.id, day);
          moved++;
        }
        continue;
      }

      // Lấy calo: activity detail có trường calories; nếu lỗi thì ước tính MET
      let kcal = 0;
      try {
        const detail = await this._get('/activities/' + a.id);
        kcal = Math.round(detail.calories || 0);
      } catch { /* dùng ước tính bên dưới */ }
      if (!kcal && a.kilojoules) kcal = Math.round(a.kilojoules); // ride: kJ ≈ kcal
      if (!kcal && profile) {
        const typeId = STRAVA_TYPE_MAP[a.sport_type || a.type] || 'other';
        kcal = estimateWorkoutKcal(typeId, (a.moving_time || 0) / 60, profile.weightKg);
      }
      if (!kcal) continue;

      const typeName = STRAVA_TYPE_VN[a.sport_type || a.type] || (a.sport_type || a.type);
      const typeId = STRAVA_TYPE_MAP[a.sport_type || a.type] || 'other';
      Store.addWorkout(day, {
        name: a.name || typeName,
        type: typeId,
        typeName,
        minutes: Math.round((a.moving_time || 0) / 60),
        distanceKm: a.distance ? +(a.distance / 1000).toFixed(2) : 0,
        kcal,
        source: 'strava',
        stravaId: a.id,
      });
      added++;
    }
    Store.setStrava({ lastSync: Date.now() });
    return { total: acts.length, added, moved };
  },

  disconnect() {
    Store.setStrava({ accessToken: null, refreshToken: null, expiresAt: null, athlete: null });
  },
};
