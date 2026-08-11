// ===== Calo Việt — App chính =====
'use strict';

// Phiên bản app — PHẢI khớp số với CACHE trong sw.js (caloviet-v<APP_VERSION>).
// Mỗi lần cập nhật: tăng số này + số trong sw.js để user biết iOS đã lấy bản mới.
const APP_VERSION = 29;

const MEALS = [
  { id: 'breakfast', name: 'Bữa sáng', icon: '🌅' },
  { id: 'lunch',     name: 'Bữa trưa', icon: '☀️' },
  { id: 'dinner',    name: 'Bữa tối',  icon: '🌙' },
  { id: 'snack',     name: 'Ăn vặt',   icon: '🍪' },
];

// Định dạng phút -> "7h 49min"
function fmtDur(min) {
  min = Math.max(0, Math.round(min || 0));
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? `${h}h ${m}min` : `${h}h`) : `${m}min`;
}

// Đọc số thập phân, chấp nhận cả dấu phẩy (bàn phím VN) lẫn dấu chấm
function parseNum(v) {
  return parseFloat(String(v == null ? '' : v).replace(',', '.'));
}

const App = {
  view: 'today',
  dayKey: todayKey(),
  foodQuery: '',
  foodCat: 'all',

  el: {
    view: document.getElementById('view'),
    title: document.getElementById('view-title'),
    dateNav: document.getElementById('date-nav'),
    dateLabel: document.getElementById('date-label'),
    modalRoot: document.getElementById('modal-root'),
    toast: document.getElementById('toast'),
  },

  async init() {
    Store.load();
    Store.loadRemoteFoodsCache();                  // món "thêm sau" (từ cache) hiện ngay
    if (typeof Sync !== 'undefined') {
      Sync.init();                                 // đăng nhập + đồng bộ cloud (nếu có)
      Sync.fetchFoods();                           // tải món mới từ Supabase (không cần deploy)
    }

    // Strava OAuth redirect?
    if (location.search.includes('code=')) {
      try {
        const ok = await Strava.handleRedirect();
        if (ok) {
          this.toast('✅ Đã kết nối Strava!');
          this.view = 'workout';
        }
      } catch (e) { this.toast('⚠️ ' + e.message); }
    }

    // Nhận số bước từ iOS Shortcuts:
    //   ?steps=8500                              -> hôm nay
    //   ?steps=8500&date=2026-07-06              -> 1 ngày cụ thể
    //   ?steps=2026-07-04:6000,2026-07-05:9000   -> nhiều ngày (tự bù ngày lỡ)
    const sp = new URLSearchParams(location.search);
    if (sp.has('steps')) {
      const dateArg = sp.get('date');
      let n = 0;
      (sp.get('steps') || '').split(',').forEach(part => {
        part = part.trim();
        if (!part) return;
        let dk, cnt;
        if (part.includes(':')) {
          const bits = part.split(':');
          dk = (bits[0] || '').trim();
          cnt = parseInt(bits[1], 10);
        } else {
          dk = dateArg || todayKey();
          cnt = parseInt(part, 10);
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(dk) && Number.isFinite(cnt) && cnt >= 0) {
          Store.setSteps(dk, cnt);
          n++;
        }
      });
      history.replaceState(null, '', location.pathname);
      if (n) this.toast(`👟 Đã cập nhật bước chân (${n} ngày)`);
    }

    // Tab bar
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => this.go(btn.dataset.view));
    });
    document.getElementById('date-prev').addEventListener('click', () => { this.dayKey = shiftDate(this.dayKey, -1); this.render(); });
    document.getElementById('date-next').addEventListener('click', () => { this.dayKey = shiftDate(this.dayKey, 1); this.render(); });
    document.getElementById('date-label').addEventListener('click', () => { this.dayKey = todayKey(); this.render(); });

    this.render();

    // Tự đồng bộ Strava + kéo steps/giấc ngủ từ server khi mở app & khi quay lại từ nền
    this.autoSync();
    this.pullSteps();
    this.pullSleep();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { this.autoSync(); this.pullSteps(); this.pullSleep(); }
    });

    // Service worker
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  },

  // Kéo steps đã đồng bộ từ server (iOS Shortcuts đã POST lên) — âm thầm
  async pullSteps() {
    if (!navigator.onLine) return;
    try {
      const res = await fetch('/api/steps?key=' + encodeURIComponent(Store.syncKey));
      if (!res.ok) return;
      const data = await res.json();
      const days = data.days || {};
      let changed = false;
      for (const [d, c] of Object.entries(days)) {
        if (Store.daySummary(d).steps !== c) { Store.setSteps(d, c); changed = true; }
      }
      if (changed && (this.view === 'today' || this.view === 'stats')) this.render();
    } catch (e) {
      console.warn('Kéo steps lỗi (bỏ qua):', e); // im lặng, không làm phiền
    }
  },

  // Kéo dữ liệu giấc ngủ từ server — âm thầm
  async pullSleep() {
    if (!navigator.onLine) return;
    try {
      const res = await fetch('/api/sleep?key=' + encodeURIComponent(Store.syncKey));
      if (!res.ok) return;
      const data = await res.json();
      const days = data.days || {};
      let changed = false;
      for (const [d, rec] of Object.entries(days)) {
        if (JSON.stringify(Store.day(d).sleep) !== JSON.stringify(rec)) { Store.setSleep(d, rec); changed = true; }
      }
      if (changed && this.view === 'today') this.render();
    } catch (e) {
      console.warn('Kéo giấc ngủ lỗi (bỏ qua):', e);
    }
  },

  // Tự đồng bộ Strava âm thầm — có throttle để không gọi liên tục
  async autoSync() {
    if (!Strava.isConnected() || !navigator.onLine) return;
    const last = Store.strava.lastSync || 0;
    if (Date.now() - last < 20 * 60 * 1000) return; // tối đa 1 lần / 20 phút
    try {
      const r = await Strava.sync(7);
      if (r.added || r.moved) {
        this.render();
        const parts = [];
        if (r.added) parts.push(`+${r.added} buổi tập`);
        if (r.moved) parts.push(`sửa ngày ${r.moved}`);
        this.toast('🔄 Strava: ' + parts.join(', '));
      }
    } catch (e) {
      console.warn('Tự sync Strava lỗi (bỏ qua):', e); // im lặng, không làm phiền
    }
  },

  go(view) {
    this.view = view;
    this.render();
    window.scrollTo(0, 0);
  },

  render() {
    const titles = { today: 'Hôm nay', food: 'Món ăn', workout: 'Tập luyện', stats: 'Thống kê', settings: 'Cài đặt', onboard: 'Chào bạn 👋' };
    if (!Store.profile && this.view !== 'onboard') this.view = 'onboard';

    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === this.view));
    this.el.title.textContent = titles[this.view] || '';
    this.el.dateNav.classList.toggle('hidden', this.view !== 'today');
    if (this.view === 'today') {
      this.el.dateLabel.textContent = fmtDateVN(this.dayKey);
      this.el.title.textContent = '';
    }

    const fn = {
      onboard: this.renderOnboard, today: this.renderToday, food: this.renderFood,
      workout: this.renderWorkout, stats: this.renderStats, settings: this.renderSettings,
    }[this.view];
    this.el.view.innerHTML = '';
    fn.call(this);
  },

  // ========== ONBOARDING ==========
  renderOnboard() {
    document.getElementById('tabbar').style.display = 'none';
    this.el.view.innerHTML = `
      <div class="onboard-hero">
        <div class="emoji">🔥</div>
        <h2>Calo Việt</h2>
        <p>Theo dõi calo nạp vào − tiêu hao mỗi ngày.<br>Nhập vài thông tin để tính mục tiêu calo của bạn.</p>
      </div>
      <div class="card">
        <div class="field"><label>Giới tính</label>
          <div class="seg" id="ob-gender">
            <button data-v="male" class="active">Nam</button>
            <button data-v="female">Nữ</button>
          </div>
        </div>
        <div class="field-row">
          <div class="field"><label>Tuổi</label><input id="ob-age" type="number" inputmode="numeric" value="30" min="10" max="100"></div>
          <div class="field"><label>Chiều cao (cm)</label><input id="ob-height" type="number" inputmode="numeric" value="168" min="120" max="220"></div>
        </div>
        <div class="field"><label>Cân nặng (kg)</label><input id="ob-weight" type="text" inputmode="decimal" value="65"></div>
        <div class="field"><label>Mức vận động hằng ngày (KHÔNG tính buổi tập)</label>
          <select id="ob-activity">${ACTIVITY_LEVELS.map(a => `<option value="${a.id}">${a.label}</option>`).join('')}</select>
          <div class="hint">Buổi tập (chạy, gym, Strava...) sẽ được cộng riêng để không tính trùng.</div>
        </div>
        <div class="field"><label>Mục tiêu</label>
          <select id="ob-goal">${GOALS.map(g => `<option value="${g.id}" ${g.id === 'lose05' ? 'selected' : ''}>${g.label}</option>`).join('')}</select>
        </div>
        <button class="btn" id="ob-save">Bắt đầu 🚀</button>
      </div>`;

    const seg = document.getElementById('ob-gender');
    seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      seg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    }));

    document.getElementById('ob-save').addEventListener('click', () => {
      const p = {
        gender: seg.querySelector('.active').dataset.v,
        age: +document.getElementById('ob-age').value || 30,
        heightCm: +document.getElementById('ob-height').value || 168,
        weightKg: parseNum(document.getElementById('ob-weight').value) || 65,
        activity: document.getElementById('ob-activity').value,
        goal: document.getElementById('ob-goal').value,
      };
      Store.profile = p;
      Store.addWeight(p.weightKg);
      document.getElementById('tabbar').style.display = '';
      this.toast(`Mục tiêu của bạn: ${calcTarget(p)} kcal/ngày`);
      this.go('today');
    });
  },

  // ========== HÔM NAY ==========
  renderToday() {
    document.getElementById('tabbar').style.display = '';
    const p = Store.profile;
    const s = Store.daySummary(this.dayKey);
    const target = calcTarget(p);
    const budget = target + s.kOut;          // được ăn = mục tiêu + calo tập
    const remaining = budget - s.kIn;
    const pct = Math.min(1, s.kIn / budget);
    const over = remaining < 0;

    const R = 56, C = 2 * Math.PI * R;
    const day = Store.day(this.dayKey);

    // Mục tiêu macro/ngày + tiến độ đã ăn
    const mt = calcMacroTargets(p, target);
    const macroCell = (name, cur, tgt, color) => {
      const c = Math.round(cur);
      const pct = tgt > 0 ? Math.min(100, Math.round((c / tgt) * 100)) : 0;
      const over = tgt > 0 && c > tgt;
      const left = tgt > 0 ? tgt - c : 0;
      return `<div class="macro">
        <div class="m-val">${c}<span style="font-size:11px;color:var(--text-2);font-weight:600">/${tgt}g</span></div>
        <div class="m-name">${name}${tgt > 0 ? (left > 0 ? ` · thiếu ${left}` : left < 0 ? ` · dư ${-left}` : ' · đủ ✓') : ''}</div>
        <div style="background:var(--card);border-radius:999px;height:5px;margin-top:6px;overflow:hidden">
          <div style="background:${over ? 'var(--red)' : color};height:100%;width:${pct}%"></div>
        </div>
      </div>`;
    };

    let html = `
      <div class="card">
        <div class="summary">
          <div class="ring-wrap">
            <svg width="130" height="130" viewBox="0 0 130 130">
              <circle cx="65" cy="65" r="${R}" fill="none" stroke="var(--line)" stroke-width="11"/>
              <circle cx="65" cy="65" r="${R}" fill="none" stroke="${over ? 'var(--red)' : 'var(--green)'}"
                stroke-width="11" stroke-linecap="round"
                stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/>
            </svg>
            <div class="ring-center">
              <div class="big" style="${over ? 'color:var(--red)' : ''}">${Math.abs(remaining)}</div>
              <div class="lbl">${over ? 'kcal vượt mức' : 'kcal còn lại'}</div>
            </div>
          </div>
          <div class="summary-stats">
            <div class="sstat"><span class="dot" style="background:var(--orange)"></span>
              <div><div class="val">${s.kIn} kcal</div><div class="name">Đã nạp</div></div></div>
            <div class="sstat"><span class="dot" style="background:var(--blue)"></span>
              <div><div class="val">${s.kOut} kcal</div><div class="name">Tập luyện</div></div></div>
            <div class="sstat"><span class="dot" style="background:var(--green)"></span>
              <div><div class="val">${target} kcal</div><div class="name">Mục tiêu nạp</div></div></div>
          </div>
        </div>
        <div class="macros">
          ${macroCell('Đạm', s.protein, mt.protein, 'var(--green)')}
          ${macroCell('Tinh bột', s.carbs, mt.carbs, 'var(--orange)')}
          ${macroCell('Béo', s.fat, mt.fat, 'var(--blue)')}
        </div>
      </div>`;

    // ----- Bước chân (nhập từ Apple Health qua iOS Shortcuts) -----
    const stepsKcal = stepsToKcal(s.steps, p.weightKg);
    const plan = Store.plan;
    const stepGoal = (plan && plan.activityKcal > 0) ? kcalToSteps(plan.activityKcal, p.weightKg) : 10000;
    const stepGoalMet = stepGoal > 0 && s.steps >= stepGoal;
    html += `
      <div class="card">
        <div class="meal-head">
          <h2>👟 Bước chân</h2>
          <span style="font-weight:700;font-size:13px;color:${stepGoalMet ? 'var(--green-dark)' : 'var(--blue)'}">${s.steps.toLocaleString('vi-VN')} / ${stepGoal.toLocaleString('vi-VN')}</span>
        </div>
        <div style="background:var(--bg);border-radius:999px;height:8px;overflow:hidden">
          <div style="background:${stepGoalMet ? 'var(--green)' : 'var(--blue)'};height:100%;width:${stepGoal > 0 ? Math.min(100, Math.round(s.steps / stepGoal * 100)) : 0}%"></div>
        </div>
        <div class="sub" style="margin-top:6px">${s.steps > 0
          ? `≈ ${stepsKcal} kcal tiêu hao khi đi bộ`
          : 'Chưa có dữ liệu bước chân. Cài iOS Shortcut để tự đẩy từ Apple Health mỗi ngày.'}</div>
      </div>`;

    // ----- Giấc ngủ (nhập từ Apple Health qua iOS Shortcuts) -----
    const sl = Store.day(this.dayKey).sleep;
    const slStages = [
      { k: 'deep', label: 'Sâu', c: '#1e3a8a' },
      { k: 'core', label: 'Nhẹ', c: '#3f83f8' },
      { k: 'rem', label: 'REM', c: '#c7b4f8' },
      { k: 'awake', label: 'Thức', c: '#f0a6a6' },
    ];
    const slHasStages = sl && slStages.some(x => sl[x.k]);
    const slSum = sl ? slStages.reduce((a, x) => a + (sl[x.k] || 0), 0) : 0;
    html += `
      <div class="card">
        <div class="meal-head">
          <h2>🌙 Giấc ngủ</h2>
          <span style="font-weight:700;font-size:13px;color:#6d5bd0">${sl && sl.total ? fmtDur(sl.total) : '—'}</span>
        </div>
        ${slHasStages ? `
          <div style="display:flex;height:10px;border-radius:999px;overflow:hidden;background:var(--bg)">
            ${slStages.map(x => sl[x.k] ? `<div style="width:${(sl[x.k] / slSum * 100).toFixed(1)}%;background:${x.c}"></div>` : '').join('')}
          </div>
          <div class="sub" style="margin-top:6px">${slStages.filter(x => sl[x.k]).map(x => `<span style="color:${x.c}">●</span> ${x.label} ${fmtDur(sl[x.k])}`).join(' · ')}</div>`
        : `<div class="sub">${sl && sl.total ? '(chưa có chi tiết giai đoạn)' : 'Chưa có dữ liệu giấc ngủ. Cài iOS Shortcut đọc từ Apple Health.'}</div>`}
      </div>`;

    // Banner nhắc cam kết vận động — tính cả bước chân, lấy max để không đếm trùng
    if (plan && plan.activityKcal > 0) {
      const A = plan.activityKcal;
      const moveK = Math.max(s.kOut, stepsKcal);
      const met = moveK >= A;
      const missing = Math.max(0, A - moveK);
      const isToday = this.dayKey === todayKey();
      const isPast = this.dayKey < todayKey();
      html += `
        <div class="card" style="border-left:4px solid ${met ? 'var(--green)' : 'var(--orange)'}">
          <div class="meal-head">
            <h2>${met ? '✅' : isPast ? '❌' : '⏳'} Cam kết vận động</h2>
            <span class="kcal" style="color:${met ? 'var(--green-dark)' : 'var(--orange)'}">${moveK}/${A} kcal</span>
          </div>
          <div style="background:var(--bg);border-radius:999px;height:8px;overflow:hidden">
            <div style="background:${met ? 'var(--green)' : 'var(--orange)'};height:100%;width:${Math.min(100, Math.round(moveK / A * 100))}%"></div>
          </div>
          ${met
            ? '<div class="sub" style="margin-top:6px">Đã đạt cam kết vận động hôm nay 💪 (tính cả đi bộ + buổi tập).</div>'
            : isToday
              ? `<div class="sub" style="margin-top:6px">Còn thiếu <b>${missing} kcal</b> ≈ <b>${kcalToSteps(missing, p.weightKg).toLocaleString('vi-VN')} bước</b> nữa — tranh thủ vận động nhé!</div>`
              : isPast
                ? `<div class="sub" style="margin-top:6px">Ngày này thiếu ${missing} kcal so với cam kết.</div>`
                : ''}
        </div>`;
    }

    // Các bữa ăn
    for (const meal of MEALS) {
      const entries = day.meals.filter(m => m.meal === meal.id);
      const kcal = Math.round(entries.reduce((x, m) => x + m.kcal, 0));
      html += `
        <div class="card">
          <div class="meal-head">
            <h2>${meal.icon} ${meal.name}</h2>
            ${kcal ? `<span class="kcal">${kcal} kcal</span>` : ''}
          </div>
          ${entries.map(m => `
            <div class="entry">
              <div><div class="e-name">${esc(m.name)}</div><div class="e-sub">${(() => {
                const base = m.grams ? m.grams + (m.unit || 'g') : (m.qty !== 1 ? '×' + (+(+m.qty).toFixed(2)) : (m.portion ? esc(m.portion) : ''));
                const mac = `Đ${Math.round(m.protein || 0)} T${Math.round(m.carbs || 0)} B${Math.round(m.fat || 0)}`;
                return base ? base + ' · ' + mac : mac;
              })()}</div></div>
              <div style="display:flex;align-items:center">
                <span class="e-kcal">${Math.round(m.kcal)}</span>
                <button class="e-del" data-edit-meal="${m.id}" style="font-size:14px" aria-label="Sửa">✏️</button>
                <button class="e-del" data-del-meal="${m.id}" aria-label="Xóa">✕</button>
              </div>
            </div>`).join('') || ''}
          <button class="add-line" data-add-meal="${meal.id}">＋ Thêm món</button>
        </div>`;
    }

    // Tập luyện hôm nay
    html += `
      <div class="card">
        <div class="meal-head">
          <h2>🏃 Tập luyện</h2>
          ${s.kOut ? `<span class="kcal" style="color:var(--blue)">−${s.kOut} kcal</span>` : ''}
        </div>
        ${day.workouts.map(w => `
          <div class="entry">
            <div><div class="e-name">${esc(w.name)}</div>
              <div class="e-sub">${w.minutes ? w.minutes + ' phút' : ''}${w.distanceKm ? ' · ' + w.distanceKm + ' km' : ''}${w.source === 'strava' ? ' · Strava' : ''}</div></div>
            <div style="display:flex;align-items:center">
              <span class="e-kcal" style="color:var(--blue)">−${w.kcal}</span>
              <button class="e-del" data-del-workout="${w.id}">✕</button>
            </div>
          </div>`).join('') || '<div class="empty-note">Chưa có buổi tập nào.</div>'}
        <button class="add-line" data-add-workout="1">＋ Thêm buổi tập</button>
      </div>`;

    this.el.view.innerHTML = html;

    this.el.view.querySelectorAll('[data-add-meal]').forEach(b =>
      b.addEventListener('click', () => { this.pendingMeal = b.dataset.addMeal; this.go('food'); }));
    this.el.view.querySelectorAll('[data-del-meal]').forEach(b =>
      b.addEventListener('click', () => { Store.removeMeal(this.dayKey, b.dataset.delMeal); this.render(); }));
    this.el.view.querySelectorAll('[data-edit-meal]').forEach(b =>
      b.addEventListener('click', () => {
        const entry = Store.day(this.dayKey).meals.find(m => m.id === b.dataset.editMeal);
        if (entry) this.openEditMealModal(entry);
      }));
    this.el.view.querySelectorAll('[data-del-workout]').forEach(b =>
      b.addEventListener('click', () => { Store.removeWorkout(this.dayKey, b.dataset.delWorkout); this.render(); }));
    const addW = this.el.view.querySelector('[data-add-workout]');
    if (addW) addW.addEventListener('click', () => this.openWorkoutModal());
  },

  // ========== MÓN ĂN ==========
  renderFood() {
    document.getElementById('tabbar').style.display = '';
    const cats = [['all', 'Tất cả'], ['recent', '🕐 Gần đây'], ...Object.entries(FOOD_CATS), ['custom', '⭐ Món của tôi']];

    this.el.view.innerHTML = `
      <div class="search-row">
        <input class="search-box" id="food-search" type="search" placeholder="Tìm món... (vd: pho bo, com tam)" value="${esc(this.foodQuery)}">
        <button class="scan-btn" id="btn-scan" aria-label="Quét mã vạch">📷</button>
        <button class="scan-btn" id="btn-vision" aria-label="Chụp ảnh món ăn (AI)">📸</button>
      </div>
      <div class="chips" id="food-chips">
        ${cats.map(([id, name]) => `<button class="chip ${this.foodCat === id ? 'active' : ''}" data-cat="${id}">${name}</button>`).join('')}
      </div>
      <div id="food-list"></div>
      <button class="btn secondary" id="btn-custom-food" style="margin-top:6px">＋ Tạo món mới (nhập theo 100g)</button>
      <button class="btn secondary" id="btn-recipe" style="margin-top:6px">🍲 Tạo món ghép (nhiều nguyên liệu)</button>
      <div class="sub" style="text-align:center;margin-top:10px">Calo ước tính theo khẩu phần phổ biến — có thể chỉnh số lượng khi thêm.</div>`;

    const input = document.getElementById('food-search');
    input.addEventListener('input', () => { this.foodQuery = input.value; this.renderFoodList(); });
    document.getElementById('food-chips').querySelectorAll('.chip').forEach(c =>
      c.addEventListener('click', () => { this.foodCat = c.dataset.cat; this.render(); }));
    document.getElementById('btn-custom-food').addEventListener('click', () => this.openCustomFoodModal());
    document.getElementById('btn-recipe').addEventListener('click', () => {
      this.recipeDraft = { name: '', servings: 1, ingredients: [] };
      this.openRecipeModal();
    });
    document.getElementById('btn-scan').addEventListener('click', () => Scanner.open());
    document.getElementById('btn-vision').addEventListener('click', () => Vision.open());

    this.renderFoodList();
    if (!this.foodQuery) setTimeout(() => input.focus({ preventScroll: true }), 50);
  },

  renderFoodList() {
    const q = stripVN(this.foodQuery.trim());
    let foods = Store.allFoods();

    if (this.foodCat === 'recent') {
      const ids = Store.load().recentFoodIds;
      foods = ids.map(id => Store.findFood(id)).filter(Boolean);
    } else if (this.foodCat === 'custom') {
      foods = Store.load().customFoods;
    } else if (this.foodCat !== 'all') {
      foods = foods.filter(f => f.cat === this.foodCat);
    }
    if (q) foods = foods.filter(f => stripVN(f.name).includes(q));
    foods = foods.slice(0, 60);

    const list = document.getElementById('food-list');
    list.innerHTML = foods.map(f => `
      <div class="food-item" data-food="${f.id}">
        <div>
          <div class="f-name">${f.composite ? '🍲 ' : f.custom ? '⭐ ' : ''}${esc(f.name)}</div>
          <div class="f-sub">${esc(f.portion || '')} · Đ:${f.protein || 0} T:${f.carbs || 0} B:${f.fat || 0}</div>
        </div>
        <div class="f-kcal">${f.kcal} <small>kcal</small></div>
      </div>`).join('') ||
      `<div class="card"><div class="empty-note">Không tìm thấy món nào. Bạn có thể tạo món mới bên dưới 👇</div></div>`;

    list.querySelectorAll('.food-item').forEach(el =>
      el.addEventListener('click', () => this.openPortionModal(Store.findFood(el.dataset.food))));
  },

  openPortionModal(food) {
    if (!food) return;
    let qty = 1;
    const defaultMeal = this.pendingMeal || guessMeal();

    // Món có ghi trọng lượng trong khẩu phần (vd "1 chén (150g)", "100g", "1 ly 250ml")
    // -> cho nhập chính xác gram/ml
    const gMatch = (food.portion || '').match(/(\d+(?:[.,]\d+)?)\s*(g|gram|ml)\b/i);
    const baseG = gMatch ? parseFloat(gMatch[1].replace(',', '.')) : 0;
    const unit = gMatch ? (gMatch[2].toLowerCase() === 'ml' ? 'ml' : 'g') : '';

    this.modal(`
      <h3>${esc(food.name)}</h3>
      <div class="m-sub">${esc(food.portion || '')} · ${food.kcal} kcal / phần</div>
      <div class="qty-row">
        <button id="q-minus">−</button>
        <input class="qty-input" id="q-val" type="number" inputmode="decimal" step="0.1" min="0.1" max="20" value="1">
        <button id="q-plus">＋</button>
      </div>
      <div class="sub" style="text-align:center;margin-top:-8px;margin-bottom:12px">số phần — bấm vào số để gõ tùy ý (vd 1.3)</div>
      ${baseG ? `
      <div class="field"><label>Hoặc nhập chính xác lượng ăn (${unit})</label>
        <input id="q-grams" type="number" inputmode="decimal" min="1" value="${baseG}">
        <div class="hint">1 phần = ${baseG}${unit} · nhập vd 185 nếu bạn ăn 185${unit}</div>
      </div>` : ''}
      <div class="field"><label>Bữa</label>
        <select id="q-meal">${MEALS.map(m => `<option value="${m.id}" ${m.id === defaultMeal ? 'selected' : ''}>${m.icon} ${m.name}</option>`).join('')}</select>
      </div>
      <div class="macros" style="margin:0 0 14px">
        <div class="macro"><div class="m-val" id="q-p">0g</div><div class="m-name">Đạm</div></div>
        <div class="macro"><div class="m-val" id="q-c">0g</div><div class="m-name">Tinh bột</div></div>
        <div class="macro"><div class="m-val" id="q-f">0g</div><div class="m-name">Béo</div></div>
      </div>
      <button class="btn" id="q-add">Thêm — <span id="q-kcal">${food.kcal}</span> kcal</button>
      ${food.custom ? `<button class="btn secondary" id="q-edit" style="margin-top:8px">✏️ Sửa${food.composite ? ' món ghép' : ' món'}</button>` : ''}`);

    const $ = id => document.getElementById(id);
    const clamp = v => Math.min(20, Math.max(0.1, v));
    const round2 = v => Math.round(v * 100) / 100;
    const g1 = v => +(v || 0).toFixed(1);

    // syncFrom: 'qty' | 'grams' — tránh ghi đè ô người dùng đang gõ
    const upd = (syncFrom) => {
      $('q-kcal').textContent = Math.round(food.kcal * qty);
      $('q-p').textContent = g1((food.protein || 0) * qty) + 'g';
      $('q-c').textContent = g1((food.carbs || 0) * qty) + 'g';
      $('q-f').textContent = g1((food.fat || 0) * qty) + 'g';
      if (syncFrom !== 'qty') $('q-val').value = round2(qty);
      if (baseG && syncFrom !== 'grams') $('q-grams').value = Math.round(qty * baseG);
    };
    upd();

    $('q-minus').addEventListener('click', () => { qty = clamp(round2(qty - 0.5)); upd(); });
    $('q-plus').addEventListener('click', () => { qty = clamp(round2(qty + 0.5)); upd(); });
    $('q-val').addEventListener('input', () => {
      const v = parseFloat($('q-val').value);
      if (v > 0) { qty = clamp(round2(v)); upd('qty'); }
    });
    if (baseG) $('q-grams').addEventListener('input', () => {
      const g = parseFloat($('q-grams').value);
      if (g > 0) { qty = clamp(round2(g / baseG)); upd('grams'); }
    });

    $('q-add').addEventListener('click', () => {
      qty = round2(qty);
      Store.addMeal(this.dayKey, {
        foodId: food.id, name: food.name, portion: food.portion, qty,
        grams: baseG ? Math.round(qty * baseG) : null, unit: unit || null,
        kcal: food.kcal * qty, protein: (food.protein || 0) * qty,
        carbs: (food.carbs || 0) * qty, fat: (food.fat || 0) * qty,
        meal: $('q-meal').value,
      });
      this.pendingMeal = null;
      this.closeModal();
      this.toast(`✅ Đã thêm ${food.name}`);
      this.go('today');
    });

    if ($('q-edit')) $('q-edit').addEventListener('click', () => {
      this.closeModal();
      if (food.composite && food.ingredients && food.ingredients.length) this.openRecipeEdit(food);
      else this.openCustomFoodModal(food);
    });
  },

  // Sửa 1 món ĐÃ LOG: đổi số phần / gram / bữa (suy ra giá trị/phần từ bản ghi cũ)
  openEditMealModal(entry) {
    const qtyBase = entry.qty && entry.qty > 0 ? entry.qty : 1;
    const per = {
      kcal: entry.kcal / qtyBase,
      protein: (entry.protein || 0) / qtyBase,
      carbs: (entry.carbs || 0) / qtyBase,
      fat: (entry.fat || 0) / qtyBase,
    };
    let qty = qtyBase;
    const gMatch = (entry.portion || '').match(/(\d+(?:[.,]\d+)?)\s*(g|gram|ml)\b/i);
    const baseG = gMatch ? parseFloat(gMatch[1].replace(',', '.')) : 0;
    const unit = gMatch ? (gMatch[2].toLowerCase() === 'ml' ? 'ml' : 'g') : (entry.unit || '');

    this.modal(`
      <h3>Sửa món đã ăn</h3>
      <div class="m-sub">${esc(entry.name)} · ${Math.round(per.kcal)} kcal / phần</div>
      <div class="qty-row">
        <button id="q-minus">−</button>
        <input class="qty-input" id="q-val" type="number" inputmode="decimal" step="0.1" min="0.1" max="20" value="1">
        <button id="q-plus">＋</button>
      </div>
      <div class="sub" style="text-align:center;margin-top:-8px;margin-bottom:12px">số phần — bấm vào số để gõ tùy ý (vd 1.3)</div>
      ${baseG ? `
      <div class="field"><label>Hoặc nhập chính xác lượng ăn (${unit})</label>
        <input id="q-grams" type="number" inputmode="decimal" min="1" value="${baseG}">
        <div class="hint">1 phần = ${baseG}${unit}</div>
      </div>` : ''}
      <div class="field"><label>Bữa</label>
        <select id="q-meal">${MEALS.map(m => `<option value="${m.id}" ${m.id === entry.meal ? 'selected' : ''}>${m.icon} ${m.name}</option>`).join('')}</select>
      </div>
      <div class="macros" style="margin:0 0 14px">
        <div class="macro"><div class="m-val" id="q-p">0g</div><div class="m-name">Đạm</div></div>
        <div class="macro"><div class="m-val" id="q-c">0g</div><div class="m-name">Tinh bột</div></div>
        <div class="macro"><div class="m-val" id="q-f">0g</div><div class="m-name">Béo</div></div>
      </div>
      <button class="btn" id="q-save">Lưu thay đổi — <span id="q-kcal">0</span> kcal</button>
      <button class="btn danger" id="q-del" style="margin-top:8px">🗑️ Xóa món này</button>`);

    const $ = id => document.getElementById(id);
    const clamp = v => Math.min(20, Math.max(0.1, v));
    const round2 = v => Math.round(v * 100) / 100;
    const g1 = v => +(v || 0).toFixed(1);
    const upd = (from) => {
      $('q-kcal').textContent = Math.round(per.kcal * qty);
      $('q-p').textContent = g1(per.protein * qty) + 'g';
      $('q-c').textContent = g1(per.carbs * qty) + 'g';
      $('q-f').textContent = g1(per.fat * qty) + 'g';
      if (from !== 'qty') $('q-val').value = round2(qty);
      if (baseG && from !== 'grams') $('q-grams').value = Math.round(qty * baseG);
    };
    upd();

    $('q-minus').addEventListener('click', () => { qty = clamp(round2(qty - 0.5)); upd(); });
    $('q-plus').addEventListener('click', () => { qty = clamp(round2(qty + 0.5)); upd(); });
    $('q-val').addEventListener('input', () => {
      const v = parseFloat($('q-val').value);
      if (v > 0) { qty = clamp(round2(v)); upd('qty'); }
    });
    if (baseG) $('q-grams').addEventListener('input', () => {
      const g = parseFloat($('q-grams').value);
      if (g > 0) { qty = clamp(round2(g / baseG)); upd('grams'); }
    });

    $('q-save').addEventListener('click', () => {
      qty = round2(qty);
      Store.updateMeal(this.dayKey, entry.id, {
        qty,
        grams: baseG ? Math.round(qty * baseG) : (entry.grams || null),
        unit: unit || null,
        kcal: per.kcal * qty,
        protein: per.protein * qty,
        carbs: per.carbs * qty,
        fat: per.fat * qty,
        meal: $('q-meal').value,
      });
      this.closeModal();
      this.toast('✅ Đã cập nhật món');
      this.render();
    });

    $('q-del').addEventListener('click', () => {
      Store.removeMeal(this.dayKey, entry.id);
      this.closeModal();
      this.toast('Đã xóa món');
      this.render();
    });
  },

  openCustomFoodModal(edit) {
    const f = edit || {};
    this.modal(`
      <h3>${edit ? 'Sửa món' : 'Tạo món mới'}</h3>
      <div class="m-sub">Nên nhập <b>theo 100g</b> — sau này lúc ăn chỉ cần nhập số gram, app tự tính calo theo lượng ăn. (Hoặc đổi đơn vị sang "1 tô", "1 cái"... nếu muốn tính theo phần.)</div>
      <div class="field"><label>Tên món *</label><input id="cf-name" placeholder="vd: Ức gà luộc" value="${esc(f.name || '')}"></div>
      <div class="field"><label>Đơn vị</label><input id="cf-portion" placeholder="100g" value="${esc(f.portion || '100g')}">
        <div class="hint">Giữ <b>100g</b> để cân theo gram. Số calo & macro bên dưới là <b>cho đơn vị này</b>.</div>
      </div>
      <div class="field"><label>Calo cho đơn vị trên (kcal) *</label><input id="cf-kcal" type="text" inputmode="decimal" placeholder="vd: 165" value="${f.kcal != null ? f.kcal : ''}">
        <div class="hint" id="cf-macro-hint" style="display:none"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Đạm (g)</label><input id="cf-p" type="text" inputmode="decimal" placeholder="0" value="${f.protein != null ? f.protein : ''}"></div>
        <div class="field"><label>Tinh bột (g)</label><input id="cf-c" type="text" inputmode="decimal" placeholder="0" value="${f.carbs != null ? f.carbs : ''}"></div>
        <div class="field"><label>Béo (g)</label><input id="cf-f" type="text" inputmode="decimal" placeholder="0" value="${f.fat != null ? f.fat : ''}"></div>
      </div>
      <button class="btn" id="cf-save">${edit ? 'Lưu thay đổi' : 'Lưu món'}</button>
      ${edit ? '<button class="btn danger" id="cf-del" style="margin-top:8px">🗑️ Xóa món</button>' : ''}`);

    const $ = id => document.getElementById(id);
    const hint = $('cf-macro-hint');
    // Gợi ý calo suy ra từ macro (Atwater: đạm 4, tinh bột 4, béo 9 kcal/g)
    const updateHint = () => {
      const macroKcal = Math.round(
        (parseNum($('cf-p').value) || 0) * 4 + (parseNum($('cf-c').value) || 0) * 4 + (parseNum($('cf-f').value) || 0) * 9
      );
      if (macroKcal <= 0) { hint.style.display = 'none'; return; }
      hint.style.display = '';
      const kcal = parseNum($('cf-kcal').value) || 0;
      const diffPct = kcal > 0 ? Math.round(Math.abs(kcal - macroKcal) / macroKcal * 100) : 0;
      const warn = kcal > 0 && diffPct > 10;
      hint.style.color = warn ? 'var(--orange)' : '';
      const useBtn = `<button type="button" id="cf-use-macro" style="background:none;border:none;padding:0;margin-left:8px;` +
        `color:var(--green-dark);font-weight:600;font-size:inherit;cursor:pointer;text-decoration:underline">Dùng ${macroKcal}</button>`;
      hint.innerHTML = warn
        ? `⚠️ Từ macro ≈ <b>${macroKcal} kcal</b> — lệch ${diffPct}% so với ${kcal} bạn nhập.${useBtn}`
        : `Từ macro ≈ <b>${macroKcal} kcal</b>.${useBtn}`;
      $('cf-use-macro').addEventListener('click', () => { $('cf-kcal').value = macroKcal; updateHint(); });
    };
    ['cf-p', 'cf-c', 'cf-f', 'cf-kcal'].forEach(id => $(id).addEventListener('input', updateHint));
    updateHint();

    $('cf-save').addEventListener('click', () => {
      const name = $('cf-name').value.trim();
      const kcal = parseNum($('cf-kcal').value);
      if (!name || !kcal) { this.toast('⚠️ Cần nhập tên món và calo'); return; }
      const patch = {
        name, portion: $('cf-portion').value.trim() || '100g', kcal,
        protein: parseNum($('cf-p').value) || 0,
        carbs: parseNum($('cf-c').value) || 0,
        fat: parseNum($('cf-f').value) || 0,
        cat: (edit && edit.cat) || 'dish',
      };
      const saved = edit ? Store.updateCustomFood(edit.id, patch) : Store.addCustomFood(patch);
      this.closeModal();
      if (saved) this.openPortionModal(saved);
    });

    if ($('cf-del')) $('cf-del').addEventListener('click', () => {
      if (confirm('Xóa món "' + (edit.name || '') + '"?')) {
        Store.removeCustomFood(edit.id);
        this.closeModal();
        this.toast('Đã xóa món');
        this.go('food');
      }
    });
  },

  // ===== Món ghép (nhiều nguyên liệu) =====
  openRecipeModal() {
    const d = this.recipeDraft || (this.recipeDraft = { name: '', servings: 1, ingredients: [] });
    const g1 = v => +(v || 0).toFixed(1);
    const sum = d.ingredients.reduce((a, x) => ({
      kcal: a.kcal + x.kcal, p: a.p + x.protein, c: a.c + x.carbs, f: a.f + x.fat,
    }), { kcal: 0, p: 0, c: 0, f: 0 });
    const sv = Math.max(1, d.servings || 1);
    const perK = Math.round(sum.kcal / sv);

    this.modal(`
      <h3>🍲 ${d.editId ? 'Sửa món ghép' : 'Tạo món ghép'}</h3>
      <div class="m-sub">Ghép nhiều nguyên liệu → app tự cộng calo & macro, chia số phần.</div>
      <div class="field"><label>Tên món *</label><input id="rc-name" placeholder="vd: Ốc chuối đậu" value="${esc(d.name)}"></div>

      <label style="font-weight:600;font-size:13px">Nguyên liệu (${d.ingredients.length})</label>
      <div id="rc-list" style="margin:6px 0 10px">
        ${d.ingredients.length ? d.ingredients.map((x, i) => `
          <div class="entry">
            <div><div class="e-name">${esc(x.name)}</div>
              <div class="e-sub">${esc(x.portionLabel || '')} · Đ${g1(x.protein)} T${g1(x.carbs)} B${g1(x.fat)}</div></div>
            <div style="display:flex;align-items:center">
              <span class="e-kcal" style="color:var(--orange)">${Math.round(x.kcal)}</span>
              <button class="e-del" data-rc-del="${i}">✕</button>
            </div>
          </div>`).join('') : '<div class="empty-note">Chưa có nguyên liệu — bấm bên dưới để thêm.</div>'}
      </div>
      <button class="btn secondary" id="rc-add-ing" style="margin-bottom:12px">＋ Thêm nguyên liệu</button>

      <div class="field"><label>Chia thành mấy phần?</label>
        <input id="rc-servings" type="number" inputmode="numeric" min="1" value="${sv}">
        <div class="hint">Nấu 1 nồi ăn 3 bát → nhập 3. Món lưu = 1 phần (1 bát).</div>
      </div>

      <div class="card" style="background:var(--bg);padding:12px;margin-bottom:12px">
        <div style="display:flex;justify-content:space-between"><span class="sub">Tổng cả món</span><b id="rc-total">${Math.round(sum.kcal)} kcal</b></div>
        <div style="display:flex;justify-content:space-between;margin-top:4px"><span class="sub">Mỗi phần</span><b id="rc-per" style="color:var(--green-dark)">${perK} kcal · Đ${g1(sum.p / sv)} T${g1(sum.c / sv)} B${g1(sum.f / sv)}</b></div>
      </div>

      <button class="btn" id="rc-save">${d.editId ? 'Lưu thay đổi' : 'Lưu món'} — 1 phần = <span id="rc-save-k">${perK}</span> kcal</button>
      ${d.editId ? '<button class="btn danger" id="rc-del" style="margin-top:8px">🗑️ Xóa món ghép</button>' : ''}`);

    const $ = id => document.getElementById(id);
    const saveInputs = () => {
      d.name = $('rc-name').value;
      d.servings = Math.max(1, parseInt($('rc-servings').value) || 1);
    };
    const recompute = () => {
      const sv2 = Math.max(1, parseInt($('rc-servings').value) || 1);
      $('rc-total').textContent = Math.round(sum.kcal) + ' kcal';
      $('rc-per').textContent = `${Math.round(sum.kcal / sv2)} kcal · Đ${g1(sum.p / sv2)} T${g1(sum.c / sv2)} B${g1(sum.f / sv2)}`;
      $('rc-save-k').textContent = Math.round(sum.kcal / sv2);
    };

    $('rc-name').addEventListener('input', () => { d.name = $('rc-name').value; });
    $('rc-servings').addEventListener('input', recompute);
    $('rc-add-ing').addEventListener('click', () => { saveInputs(); this.openRecipeIngredientPicker(); });
    this.el.modalRoot.querySelectorAll('[data-rc-del]').forEach(b =>
      b.addEventListener('click', () => { saveInputs(); d.ingredients.splice(+b.dataset.rcDel, 1); this.openRecipeModal(); }));

    $('rc-save').addEventListener('click', () => {
      saveInputs();
      const name = (d.name || '').trim();
      if (!name) { this.toast('⚠️ Nhập tên món'); return; }
      if (!d.ingredients.length) { this.toast('⚠️ Thêm ít nhất 1 nguyên liệu'); return; }
      const svN = Math.max(1, d.servings || 1);
      const r1 = v => Math.round((v / svN) * 10) / 10;
      const patch = {
        name, portion: '1 phần', cat: 'dish',
        kcal: Math.round(sum.kcal / svN), protein: r1(sum.p), carbs: r1(sum.c), fat: r1(sum.f),
        composite: true, servings: svN,
        ingredients: d.ingredients.map(x => ({
          name: x.name, portionLabel: x.portionLabel,
          kcal: Math.round(x.kcal), protein: g1(x.protein), carbs: g1(x.carbs), fat: g1(x.fat),
        })),
      };
      const saved = d.editId ? Store.updateCustomFood(d.editId, patch) : Store.addCustomFood(patch);
      this.recipeDraft = null;
      this.closeModal();
      this.toast(d.editId ? '✅ Đã cập nhật món ghép' : '✅ Đã tạo món ghép: ' + name);
      if (saved) this.openPortionModal(saved);
    });

    if ($('rc-del')) $('rc-del').addEventListener('click', () => {
      if (confirm('Xóa món ghép "' + (d.name || '') + '"?')) {
        Store.removeCustomFood(d.editId);
        this.recipeDraft = null;
        this.closeModal();
        this.toast('Đã xóa món ghép');
        this.go('food');
      }
    });
  },

  // Mở lại 1 món ghép đã tạo để sửa (nạp nguyên liệu + số phần đã lưu)
  openRecipeEdit(food) {
    this.recipeDraft = {
      name: food.name,
      servings: food.servings || 1,
      editId: food.id,
      ingredients: (food.ingredients || []).map(x => ({
        name: x.name, portionLabel: x.portionLabel,
        kcal: +x.kcal || 0, protein: +x.protein || 0, carbs: +x.carbs || 0, fat: +x.fat || 0,
      })),
    };
    this.openRecipeModal();
  },

  // Chọn nguyên liệu để thêm vào món ghép
  openRecipeIngredientPicker() {
    this.modal(`
      <h3>Thêm nguyên liệu</h3>
      <input class="search-box" id="ri-search" type="search" placeholder="Tìm... (vd: thit ba chi, dau phu)">
      <div id="ri-list" style="margin-top:10px;max-height:46vh;overflow:auto"></div>
      <button class="btn secondary" id="ri-custom" style="margin-top:10px">✏️ Nhập tay (nguyên liệu chưa có)</button>
      <button class="btn secondary" id="ri-back" style="margin-top:8px">← Quay lại món</button>`);

    const $ = id => document.getElementById(id);
    const renderList = () => {
      const q = stripVN(($('ri-search').value || '').trim());
      let foods = Store.allFoods();
      if (q) foods = foods.filter(f => stripVN(f.name).includes(q));
      foods = foods.slice(0, 40);
      $('ri-list').innerHTML = foods.map(f => `
        <div class="food-item" data-food="${f.id}">
          <div><div class="f-name">${f.custom ? '⭐ ' : ''}${esc(f.name)}</div>
            <div class="f-sub">${esc(f.portion || '')} · ${f.kcal} kcal</div></div>
        </div>`).join('') || '<div class="empty-note">Không thấy — thử nhập tay bên dưới 👇</div>';
      $('ri-list').querySelectorAll('.food-item').forEach(el =>
        el.addEventListener('click', () => this.openRecipePortion(Store.findFood(el.dataset.food))));
    };
    $('ri-search').addEventListener('input', renderList);
    $('ri-back').addEventListener('click', () => this.openRecipeModal());
    $('ri-custom').addEventListener('click', () => this.openRecipeCustomIngredient());
    renderList();
  },

  // Chọn khẩu phần cho 1 nguyên liệu rồi thêm vào món ghép
  openRecipePortion(food) {
    if (!food) return;
    let qty = 1;
    const gMatch = (food.portion || '').match(/(\d+(?:[.,]\d+)?)\s*(g|gram|ml)\b/i);
    const baseG = gMatch ? parseFloat(gMatch[1].replace(',', '.')) : 0;
    const unit = gMatch ? (gMatch[2].toLowerCase() === 'ml' ? 'ml' : 'g') : '';

    this.modal(`
      <h3>${esc(food.name)}</h3>
      <div class="m-sub">${esc(food.portion || '')} · ${food.kcal} kcal / phần</div>
      <div class="qty-row"><button id="q-minus">−</button>
        <input class="qty-input" id="q-val" type="number" inputmode="decimal" step="0.1" min="0.1" value="1">
        <button id="q-plus">＋</button></div>
      <div class="sub" style="text-align:center;margin-top:-8px;margin-bottom:12px">số phần</div>
      ${baseG ? `<div class="field"><label>Hoặc nhập chính xác (${unit})</label>
        <input id="q-grams" type="number" inputmode="decimal" min="1" value="${baseG}">
        <div class="hint">1 phần = ${baseG}${unit}</div></div>` : ''}
      <div class="macros" style="margin:0 0 14px">
        <div class="macro"><div class="m-val" id="q-p">0g</div><div class="m-name">Đạm</div></div>
        <div class="macro"><div class="m-val" id="q-c">0g</div><div class="m-name">Tinh bột</div></div>
        <div class="macro"><div class="m-val" id="q-f">0g</div><div class="m-name">Béo</div></div>
      </div>
      <button class="btn" id="q-add">Thêm vào món — <span id="q-kcal">${food.kcal}</span> kcal</button>
      <button class="btn secondary" id="q-back" style="margin-top:8px">← Quay lại</button>`);

    const $ = id => document.getElementById(id);
    const clamp = v => Math.min(50, Math.max(0.1, v));
    const round2 = v => Math.round(v * 100) / 100;
    const g1 = v => +(v || 0).toFixed(1);
    const upd = (from) => {
      $('q-kcal').textContent = Math.round(food.kcal * qty);
      $('q-p').textContent = g1((food.protein || 0) * qty) + 'g';
      $('q-c').textContent = g1((food.carbs || 0) * qty) + 'g';
      $('q-f').textContent = g1((food.fat || 0) * qty) + 'g';
      if (from !== 'qty') $('q-val').value = round2(qty);
      if (baseG && from !== 'grams') $('q-grams').value = Math.round(qty * baseG);
    };
    upd();
    $('q-minus').addEventListener('click', () => { qty = clamp(round2(qty - 0.5)); upd(); });
    $('q-plus').addEventListener('click', () => { qty = clamp(round2(qty + 0.5)); upd(); });
    $('q-val').addEventListener('input', () => { const v = parseFloat($('q-val').value); if (v > 0) { qty = clamp(round2(v)); upd('qty'); } });
    if (baseG) $('q-grams').addEventListener('input', () => { const gv = parseFloat($('q-grams').value); if (gv > 0) { qty = clamp(round2(gv / baseG)); upd('grams'); } });
    $('q-back').addEventListener('click', () => this.openRecipeIngredientPicker());
    $('q-add').addEventListener('click', () => {
      qty = round2(qty);
      const portionLabel = baseG ? Math.round(qty * baseG) + unit
        : (qty === 1 ? (food.portion || '1 phần') : qty + ' × ' + (food.portion || 'phần'));
      this.recipeDraft.ingredients.push({
        name: food.name, portionLabel,
        kcal: food.kcal * qty, protein: (food.protein || 0) * qty,
        carbs: (food.carbs || 0) * qty, fat: (food.fat || 0) * qty,
      });
      this.openRecipeModal();
    });
  },

  // Nhập tay 1 nguyên liệu (cho đúng lượng đã dùng) khi DB không có
  openRecipeCustomIngredient() {
    this.modal(`
      <h3>Nhập nguyên liệu tay</h3>
      <div class="m-sub">Nhập cho ĐÚNG lượng bạn dùng trong món (không phải per 100g).</div>
      <div class="field"><label>Tên *</label><input id="ric-name" placeholder="vd: Ốc đã sơ chế (100g)"></div>
      <div class="field"><label>Calo (kcal) *</label><input id="ric-kcal" type="text" inputmode="decimal" placeholder="vd: 90"></div>
      <div class="field-row">
        <div class="field"><label>Đạm (g)</label><input id="ric-p" type="text" inputmode="decimal" placeholder="0"></div>
        <div class="field"><label>Tinh bột (g)</label><input id="ric-c" type="text" inputmode="decimal" placeholder="0"></div>
        <div class="field"><label>Béo (g)</label><input id="ric-f" type="text" inputmode="decimal" placeholder="0"></div>
      </div>
      <button class="btn" id="ric-add">Thêm vào món</button>
      <button class="btn secondary" id="ric-back" style="margin-top:8px">← Quay lại</button>`);

    const $ = id => document.getElementById(id);
    $('ric-back').addEventListener('click', () => this.openRecipeIngredientPicker());
    $('ric-add').addEventListener('click', () => {
      const name = $('ric-name').value.trim();
      const kcal = parseNum($('ric-kcal').value);
      if (!name || !kcal) { this.toast('⚠️ Cần tên và calo'); return; }
      this.recipeDraft.ingredients.push({
        name, portionLabel: 'nhập tay',
        kcal, protein: parseNum($('ric-p').value) || 0,
        carbs: parseNum($('ric-c').value) || 0, fat: parseNum($('ric-f').value) || 0,
      });
      this.openRecipeModal();
    });
  },

  // ========== TẬP LUYỆN ==========
  renderWorkout() {
    document.getElementById('tabbar').style.display = '';
    const st = Store.strava;
    const connected = Strava.isConnected();

    // Buổi tập 7 ngày gần nhất
    const rows = [];
    for (let i = 0; i < 7; i++) {
      const key = shiftDate(todayKey(), -i);
      for (const w of Store.day(key).workouts) rows.push({ ...w, day: key });
    }

    this.el.view.innerHTML = `
      <div class="card">
        <h2>🟠 Strava — cầu nối Coros / Garmin</h2>
        <div class="sub" style="margin-bottom:12px">
          Đồng hồ Coros / Garmin của bạn tự động sync sang Strava.
          Kết nối Strava ở đây là app lấy được mọi buổi tập (kèm calo) từ cả 3 nguồn.
        </div>
        ${connected ? `
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
            <span class="strava-badge">✓ Đã kết nối${st.athlete ? ' · ' + esc(st.athlete) : ''}</span>
            <span class="sub">${st.lastSync ? 'Sync: ' + new Date(st.lastSync).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : ''}</span>
          </div>
          <div class="btn-row">
            <button class="btn" id="strava-sync">🔄 Đồng bộ 7 ngày</button>
            <button class="btn secondary" id="strava-sync-30">30 ngày</button>
          </div>` : `
          <button class="btn" style="background:#fc4c02" id="strava-connect">Kết nối Strava</button>`}
      </div>

      <div class="card">
        <h2>Thêm buổi tập thủ công</h2>
        <button class="btn secondary" id="btn-manual-workout">＋ Nhập buổi tập</button>
      </div>

      <div class="card">
        <h2>7 ngày gần đây</h2>
        ${rows.map(w => `
          <div class="entry">
            <div style="display:flex;align-items:center;gap:10px">
              <div class="workout-icon">${(WORKOUT_TYPES.find(t => t.id === w.type) || {}).icon || '💪'}</div>
              <div><div class="e-name">${esc(w.name)}</div>
                <div class="e-sub">${fmtDateVN(w.day)}${w.minutes ? ' · ' + w.minutes + 'p' : ''}${w.distanceKm ? ' · ' + w.distanceKm + 'km' : ''}${w.source === 'strava' ? ' · Strava' : ''}</div></div>
            </div>
            <span class="e-kcal" style="color:var(--blue)">−${w.kcal}</span>
          </div>`).join('') || '<div class="empty-note">Chưa có buổi tập nào trong 7 ngày qua.</div>'}
      </div>`;

    const $ = id => document.getElementById(id);
    if ($('strava-connect')) $('strava-connect').addEventListener('click', () => this.connectStrava());
    if ($('strava-sync')) $('strava-sync').addEventListener('click', () => this.doSync(7));
    if ($('strava-sync-30')) $('strava-sync-30').addEventListener('click', () => this.doSync(30));
    $('btn-manual-workout').addEventListener('click', () => this.openWorkoutModal());
  },

  async connectStrava() {
    this.toast('🟠 Đang mở Strava...');
    try {
      await Strava.authorize(); // chuyển hướng sang Strava nếu thành công
    } catch (e) {
      this.toast('⚠️ ' + e.message);
    }
  },

  async doSync(days) {
    this.toast('🔄 Đang đồng bộ Strava...');
    try {
      const r = await Strava.sync(days);
      const parts = [];
      if (r.added) parts.push(`thêm ${r.added} buổi mới`);
      if (r.moved) parts.push(`sửa ngày ${r.moved} buổi`);
      this.toast(parts.length ? '✅ Đã ' + parts.join(', ') : '✅ Không có buổi tập mới');
      this.render();
    } catch (e) {
      console.error(e);
      this.toast('⚠️ Lỗi đồng bộ. Thử kết nối lại Strava.');
    }
  },

  openWorkoutModal() {
    const p = Store.profile;
    this.modal(`
      <h3>Thêm buổi tập</h3>
      <div class="m-sub">Calo tự ước tính theo môn & thời gian — bạn có thể sửa.</div>
      <div class="field"><label>Môn</label>
        <select id="w-type">${WORKOUT_TYPES.map(t => `<option value="${t.id}">${t.icon} ${t.name}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Thời gian (phút)</label><input id="w-min" type="number" inputmode="numeric" value="30"></div>
      <div class="field"><label>Calo tiêu hao (kcal)</label><input id="w-kcal" type="number" inputmode="numeric">
        <div class="hint" id="w-hint"></div></div>
      <button class="btn" id="w-add">Thêm buổi tập</button>`);

    const upd = () => {
      const est = estimateWorkoutKcal(document.getElementById('w-type').value, +document.getElementById('w-min').value || 0, p.weightKg);
      document.getElementById('w-kcal').value = est;
      document.getElementById('w-hint').textContent = `Ước tính cho ${p.weightKg} kg`;
    };
    upd();
    document.getElementById('w-type').addEventListener('change', upd);
    document.getElementById('w-min').addEventListener('input', upd);
    document.getElementById('w-add').addEventListener('click', () => {
      const typeId = document.getElementById('w-type').value;
      const t = WORKOUT_TYPES.find(x => x.id === typeId);
      const minutes = +document.getElementById('w-min').value || 0;
      const kcal = +document.getElementById('w-kcal').value || 0;
      if (!kcal) { this.toast('⚠️ Nhập calo hoặc thời gian'); return; }
      Store.addWorkout(this.dayKey, { name: t.name, type: typeId, minutes, kcal, source: 'manual' });
      this.closeModal();
      this.toast('✅ Đã thêm buổi tập');
      this.render();
    });
  },

  // ========== THỐNG KÊ ==========
  renderStats() {
    document.getElementById('tabbar').style.display = '';
    const p = Store.profile;
    const target = calcTarget(p);

    // 7 ngày
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const key = shiftDate(todayKey(), -i);
      days.push({ key, ...Store.daySummary(key) });
    }
    const maxV = Math.max(target * 1.25, ...days.map(d => d.kIn), 100);
    const W = 460, H = 190, pad = 6, bw = 30, gap = (W - 2 * pad) / 7;
    const y = v => H - 24 - (v / maxV) * (H - 40);
    const dayNames = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

    let bars = '';
    days.forEach((d, i) => {
      const x = pad + i * gap + (gap - bw) / 2;
      const [yy, mm, dd] = d.key.split('-').map(Number);
      const dow = dayNames[new Date(yy, mm - 1, dd).getDay()];
      bars += `
        <rect x="${x}" y="${y(d.kIn)}" width="${bw * 0.62}" height="${Math.max(0, H - 24 - y(d.kIn))}" rx="4" fill="var(--orange)" opacity="${d.kIn ? 1 : .15}"/>
        <rect x="${x + bw * 0.68}" y="${y(d.kOut)}" width="${bw * 0.42}" height="${Math.max(0, H - 24 - y(d.kOut))}" rx="4" fill="var(--blue)" opacity="${d.kOut ? 1 : .15}"/>
        <text x="${x + bw / 2}" y="${H - 8}" font-size="11" fill="var(--text-2)" text-anchor="middle">${dow}</text>`;
    });

    const daysWithData = days.filter(d => d.kIn > 0);
    const avgIn = daysWithData.length ? Math.round(daysWithData.reduce((s, d) => s + d.kIn, 0) / daysWithData.length) : 0;
    const totalOut = days.reduce((s, d) => s + d.kOut, 0);
    const avgNet = daysWithData.length ? Math.round(daysWithData.reduce((s, d) => s + d.kIn - d.kOut, 0) / daysWithData.length) : 0;
    const tdee = calcTDEE(p);

    // Cân nặng — chạm vào điểm để xem ngày + kg (thay cho hover trên điện thoại)
    const ws = Store.load().weights.slice(-30);
    let weightChart = '<div class="empty-note">Chưa có dữ liệu cân nặng.</div>';
    if (ws.length >= 1) {
      const vals = ws.map(w => w.kg);
      const minKg = Math.min(...vals), maxKg = Math.max(...vals);
      const lo = minKg - 1, hi = maxKg + 1;
      const wy = v => 130 - 15 - ((v - lo) / (hi - lo)) * 100;
      const wx = i => ws.length === 1 ? 230 : 15 + (i / (ws.length - 1)) * 430;
      const pts = ws.map((w, i) => `${wx(i)},${wy(w.kg)}`).join(' ');
      const first = ws[0], last = ws[ws.length - 1];
      const diff = +(last.kg - first.kg).toFixed(1);
      weightChart = `
        <div id="wt-svg" style="position:relative">
          <div id="wt-tip" style="position:absolute;display:none;transform:translate(-50%,-145%);background:var(--text);color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:7px;white-space:nowrap;pointer-events:none;z-index:2"></div>
          <svg class="bars" viewBox="0 0 460 130" style="display:block">
            <polyline points="${pts}" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linejoin="round"/>
            ${ws.map((w, i) => `<circle cx="${wx(i)}" cy="${wy(w.kg)}" r="3.5" fill="var(--green)" data-dot="${i}" style="pointer-events:none"/>`).join('')}
            ${ws.map((w, i) => `<circle cx="${wx(i)}" cy="${wy(w.kg)}" r="11" fill="transparent" style="cursor:pointer"
              data-wi="${i}" data-l="${(wx(i) / 460 * 100).toFixed(2)}" data-t="${(wy(w.kg) / 130 * 100).toFixed(2)}"
              data-d="${esc(fmtFullDate(w.date))}" data-k="${w.kg}"/>`).join('')}
            <text x="${wx(ws.length - 1)}" y="${wy(last.kg) - 10}" font-size="12" font-weight="700" fill="var(--text)" text-anchor="end">${last.kg} kg</text>
          </svg>
        </div>
        <div class="legend" style="justify-content:space-between;margin-top:2px">
          <span class="sub">${fmtFullDate(first.date)}</span>
          <span class="sub">${ws.length} lần · ${diff > 0 ? '+' : ''}${diff} kg</span>
          <span class="sub">${fmtFullDate(last.date)}</span>
        </div>
        <div class="sub" style="text-align:center;margin-top:4px">👆 Chạm vào điểm để xem ngày & cân nặng</div>`;
    }

    // Card mục tiêu cân nặng
    const plan = Store.plan;
    let planCard;
    if (!plan) {
      planCard = `
        <div class="card">
          <div class="meal-head"><h2>🎯 Mục tiêu cân nặng</h2>
            <button class="btn small" id="btn-plan">Đặt mục tiêu</button></div>
          <div class="sub">Đặt cân nặng đích + ngày đạt — app tính lượng calo ăn mỗi ngày sao cho hiệu quả và an toàn.</div>
        </div>`;
    } else {
      const r = calcPlan(p, plan);
      const statusTag = {
        safe: '<span class="tag green">✓ An toàn</span>',
        hard: '<span class="tag orange">⚡ Khá gắt</span>',
        impossible: '<span class="tag" style="background:#fde8e8;color:var(--red)">⚠️ Không còn khả thi</span>',
        expired: '<span class="tag" style="background:var(--line);color:var(--text-2)">Hết hạn</span>',
      }[r.status];
      const done = plan.startKg - p.weightKg;
      const total = plan.startKg - plan.targetKg;
      const prog = total !== 0 ? Math.max(0, Math.min(1, done / total)) : 0;
      planCard = `
        <div class="card">
          <div class="meal-head"><h2>🎯 Mục tiêu: ${plan.targetKg} kg — ${fmtFullDate(plan.date)}</h2>${statusTag}</div>
          <div class="sub" style="margin-bottom:10px">${r.msg}</div>
          ${(r.status === 'safe' || r.status === 'hard') ? `
          <div class="stat-grid">
            <div class="stat-box"><div class="v" style="color:var(--green-dark)">${Math.max(1200, r.dailyKcal)}</div><div class="k">kcal nạp / ngày (đang áp dụng)</div></div>
            <div class="stat-box"><div class="v">${r.days}</div><div class="k">ngày còn lại</div></div>
          </div>
          ${plan.activityKcal ? (() => {
            let met7 = 0;
            for (let i = 0; i < 7; i++) {
              const sm = Store.daySummary(shiftDate(todayKey(), -i));
              if (Math.max(sm.kOut, stepsToKcal(sm.steps, p.weightKg)) >= plan.activityKcal) met7++;
            }
            return `<div class="sub" style="margin-top:10px">🏃 Cam kết tập: <b>${plan.activityKcal} kcal/ngày</b> (~${kcalToSteps(plan.activityKcal, p.weightKg).toLocaleString('vi-VN')} bước) · đạt <b>${met7}/7</b> ngày gần nhất</div>`;
          })() : ''}
          <div style="background:var(--bg);border-radius:999px;height:10px;margin-top:12px;overflow:hidden">
            <div style="background:var(--green);height:100%;width:${Math.round(prog * 100)}%"></div>
          </div>
          <div class="sub" style="margin-top:6px">${plan.startKg} kg → <b>${p.weightKg} kg</b> → ${plan.targetKg} kg · số kcal tự điều chỉnh khi bạn ghi cân nặng mới</div>
          ` : `<div class="sub">${r.suggestDate ? `Gợi ý: với tốc độ khả thi ~${r.suggestWeekly} kg/tuần, sớm nhất đạt ${plan.targetKg} kg vào <b>${fmtFullDate(r.suggestDate)}</b>. Hãy sửa lại mục tiêu.` : 'TDEE của bạn quá gần mức ăn tối thiểu — hãy tăng vận động thay vì siết ăn thêm.'}</div>`}
          <div class="btn-row" style="margin-top:12px">
            <button class="btn small secondary" id="btn-plan">✏️ Sửa</button>
            <button class="btn small danger" id="btn-plan-cancel">Hủy mục tiêu</button>
          </div>
        </div>`;
    }

    this.el.view.innerHTML = `
      ${planCard}
      <div class="card">
        <h2>7 ngày qua</h2>
        <svg class="bars" viewBox="0 0 ${W} ${H}">
          <line x1="${pad}" x2="${W - pad}" y1="${y(target)}" y2="${y(target)}" stroke="var(--green)" stroke-width="1.5" stroke-dasharray="5 4"/>
          <text x="${W - pad}" y="${y(target) - 5}" font-size="11" fill="var(--green-dark)" text-anchor="end">Mục tiêu ${target}</text>
          ${bars}
        </svg>
        <div class="legend">
          <span><span class="dot" style="background:var(--orange)"></span>Calo nạp</span>
          <span><span class="dot" style="background:var(--blue)"></span>Calo tập</span>
        </div>
      </div>

      <div class="card">
        <h2>Trung bình (ngày có ghi chép)</h2>
        <div class="stat-grid">
          <div class="stat-box"><div class="v" style="color:var(--orange)">${avgIn}</div><div class="k">kcal nạp / ngày</div></div>
          <div class="stat-box"><div class="v" style="color:var(--blue)">${totalOut}</div><div class="k">kcal tập / 7 ngày</div></div>
          <div class="stat-box"><div class="v">${avgNet}</div><div class="k">kcal ròng / ngày</div></div>
          <div class="stat-box"><div class="v" style="color:var(--green-dark)">${tdee}</div><div class="k">TDEE nền của bạn</div></div>
        </div>
        <div class="sub" style="margin-top:10px">Ăn ròng dưới TDEE ≈ giảm cân. Chênh 7.700 kcal ≈ 1 kg mỡ.</div>
      </div>

      <div class="card">
        <div class="meal-head"><h2>⚖️ Cân nặng</h2>
          <button class="btn small secondary" id="btn-weight">＋ Ghi hôm nay</button></div>
        ${weightChart}
      </div>`;

    document.getElementById('btn-plan').addEventListener('click', () => this.openGoalModal());
    const cancelBtn = document.getElementById('btn-plan-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
      if (confirm('Hủy mục tiêu cân nặng? Mục tiêu calo sẽ quay về theo hồ sơ.')) {
        Store.setPlan(null);
        this.toast('Đã hủy mục tiêu');
        this.render();
      }
    });

    document.getElementById('btn-weight').addEventListener('click', () => {
      this.modal(`
        <h3>Cân nặng hôm nay</h3>
        <div class="field"><label>Cân nặng (kg)</label>
          <input id="wt-kg" type="text" inputmode="decimal" value="${p.weightKg}"></div>
        <button class="btn" id="wt-save">Lưu</button>`);
      document.getElementById('wt-save').addEventListener('click', () => {
        const kg = parseNum(document.getElementById('wt-kg').value);
        if (!kg || kg < 25 || kg > 250) { this.toast('⚠️ Giá trị không hợp lệ'); return; }
        Store.addWeight(kg);
        this.closeModal();
        this.toast('✅ Đã ghi cân nặng');
        this.render();
      });
    });

    // Chạm điểm cân nặng -> hiện ngày + kg (thay hover, hợp điện thoại)
    const wtSvg = document.getElementById('wt-svg');
    if (wtSvg) {
      const tip = document.getElementById('wt-tip');
      const dots = wtSvg.querySelectorAll('[data-dot]');
      wtSvg.querySelectorAll('[data-wi]').forEach(c => {
        c.addEventListener('click', () => {
          tip.style.left = c.dataset.l + '%';
          tip.style.top = c.dataset.t + '%';
          tip.textContent = c.dataset.d + ' · ' + c.dataset.k + ' kg';
          tip.style.display = 'block';
          dots.forEach(d => d.setAttribute('r', d.dataset.dot === c.dataset.wi ? '5.5' : '3.5'));
        });
      });
    }
  },

  openGoalModal() {
    const p = Store.profile;
    const plan = Store.plan;
    const tomorrow = shiftDate(todayKey(), 1);
    this.modal(`
      <h3>🎯 Mục tiêu cân nặng</h3>
      <div class="m-sub">Hiện tại: <b>${p.weightKg} kg</b> · TDEE nền ${calcTDEE(p)} kcal/ngày</div>
      <div class="field-row">
        <div class="field"><label>Cân nặng đích (kg)</label>
          <input id="gp-kg" type="text" inputmode="decimal" value="${plan ? plan.targetKg : ''}" placeholder="vd: 68"></div>
        <div class="field"><label>Ngày muốn đạt</label>
          <input id="gp-date" type="date" min="${tomorrow}" value="${plan ? plan.date : ''}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Cam kết tập thêm (kcal/ngày)</label>
          <input id="gp-act" type="number" inputmode="numeric" value="${plan && plan.activityKcal ? plan.activityKcal : ''}" placeholder="0"></div>
        <div class="field"><label>≈ bước đi bộ / ngày</label>
          <input id="gp-steps" type="number" inputmode="numeric" value="${plan && plan.activityKcal ? kcalToSteps(plan.activityKcal, p.weightKg) : ''}" placeholder="vd: 10000"></div>
      </div>
      <div class="hint" style="margin:-6px 0 12px">Không bắt buộc. Cam kết vận động giúp mục tiêu gắt hơn trở nên khả thi — app sẽ nhắc mỗi ngày nếu bạn chưa tập đủ (đối chiếu bằng calo tập đã ghi / Strava). 2 ô tự quy đổi theo cân nặng của bạn.</div>
      <div id="gp-preview"></div>
      <button class="btn" id="gp-save" disabled>Lưu mục tiêu</button>`);

    const $ = id => document.getElementById(id);

    // đồng bộ 2 chiều kcal <-> bước
    $('gp-act').addEventListener('input', () => {
      const v = parseInt($('gp-act').value) || 0;
      $('gp-steps').value = v > 0 ? kcalToSteps(v, p.weightKg) : '';
      upd();
    });
    $('gp-steps').addEventListener('input', () => {
      const v = parseInt($('gp-steps').value) || 0;
      $('gp-act').value = v > 0 ? stepsToKcal(v, p.weightKg) : '';
      upd();
    });

    const upd = () => {
      const kg = parseNum($('gp-kg').value);
      const date = $('gp-date').value;
      const act = parseInt($('gp-act').value) || 0;
      const box = $('gp-preview'), btn = $('gp-save');
      if (!kg || kg < 30 || kg > 200 || !date) { box.innerHTML = ''; btn.disabled = true; return; }
      const r = calcPlan(p, { targetKg: kg, date, activityKcal: act });
      const ok = r.status === 'safe' || r.status === 'hard';
      btn.disabled = !ok;
      const style = {
        safe: 'background:var(--green-soft);color:var(--green-dark)',
        hard: 'background:var(--orange-soft);color:#9a3412',
        impossible: 'background:#fde8e8;color:var(--red)',
        expired: 'background:#fde8e8;color:var(--red)',
      }[r.status];
      box.innerHTML = `
        <div style="${style};border-radius:12px;padding:12px 14px;margin-bottom:14px;font-size:13.5px;line-height:1.5">
          <b>${r.status === 'impossible' ? '❌ Mục tiêu không phù hợp — không nên làm.' : r.status === 'expired' ? '❌ Ngày không hợp lệ.' : r.status === 'hard' ? '⚡ Làm được nhưng gắt.' : '✓ Mục tiêu an toàn.'}</b><br>
          ${r.msg}
          ${ok ? `<br>→ Ăn khoảng <b>${Math.max(1200, r.dailyKcal)} kcal/ngày</b> trong <b>${r.days} ngày</b>${r.needsActivity
              ? ` <b>+ BẮT BUỘC tập đủ ${act} kcal/ngày</b> (~${kcalToSteps(act, p.weightKg).toLocaleString('vi-VN')} bước) — ngày tập đủ được ăn ${Math.max(1200, r.dailyKcal) + act} kcal. App sẽ nhắc nếu thiếu.`
              : ' (chưa cộng calo tập — hôm nào tập sẽ được ăn thêm đúng phần đó).'}` : ''}
          ${!ok && r.suggestDate ? `<br>→ Gợi ý 1: giữ đích ${kg} kg thì chọn ngày từ <b>${fmtFullDate(r.suggestDate)}</b> trở đi (~${r.suggestWeekly} kg/tuần).` : ''}
          ${!ok && r.suggestActivity ? `<br>→ Gợi ý 2: GIỮ ngày này nhưng cam kết tập thêm ≥ <b>${r.suggestActivity} kcal/ngày</b> (~${kcalToSteps(r.suggestActivity, p.weightKg).toLocaleString('vi-VN')} bước đi bộ) — điền vào ô cam kết bên trên là mục tiêu hợp lệ.` : ''}
          ${!ok && !r.suggestDate && !r.suggestActivity ? `<br>→ Mục tiêu này quá sức kể cả khi tăng vận động — hãy chọn đích/ngày vừa sức hơn.` : ''}
        </div>`;
    };
    $('gp-kg').addEventListener('input', upd);
    $('gp-date').addEventListener('input', upd);
    upd();

    $('gp-save').addEventListener('click', () => {
      const kg = parseNum($('gp-kg').value);
      const date = $('gp-date').value;
      const act = parseInt($('gp-act').value) || 0;
      const r = calcPlan(p, { targetKg: kg, date, activityKcal: act });
      if (!r || !(r.status === 'safe' || r.status === 'hard')) return;
      Store.setPlan({ targetKg: kg, date, activityKcal: act, startKg: plan ? plan.startKg : p.weightKg, created: todayKey() });
      this.closeModal();
      this.toast(`🎯 Mục tiêu mới: ăn ~${Math.max(1200, r.dailyKcal)} kcal/ngày${act ? ` + tập ${act} kcal/ngày` : ''}`);
      this.render();
    });
  },

  // ========== CÀI ĐẶT ==========
  renderSettings() {
    document.getElementById('tabbar').style.display = '';
    const p = Store.profile;
    const st = Store.strava;
    const target = calcTarget(p);
    const mtSaved = p.macroTargets || {};
    const mtAuto = calcMacroTargets({ ...p, macroTargets: null }, target);

    const sync = typeof Sync !== 'undefined' ? Sync : null;
    const acct = !sync || !sync.isReady() ? `
      <div class="card">
        <h2>☁️ Tài khoản & đồng bộ</h2>
        <div class="sub">Đồng bộ chưa sẵn sàng (thư viện chưa tải). Kiểm tra kết nối rồi mở lại app.</div>
      </div>` : sync.isOn() ? `
      <div class="card">
        <h2>☁️ Tài khoản</h2>
        <div class="sub">Đã đăng nhập: <b>${esc(sync.email())}</b></div>
        <div class="sub" style="margin-top:4px">${sync.statusText()}</div>
        <button class="btn secondary" id="acct-signout" style="margin-top:10px">Đăng xuất</button>
      </div>` : `
      <div class="card">
        <h2>☁️ Tài khoản & đồng bộ</h2>
        <div class="sub" style="margin-bottom:10px">Đăng nhập để đồng bộ dữ liệu (món, món ghép, bữa ăn, cân nặng, steps, giấc ngủ) giữa các máy. Không đăng nhập vẫn dùng được — dữ liệu lưu trên máy này.</div>
        <div class="field"><label>Email</label><input id="acct-email" type="email" inputmode="email" autocapitalize="none" placeholder="ban@email.com"></div>
        <div class="field"><label>Mật khẩu</label><input id="acct-pass" type="password" placeholder="≥ 6 ký tự"></div>
        <div class="btn-row">
          <button class="btn" id="acct-signin">Đăng nhập</button>
          <button class="btn secondary" id="acct-signup">Đăng ký</button>
        </div>
        <div class="sub" id="acct-msg" style="margin-top:8px"></div>
      </div>`;

    this.el.view.innerHTML = `
      ${acct}
      <div class="card">
        <h2>👤 Hồ sơ</h2>
        <div class="field"><label>Giới tính</label>
          <div class="seg" id="st-gender">
            <button data-v="male" class="${p.gender === 'male' ? 'active' : ''}">Nam</button>
            <button data-v="female" class="${p.gender === 'female' ? 'active' : ''}">Nữ</button>
          </div></div>
        <div class="field-row">
          <div class="field"><label>Tuổi</label><input id="st-age" type="number" value="${p.age}"></div>
          <div class="field"><label>Cao (cm)</label><input id="st-height" type="number" value="${p.heightCm}"></div>
          <div class="field"><label>Nặng (kg)</label><input id="st-weight" type="text" inputmode="decimal" value="${p.weightKg}"></div>
        </div>
        <div class="field"><label>Mức vận động nền</label>
          <select id="st-activity">${ACTIVITY_LEVELS.map(a => `<option value="${a.id}" ${p.activity === a.id ? 'selected' : ''}>${a.label}</option>`).join('')}</select></div>
        <div class="field"><label>Mục tiêu</label>
          <select id="st-goal">${GOALS.map(g => `<option value="${g.id}" ${p.goal === g.id ? 'selected' : ''}>${g.label}</option>`).join('')}</select></div>
        <div class="field"><label>Tự đặt mục tiêu calo (bỏ trống = tự tính)</label>
          <input id="st-override" type="number" inputmode="numeric" value="${p.targetOverride || ''}" placeholder="Đang dùng: ${target} kcal">
          ${Store.plan ? '<div class="hint">⚠️ Đang có mục tiêu cân nặng (tab Thống kê) — mục tiêu đó được ưu tiên hơn ô này.</div>' : ''}</div>
        <button class="btn" id="st-save">Lưu hồ sơ</button>
      </div>

      <div class="card">
        <h2>🍽️ Mục tiêu macro / ngày</h2>
        <div class="sub" style="margin-bottom:10px">Đặt lượng đạm / tinh bột / béo mục tiêu mỗi ngày (hiển thị tiến độ ở tab Hôm nay). Để trống = tự tính theo mục tiêu calo (đạm 1.8g/kg cân nặng, béo 25% calo).</div>
        <div class="field-row">
          <div class="field"><label>Đạm (g)</label><input id="mt-p" type="number" inputmode="numeric" value="${mtSaved.protein || ''}" placeholder="${mtAuto.protein}"></div>
          <div class="field"><label>Tinh bột (g)</label><input id="mt-c" type="number" inputmode="numeric" value="${mtSaved.carbs || ''}" placeholder="${mtAuto.carbs}"></div>
          <div class="field"><label>Béo (g)</label><input id="mt-f" type="number" inputmode="numeric" value="${mtSaved.fat || ''}" placeholder="${mtAuto.fat}"></div>
        </div>
        <div class="hint" id="mt-hint" style="margin:-4px 0 12px"></div>
        <div class="btn-row">
          <button class="btn" id="mt-save">Lưu macro</button>
          <button class="btn secondary" id="mt-auto">↩️ Tự tính lại</button>
        </div>
      </div>

      <div class="card">
        <h2>🟠 Strava — Coros / Garmin</h2>
        <div class="sub" style="margin-bottom:12px">
          Đồng hồ Coros / Garmin tự động sync sang Strava. Kết nối Strava là app lấy
          được mọi buổi tập (kèm calo) từ cả 3 nguồn.
        </div>
        ${Strava.isConnected() ? `
          <div class="strava-badge" style="margin-bottom:10px">✓ Đã kết nối${st.athlete ? ' · ' + esc(st.athlete) : ''}</div>
          <button class="btn danger" id="sv-disconnect">Ngắt kết nối Strava</button>` : `
          <button class="btn" id="sv-connect" style="background:#fc4c02">Kết nối Strava</button>`}
        <div class="sub" style="margin-top:10px">🔒 Bấm nút sẽ mở Strava để bạn đăng nhập & cho phép. Không cần nhập mã gì cả.</div>
      </div>

      <div class="card">
        <h2>👟 Steps từ Apple Health</h2>
        <div class="sub" style="margin-bottom:10px">
          Cài 1 lần iOS Shortcut để tự đẩy số bước từ Health lên mỗi ngày (chạy ngầm).
          Dán <b>mã đồng bộ</b> này vào Shortcut:
        </div>
        <div class="field"><input id="sk-key" readonly value="${esc(Store.syncKey)}" style="font-family:monospace;font-size:13px"></div>
        <div class="btn-row">
          <button class="btn secondary" id="sk-copy">📋 Copy mã</button>
          <button class="btn secondary" id="sk-copyurl">📋 Copy link API</button>
        </div>
        <div class="sub" style="margin-top:10px">🔒 Ai có mã này đều ghi được số bước của bạn — giữ riêng tư. (Chỉ là số bước, không nhạy cảm.)</div>
      </div>

      <div class="card">
        <h2>🤖 AI phân tích ảnh</h2>
        <div class="sub" style="margin-bottom:10px">
          Chụp ảnh bữa ăn, AI ước tính calo & macro. Cần API key Anthropic.
        </div>
        <div class="field"><label>API key</label>
          <input id="ai-key" type="password" value="${esc(Store.ai.apiKey || '')}" placeholder="sk-ant-..."></div>
        <div class="field"><label>Model</label>
          <select id="ai-model">
            <option value="claude-haiku-4-5" ${(Store.ai.model || 'claude-haiku-4-5') === 'claude-haiku-4-5' ? 'selected' : ''}>Haiku — rẻ (~100đ/ảnh), đủ tốt</option>
            <option value="claude-opus-4-8" ${Store.ai.model === 'claude-opus-4-8' ? 'selected' : ''}>Opus — chính xác nhất (~500đ/ảnh)</option>
          </select></div>
        <button class="btn" id="ai-save">Lưu</button>
        <div class="sub" style="margin-top:10px">🔒 API key chỉ lưu trên máy bạn, chỉ gửi tới api.anthropic.com. Tạo key tại console.anthropic.com</div>
      </div>

      <div class="card">
        <h2>💾 Dữ liệu</h2>
        <div class="btn-row">
          <button class="btn secondary" id="btn-export">⬇️ Xuất file</button>
          <button class="btn secondary" id="btn-import">⬆️ Nhập file</button>
        </div>
        <input type="file" id="import-file" accept=".json" style="display:none">
        <div class="sub" style="margin-top:10px">Dữ liệu lưu trong trình duyệt của máy này. Xuất file để sao lưu hoặc chuyển máy.</div>
        <div class="divider"></div>
        <button class="btn danger" id="btn-reset">🗑️ Xóa toàn bộ dữ liệu</button>
      </div>

      <div class="sub" style="text-align:center;padding:8px 0 20px">Calo Việt · phiên bản ${APP_VERSION} · Made with ❤️</div>`;

    const $ = id => document.getElementById(id);

    // ----- Tài khoản / đồng bộ -----
    if ($('acct-signout')) $('acct-signout').addEventListener('click', async () => {
      await Sync.signOut();
      this.toast('Đã đăng xuất (dữ liệu vẫn còn trên máy)');
      this.render();
    });
    const doAuth = async (mode) => {
      const email = ($('acct-email').value || '').trim();
      const pass = $('acct-pass').value || '';
      const msg = $('acct-msg');
      if (!email || pass.length < 6) { msg.textContent = '⚠️ Nhập email và mật khẩu ≥ 6 ký tự'; msg.style.color = 'var(--orange)'; return;
      }
      msg.style.color = ''; msg.textContent = '⏳ Đang xử lý…';
      $('acct-signin').disabled = true; $('acct-signup').disabled = true;
      try {
        if (mode === 'up') await Sync.signUp(email, pass);
        else await Sync.signIn(email, pass);
        this.toast('✅ Đã đăng nhập — đang đồng bộ');
        this.render();
      } catch (e) {
        const m = (e && e.message) || 'Lỗi';
        msg.style.color = 'var(--orange)';
        msg.textContent = '⚠️ ' + (/Invalid login/i.test(m) ? 'Sai email hoặc mật khẩu' :
          /already registered/i.test(m) ? 'Email đã đăng ký — bấm Đăng nhập' : m);
        if ($('acct-signin')) { $('acct-signin').disabled = false; $('acct-signup').disabled = false; }
      }
    };
    if ($('acct-signin')) $('acct-signin').addEventListener('click', () => doAuth('in'));
    if ($('acct-signup')) $('acct-signup').addEventListener('click', () => doAuth('up'));

    const seg = $('st-gender');
    seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      seg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    }));

    $('st-save').addEventListener('click', () => {
      const np = {
        ...p,
        gender: seg.querySelector('.active').dataset.v,
        age: +$('st-age').value || p.age,
        heightCm: +$('st-height').value || p.heightCm,
        weightKg: parseNum($('st-weight').value) || p.weightKg,
        activity: $('st-activity').value,
        goal: $('st-goal').value,
        targetOverride: +$('st-override').value || null,
      };
      Store.profile = np;
      this.toast(`✅ Đã lưu. Mục tiêu: ${calcTarget(np)} kcal/ngày`);
      this.render();
    });

    // ----- Mục tiêu macro -----
    const mtHint = () => {
      const pv = +$('mt-p').value || mtAuto.protein;
      const cv = +$('mt-c').value || mtAuto.carbs;
      const fv = +$('mt-f').value || mtAuto.fat;
      const k = Math.round(pv * 4 + cv * 4 + fv * 9);
      const diff = k - target;
      $('mt-hint').innerHTML = `≈ <b>${k} kcal</b> từ macro · mục tiêu calo <b>${target}</b>${Math.abs(diff) > 50 ? ` (lệch ${diff > 0 ? '+' : ''}${diff})` : ' ✓'}`;
    };
    ['mt-p', 'mt-c', 'mt-f'].forEach(id => $(id).addEventListener('input', mtHint));
    mtHint();
    $('mt-save').addEventListener('click', () => {
      const pv = +$('mt-p').value || 0, cv = +$('mt-c').value || 0, fv = +$('mt-f').value || 0;
      const np = { ...p, macroTargets: (pv || cv || fv) ? { protein: pv, carbs: cv, fat: fv } : null };
      Store.profile = np;
      this.toast(np.macroTargets ? '✅ Đã lưu mục tiêu macro' : '↩️ Macro để tự tính');
      this.render();
    });
    $('mt-auto').addEventListener('click', () => {
      Store.profile = { ...p, macroTargets: null };
      this.toast('↩️ Đã đặt macro tự tính theo calo');
      this.render();
    });

    if ($('sv-connect')) $('sv-connect').addEventListener('click', () => this.connectStrava());

    if ($('sv-disconnect')) $('sv-disconnect').addEventListener('click', () => {
      Strava.disconnect();
      this.toast('Đã ngắt kết nối Strava');
      this.render();
    });

    const copyText = async (text, label) => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
        else { const t = $('sk-key'); t.focus(); t.select(); document.execCommand('copy'); }
        this.toast('✅ Đã copy ' + label);
      } catch { this.toast('⚠️ Không copy được — chạm giữ để copy thủ công'); }
    };
    if ($('sk-copy')) $('sk-copy').addEventListener('click', () => copyText(Store.syncKey, 'mã'));
    if ($('sk-copyurl')) $('sk-copyurl').addEventListener('click', () => copyText(location.origin + '/api/steps', 'link API'));

    $('ai-save').addEventListener('click', () => {
      Store.setAI({ apiKey: $('ai-key').value.trim(), model: $('ai-model').value });
      this.toast('✅ Đã lưu cấu hình AI');
    });

    $('btn-export').addEventListener('click', () => {
      const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `caloviet-backup-${todayKey()}.json`;
      a.click();
    });

    $('btn-import').addEventListener('click', () => $('import-file').click());
    $('import-file').addEventListener('change', async e => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        Store.importJSON(await f.text());
        this.toast('✅ Đã nhập dữ liệu');
        this.render();
      } catch { this.toast('⚠️ File không hợp lệ'); }
    });

    $('btn-reset').addEventListener('click', () => {
      if (confirm('Xóa TOÀN BỘ dữ liệu (món ăn, buổi tập, hồ sơ)? Không thể hoàn tác.')) {
        Store.reset();
        location.reload();
      }
    });
  },

  // ========== Tiện ích ==========
  modal(html) {
    this.el.modalRoot.innerHTML = `<div class="modal-back"><div class="modal">${html}</div></div>`;
    this.el.modalRoot.querySelector('.modal-back').addEventListener('click', e => {
      if (e.target.classList.contains('modal-back')) this.closeModal();
    });
  },
  closeModal() {
    // Hook dọn dẹp (vd: tắt camera scanner) trước khi xóa DOM
    if (typeof this._onModalClose === 'function') {
      const fn = this._onModalClose;
      this._onModalClose = null;
      fn();
    }
    this.el.modalRoot.innerHTML = '';
  },

  toast(msg) {
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('show'), 2400);
  },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Đoán bữa theo giờ hiện tại
function guessMeal() {
  const h = new Date().getHours();
  if (h < 10) return 'breakfast';
  if (h < 14) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
}

App.init();
