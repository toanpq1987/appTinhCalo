// ===== Lưu trữ dữ liệu (localStorage) =====
const Store = {
  KEY: 'caloviet_v1',
  _data: null,

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

  allFoods() {
    return [...this.load().customFoods, ...FOOD_DB];
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
