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

  // Đăng nhập xong: kéo cloud về, gộp theo updatedAt (mới hơn thắng)
  async onLogin() {
    if (!this.isOn()) return;
    this.status = 'syncing'; this._render();
    try {
      const { data, error } = await this.client
        .from(SYNC_TABLE).select('data, updated_at').eq('user_id', this.user.id).maybeSingle();
      if (error) throw error;

      const cloud = data && data.data ? data.data : null;
      const local = Store.load();
      const localT = local.updatedAt || 0;
      const cloudT = (cloud && cloud.updatedAt) || 0;

      if (cloud && cloudT >= localT) {
        Store.replaceAll(cloud);        // cloud mới hơn -> dùng cloud
        this.status = 'synced';
        this._render(true);
      } else {
        await this.pushNow();           // local mới hơn (hoặc cloud rỗng) -> đẩy local lên
      }
    } catch (e) {
      console.warn('Sync onLogin lỗi:', e);
      this.status = navigator.onLine ? 'error' : 'offline';
      this._render();
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
    this.status = 'syncing'; this._render();
    try {
      const data = Store.load();
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
