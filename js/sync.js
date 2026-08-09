// ===== Đăng nhập + đồng bộ đám mây (Supabase) =====
// Đồng bộ nguyên khối dữ liệu theo tài khoản: đăng nhập -> kéo về, thay đổi -> đẩy lên.
// Vẫn chạy offline bằng localStorage; chỉ đồng bộ khi đã đăng nhập + có mạng.
// Xung đột nhiều máy: máy có mốc updatedAt mới hơn thắng (đủ cho 1 người dùng vài máy).

const SUPABASE_URL = 'https://wdatibxdjuawqmylahbx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndkYXRpYnhkanVhd3FteWxhaGJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYyNzI0NTcsImV4cCI6MjEwMTg0ODQ1N30.js8JMCPGA-P_gtl40SNbGiK1B-_F3tICLMkZprajj8U';
const SYNC_TABLE = 'user_data';

const Sync = {
  client: null,
  user: null,
  status: 'local', // local | syncing | synced | offline | error | nolib
  _timer: null,

  init() {
    if (typeof supabase === 'undefined' || !supabase.createClient) {
      this.status = 'nolib';
      return;
    }
    this.client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });

    // Mỗi lần Store.save -> hẹn đẩy lên cloud
    Store._onSave = () => this.schedulePush();

    // Khôi phục phiên đăng nhập cũ
    this.client.auth.getSession().then(({ data }) => {
      if (data && data.session) { this.user = data.session.user; this.onLogin(); }
    });

    this.client.auth.onAuthStateChange((event, session) => {
      this.user = session ? session.user : null;
      if (event === 'SIGNED_IN') this.onLogin();
      else if (event === 'SIGNED_OUT') { this.status = 'local'; this._render(); }
    });

    // Có mạng lại -> đẩy nốt
    window.addEventListener('online', () => { if (this.isOn()) this.pushNow(); });
  },

  isReady() { return !!this.client; },
  isOn() { return !!this.user; },
  email() { return this.user ? this.user.email : ''; },

  // Tải món "thêm sau" từ bảng public foods (đọc công khai, không cần đăng nhập).
  // Thêm/sửa món chỉ cần INSERT vào Supabase -> KHÔNG phải deploy code.
  async fetchFoods() {
    if (!navigator.onLine) return;
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/foods?select=*`, {
        headers: { apikey: SUPABASE_ANON_KEY },
      });
      if (!res.ok) return; // bảng chưa tạo / offline -> dùng cache + DB gốc
      const rows = await res.json();
      if (!Array.isArray(rows)) return;
      const foods = rows.map(r => ({
        id: String(r.id),
        name: r.name,
        portion: r.portion || '100g',
        kcal: Number(r.kcal) || 0,
        protein: Number(r.protein) || 0,
        carbs: Number(r.carbs) || 0,
        fat: Number(r.fat) || 0,
        cat: r.cat || 'ingredient',
        composite: !!r.composite,
        servings: r.servings || undefined,
        ingredients: r.ingredients || undefined,
      }));
      Store.setRemoteFoods(foods);
      if (typeof App !== 'undefined' && App.view === 'food') App.render();
    } catch (e) {
      console.warn('Tải món remote lỗi (bỏ qua):', e);
    }
  },

  statusText() {
    return {
      syncing: '🔄 Đang đồng bộ…',
      synced: '✅ Đã đồng bộ',
      offline: '📴 Ngoại tuyến — sẽ đồng bộ khi có mạng',
      error: '⚠️ Lỗi đồng bộ (dữ liệu vẫn an toàn trên máy)',
      local: 'Chưa đăng nhập — dữ liệu chỉ ở máy này',
      nolib: 'Đồng bộ chưa sẵn sàng',
    }[this.status] || '';
  },

  async signUp(email, password) {
    const { data, error } = await this.client.auth.signUp({ email, password });
    if (error) throw error;
    // Nếu tắt "Confirm email", signUp trả session luôn -> đăng nhập ngay
    if (!data.session) {
      const r = await this.client.auth.signInWithPassword({ email, password });
      if (r.error) throw r.error;
    }
    return data;
  },

  async signIn(email, password) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  async signOut() {
    await this.client.auth.signOut();
    this.user = null;
    this.status = 'local';
  },

  // Có dữ liệu thật hay không (để KHÔNG BAO GIỜ đè local có data bằng cloud trống)
  _hasContent(d) {
    if (!d || typeof d !== 'object') return false;
    const days = d.days || {};
    const anyDay = Object.keys(days).some(k => {
      const day = days[k] || {};
      return (day.meals && day.meals.length) || (day.workouts && day.workouts.length) || day.steps || day.sleep;
    });
    return anyDay || (d.customFoods && d.customFoods.length) || (d.weights && d.weights.length) || !!d.plan;
  },

  // Đăng nhập xong: gộp an toàn — chỉ lấy cloud khi cloud CÓ nội dung và mới hơn (hoặc local trống)
  async onLogin() {
    if (!this.isOn() || this._busy) return;
    this._busy = true;
    this.status = 'syncing'; this._render();
    try {
      const { data, error } = await this.client
        .from(SYNC_TABLE).select('data, updated_at').eq('user_id', this.user.id).maybeSingle();
      if (error) throw error;

      const cloud = data && data.data ? data.data : null;
      const local = Store.load();
      const cloudHas = this._hasContent(cloud);
      const localHas = this._hasContent(local);
      const cloudT = (cloud && cloud.updatedAt) || 0;
      const localT = local.updatedAt || 0;

      if (cloudHas && (!localHas || cloudT > localT)) {
        Store.replaceAll(cloud);           // cloud có nội dung & (local trống hoặc cloud mới hơn)
        this.status = 'synced';
        this._render(true);
      } else {
        await this.pushNow();              // còn lại: đẩy local lên — KHÔNG đè local bằng cloud trống
      }
    } catch (e) {
      console.warn('Sync onLogin lỗi:', e);
      this.status = navigator.onLine ? 'error' : 'offline';
      this._render();
    } finally {
      this._busy = false;
    }
  },

  schedulePush() {
    if (!this.isOn()) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.pushNow(), 1500);
  },

  async pushNow() {
    if (!this.isOn()) return;
    if (!navigator.onLine) { this.status = 'offline'; this._render(); return; }
    const data = Store.load();
    // Đừng đẩy dữ liệu TRỐNG đè lên cloud (bảo vệ bản cloud khỏi bị xoá nhầm)
    if (!this._hasContent(data)) { this.status = 'synced'; this._render(); return; }
    this.status = 'syncing'; this._render();
    try {
      const { error } = await this.client.from(SYNC_TABLE).upsert({
        user_id: this.user.id,
        data,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      this.status = 'synced';
    } catch (e) {
      console.warn('Sync push lỗi:', e);
      this.status = 'error';
    }
    this._render();
  },

  // Cập nhật lại giao diện nếu đang ở Cài đặt (hiện trạng thái); reRenderAll khi đổi data
  _render(reRenderAll) {
    if (typeof App === 'undefined') return;
    if (reRenderAll) App.render();
    else if (App.view === 'settings') App.render();
  },
};
