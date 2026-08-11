// ===== Lưu trữ dữ liệu (localStorage) =====
const Store = {
  KEY: 'caloviet_v1',
  FOODS_CACHE_KEY: 'caloviet_remote_foods',
  _data: null,
  _remoteFoods: [], // món thêm sau, tải từ Supabase (bảng foods) — không cần deploy

  load() {
    if (this._data) return this._data;
    try {
      this._data = JSON.parse(localStorage.getItem(this.KEY)) || {};
    } catch { this._data = {}; }
    this._data.days ??= {};          // { 'YYYY-MM-DD': { meals: [], workouts: [] } }
    this._data.customFoods ??= [];   // món tự thêm
    this._data.weights ??= [];       // [{date, kg}]
    this._data.strava ??= {};        // credentials + tokens
    this._data.ai ??= {};            // cấu hình AI phân tích ảnh (apiKey, model)
    this._data.recentFoodIds ??= []; // món dùng gần đây
    this._data.plan ??= null;        // kế hoạch cân nặng {targetKg, date, startKg, created}
    return this._data;
  },

  save() {
    this._data.updatedAt = Date.now();               // mốc để đồng bộ (máy lưu sau thắng)
    localStorage.setItem(this.KEY, JSON.stringify(this._data));
    if (typeof this._onSave === 'function') this._onSave(); // hook đẩy lên cloud (Sync)
  },

  // Thay toàn bộ dữ liệu (dùng khi kéo từ cloud về) — KHÔNG kích hoạt _onSave để tránh đẩy ngược
  replaceAll(obj) {
    this._data = obj || {};
    localStorage.setItem(this.KEY, JSON.stringify(this._data));
  },

  get profile() { return this.load().profile || null; },
  set profile(p) { this.load().profile = p; this.save(); },

  day(key) {
    const d = this.load();
    d.days[key] ??= { meals: [], workouts: [] };
    return d.days[key];
  },

  addMeal(dayKey, entry) {
    entry.id = 'm' + Date.now() + Math.random().toString(36).slice(2, 6);
    this.day(dayKey).meals.push(entry);
    // lưu món gần đây
    if (entry.foodId) {
      const r = this.load().recentFoodIds.filter(id => id !== entry.foodId);
      r.unshift(entry.foodId);
      this.load().recentFoodIds = r.slice(0, 12);
    }
    this.save();
  },

  removeMeal(dayKey, id) {
    const d = this.day(dayKey);
    d.meals = d.meals.filter(m => m.id !== id);
    this.save();
  },

  // Sửa 1 món đã log (đổi số lượng/gram/bữa). Nếu đổi bữa vẫn giữ nguyên id.
  updateMeal(dayKey, id, patch) {
    const m = this.day(dayKey).meals.find(x => x.id === id);
    if (!m) return null;
    Object.assign(m, patch);
    this.save();
    return m;
  },

  addWorkout(dayKey, w) {
    w.id = 'w' + Date.now() + Math.random().toString(36).slice(2, 6);
    this.day(dayKey).workouts.push(w);
    this.save();
  },

  removeWorkout(dayKey, id) {
    const d = this.day(dayKey);
    d.workouts = d.workouts.filter(w => w.id !== id);
    this.save();
  },

  findStravaActivity(stravaId) {
    const days = this.load().days;
    for (const [dayKey, d] of Object.entries(days)) {
      const w = (d.workouts || []).find(x => x.stravaId === stravaId);
      if (w) return { dayKey, workout: w };
    }
    return null;
  },

  moveWorkout(fromDay, id, toDay) {
    const d = this.day(fromDay);
    const w = d.workouts.find(x => x.id === id);
    if (!w) return;
    d.workouts = d.workouts.filter(x => x.id !== id);
    this.day(toDay).workouts.push(w);
    this.save();
  },

  addCustomFood(f) {
    f.id = 'c' + Date.now();
    f.custom = true;
    this.load().customFoods.push(f);
    this.save();
    return f;
  },

  removeCustomFood(id) {
    const d = this.load();
    d.customFoods = d.customFoods.filter(f => f.id !== id);
    this.save();
  },

  updateCustomFood(id, patch) {
    const f = this.load().customFoods.find(x => x.id === id);
    if (!f) return null;
    Object.assign(f, patch);
    this.save();
    return f;
  },

  allFoods() {
    // Món của tôi + món thêm sau (Supabase) + DB gốc trong code
    return [...this.load().customFoods, ...this._remoteFoods, ...FOOD_DB];
  },

  // Đọc cache món remote (để offline / lần đầu hiện ngay)
  loadRemoteFoodsCache() {
    try {
      const c = JSON.parse(localStorage.getItem(this.FOODS_CACHE_KEY));
      if (Array.isArray(c)) this._remoteFoods = c;
    } catch { /* bỏ qua */ }
  },

  // Cập nhật món remote (sau khi tải từ Supabase) + lưu cache
  setRemoteFoods(arr) {
    this._remoteFoods = Array.isArray(arr) ? arr : [];
    try { localStorage.setItem(this.FOODS_CACHE_KEY, JSON.stringify(this._remoteFoods)); } catch { /* đầy bộ nhớ */ }
  },

  findFood(id) {
    return this.allFoods().find(f => f.id === id) || null;
  },

  addWeight(kg) {
    const d = this.load();
    const key = todayKey();
    d.weights = d.weights.filter(w => w.date !== key);
    d.weights.push({ date: key, kg });
    d.weights.sort((a, b) => a.date < b.date ? -1 : 1);
    // cập nhật cân nặng hồ sơ
    if (d.profile) d.profile.weightKg = kg;
    this.save();
  },

  get plan() { return this.load().plan; },
  setPlan(p) { this.load().plan = p; this.save(); },

  // Số bước 1 ngày (nhập từ Apple Health qua iOS Shortcuts)
  setSteps(dayKey, steps) {
    this.day(dayKey).steps = Math.max(0, Math.round(steps));
    this.save();
  },

  // Giấc ngủ 1 đêm {total,deep,core,rem,awake} phút (từ Apple Health qua Shortcuts)
  setSleep(dayKey, rec) {
    this.day(dayKey).sleep = rec;
    this.save();
  },

  // Khóa đồng bộ steps qua server (iOS Shortcuts POST, app GET) — sinh 1 lần
  get syncKey() {
    const d = this.load();
    if (!d.syncKey) {
      const rnd = (self.crypto && crypto.randomUUID)
        ? crypto.randomUUID().replace(/-/g, '')
        : (Math.random().toString(36) + Math.random().toString(36)).replace(/[^a-z0-9]/g, '');
      d.syncKey = 'ck_' + rnd;
      this.save();
    }
    return d.syncKey;
  },

  get strava() { return this.load().strava; },
  setStrava(patch) { Object.assign(this.load().strava, patch); this.save(); },

  get ai() { return this.load().ai; },
  setAI(patch) { Object.assign(this.load().ai, patch); this.save(); },

  // Tổng hợp 1 ngày
  daySummary(key) {
    const d = this.day(key);
    const kIn = d.meals.reduce((s, m) => s + m.kcal, 0);
    const kOut = d.workouts.reduce((s, w) => s + w.kcal, 0);
    const protein = d.meals.reduce((s, m) => s + (m.protein || 0), 0);
    const carbs = d.meals.reduce((s, m) => s + (m.carbs || 0), 0);
    const fat = d.meals.reduce((s, m) => s + (m.fat || 0), 0);
    return { kIn: Math.round(kIn), kOut: Math.round(kOut), protein: Math.round(protein), carbs: Math.round(carbs), fat: Math.round(fat), steps: d.steps || 0 };
  },

  exportJSON() { return JSON.stringify(this.load(), null, 2); },

  importJSON(text) {
    const obj = JSON.parse(text);
    if (typeof obj !== 'object' || !obj) throw new Error('File không hợp lệ');
    this._data = obj;
    this.save();
  },

  reset() {
    localStorage.removeItem(this.KEY);
    this._data = null;
  },
};
