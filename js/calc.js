// ===== Tính toán dinh dưỡng & năng lượng =====

// BMR theo công thức Mifflin-St Jeor
function calcBMR(gender, age, heightCm, weightKg) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return Math.round(gender === 'male' ? base + 5 : base - 161);
}

// Hệ số vận động NỀN (không tính buổi tập — app sẽ cộng calo workout riêng
// để tránh tính trùng)
const ACTIVITY_LEVELS = [
  { id: 'sedentary', label: 'Ít vận động (ngồi nhiều, văn phòng)', factor: 1.2 },
  { id: 'light',     label: 'Vận động nhẹ (đi lại thường xuyên)', factor: 1.375 },
  { id: 'moderate',  label: 'Vận động vừa (công việc chân tay)', factor: 1.55 },
];

// Mục tiêu
const GOALS = [
  { id: 'lose1',    label: 'Giảm cân nhanh (~0.5 kg/tuần)', delta: -500 },
  { id: 'lose05',   label: 'Giảm cân từ từ (~0.25 kg/tuần)', delta: -250 },
  { id: 'maintain', label: 'Giữ cân', delta: 0 },
  { id: 'gain05',   label: 'Tăng cân từ từ (~0.25 kg/tuần)', delta: 250 },
  { id: 'gain1',    label: 'Tăng cân nhanh (~0.5 kg/tuần)', delta: 500 },
];

function calcTDEE(profile) {
  const bmr = calcBMR(profile.gender, profile.age, profile.heightCm, profile.weightKg);
  const act = ACTIVITY_LEVELS.find(a => a.id === profile.activity) || ACTIVITY_LEVELS[0];
  return Math.round(bmr * act.factor);
}

// Mục tiêu calo nạp mỗi ngày (chưa cộng workout)
// Ưu tiên: kế hoạch cân nặng đang bật > mục tiêu tự đặt > tự tính theo goal
function calcTarget(profile) {
  const plan = (typeof Store !== 'undefined') ? Store.load().plan : null;
  if (plan) {
    const r = calcPlan(profile, plan);
    // Khi có cam kết tập, phần ăn cơ bản có thể dưới floor (calo tập sẽ bù vào phần được ăn)
    if (r && (r.status === 'safe' || r.status === 'hard')) return Math.max(HARD_FOOD_MIN, r.dailyKcal);
  }
  if (profile.targetOverride) return profile.targetOverride;
  const goal = GOALS.find(g => g.id === profile.goal) || GOALS[2];
  return Math.max(1200, calcTDEE(profile) + goal.delta);
}

// ===== Kế hoạch cân nặng theo ngày đích =====
// 1 kg mỡ ≈ 7.700 kcal. Ngưỡng an toàn: giảm ≤ 0.5 kg/tuần (tối đa 1),
// tăng ≤ 0.5 kg/tuần (tối đa 0.75), calo nạp không dưới 1500 (nam) / 1200 (nữ).
const KCAL_PER_KG = 7700;
const SAFE_WEEKLY = 0.5;
const MAX_WEEKLY_LOSS = 1.0;
const MAX_WEEKLY_GAIN = 0.75;
const HARD_FOOD_MIN = 1200; // phần ăn tối thiểu tuyệt đối, kể cả khi có tập

function intakeFloor(profile) { return profile.gender === 'male' ? 1500 : 1200; }

// Quy đổi bước đi bộ <-> kcal (phụ thuộc cân nặng): ~0.036 kcal/bước với 72kg
const KCAL_PER_STEP_PER_KG = 0.0005;
function stepsToKcal(steps, weightKg) { return Math.round(steps * KCAL_PER_STEP_PER_KG * weightKg); }
function kcalToSteps(kcal, weightKg) {
  if (!kcal || kcal <= 0) return 0;
  return Math.round(kcal / (KCAL_PER_STEP_PER_KG * weightKg) / 100) * 100;
}

// Tính lại MỖI NGÀY từ cân nặng hiện tại -> kế hoạch tự thích nghi khi bạn ghi cân
function calcPlan(profile, plan) {
  if (!plan || !plan.targetKg || !plan.date) return null;
  const days = Math.round((new Date(plan.date) - new Date(todayKey())) / 86400000);
  const deltaKg = +(profile.weightKg - plan.targetKg).toFixed(2); // >0: cần giảm
  const act = Math.max(0, plan.activityKcal || 0); // cam kết tập thêm mỗi ngày
  const tdee = calcTDEE(profile);
  const floor = intakeFloor(profile);
  const r = { days, deltaKg, tdee, floor, activityKcal: act };

  // Ngày sớm nhất khả thi — xét CẢ HAI ràng buộc:
  // (1) tốc độ an toàn 0.5 kg/tuần, (2) không ăn dưới mức tối thiểu (floor).
  // Cam kết tập thêm nới ràng buộc (2): năng lượng ra = TDEE + act.
  let dailyCap = SAFE_WEEKLY * KCAL_PER_KG / 7; // ≈550 kcal/ngày
  if (deltaKg > 0) dailyCap = Math.min(dailyCap, tdee + act - floor);
  if (dailyCap >= 50) {
    const daysNeeded = Math.ceil(Math.abs(deltaKg) * KCAL_PER_KG / dailyCap);
    const sd = new Date();
    sd.setDate(sd.getDate() + Math.max(7, daysNeeded));
    r.suggestDate = dateKey(sd);
    r.suggestWeekly = +(dailyCap * 7 / KCAL_PER_KG).toFixed(2);
  } else {
    // TDEE + cam kết quá gần mức ăn tối thiểu — không giảm được bằng ăn kiêng đơn thuần
    r.suggestDate = null;
  }

  if (days <= 0) return { ...r, status: 'expired', msg: 'Đã tới/qua ngày mục tiêu. Hãy đặt mục tiêu mới.' };

  r.weekly = +(deltaKg / (days / 7)).toFixed(2);
  // Phần ăn cơ bản mỗi ngày (KHÔNG tính calo tập — calo tập cộng vào phần được ăn như bình thường)
  r.dailyKcal = Math.round(tdee - deltaKg * KCAL_PER_KG / days);

  if (Math.abs(deltaKg) < 0.1) {
    return { ...r, status: 'safe', msg: 'Bạn đang ở ngay mục tiêu — ăn quanh TDEE để duy trì.' };
  }

  if (deltaKg > 0) { // cần giảm
    if (r.weekly > MAX_WEEKLY_LOSS)
      return { ...r, status: 'impossible', msg: `Cần giảm ${r.weekly} kg/tuần — vượt mức an toàn cho sức khỏe (tối đa 1 kg/tuần), kể cả khi tập thêm.` };

    const eatWithAct = r.dailyKcal + act; // phần ăn thực tế ngày tập đủ cam kết
    if (r.dailyKcal < HARD_FOOD_MIN)
      return { ...r, status: 'impossible', msg: `Phần ăn cơ bản chỉ ${r.dailyKcal} kcal/ngày — quá thấp kể cả khi có tập (tối thiểu tuyệt đối ${HARD_FOOD_MIN} kcal).` };
    if (eatWithAct < floor) {
      // gợi ý mức cam kết đủ để mục tiêu này khả thi (nếu hợp lý)
      const needed = Math.ceil((floor - r.dailyKcal) / 50) * 50;
      if (needed <= 700) r.suggestActivity = needed;
      return {
        ...r, status: 'impossible',
        msg: act > 0
          ? `Kể cả tập thêm ${act} kcal/ngày, phần được ăn ngày tập chỉ ${eatWithAct} kcal — vẫn dưới mức tối thiểu ${floor} kcal.`
          : `Phải ăn chỉ ${r.dailyKcal} kcal/ngày — dưới mức tối thiểu an toàn ${floor} kcal (thiếu chất, mất cơ, hại chuyển hóa).`,
      };
    }

    // khả thi — có thể là NHỜ cam kết tập (bắt buộc tập đủ mỗi ngày)
    r.needsActivity = act > 0 && r.dailyKcal < floor;
    const cond = r.needsActivity ? ` — với điều kiện tập đủ ${act} kcal/ngày` : '';
    if (r.weekly > SAFE_WEEKLY)
      return { ...r, status: 'hard', msg: `Giảm ${r.weekly} kg/tuần: khả thi nhưng khá gắt${cond}.` };
    return { ...r, status: 'safe', msg: `Giảm ${r.weekly} kg/tuần — trong ngưỡng an toàn${cond}.` };
  }

  // cần tăng
  const wg = -r.weekly;
  if (wg > MAX_WEEKLY_GAIN)
    return { ...r, status: 'impossible', msg: `Cần tăng ${wg} kg/tuần — quá nhanh, phần lớn sẽ là mỡ (tối đa ~0.75 kg/tuần).` };
  if (wg > 0.5)
    return { ...r, status: 'hard', msg: `Tăng ${wg} kg/tuần: nhanh — một phần sẽ là mỡ, nên kết hợp tập tạ.` };
  return { ...r, status: 'safe', msg: `Tăng ${wg} kg/tuần — hợp lý.` };
}

function fmtFullDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return `${d}/${m}/${y}`;
}

// ===== Workout: ước tính calo theo MET =====
// kcal = MET × cân nặng (kg) × thời gian (giờ)
const WORKOUT_TYPES = [
  { id: 'run',       name: 'Chạy bộ',        icon: '🏃', met: 9.8 },
  { id: 'walk',      name: 'Đi bộ',          icon: '🚶', met: 3.8 },
  { id: 'ride',      name: 'Đạp xe',         icon: '🚴', met: 7.5 },
  { id: 'swim',      name: 'Bơi lội',        icon: '🏊', met: 8.0 },
  { id: 'gym',       name: 'Tập tạ / Gym',   icon: '🏋️', met: 5.0 },
  { id: 'hiit',      name: 'HIIT / Cardio',  icon: '🔥', met: 10.0 },
  { id: 'yoga',      name: 'Yoga',           icon: '🧘', met: 3.0 },
  { id: 'soccer',    name: 'Đá bóng',        icon: '⚽', met: 8.0 },
  { id: 'badminton', name: 'Cầu lông',       icon: '🏸', met: 5.5 },
  { id: 'tennis',    name: 'Tennis',         icon: '🎾', met: 7.3 },
  { id: 'pickle',    name: 'Pickleball',     icon: '🥒', met: 5.0 },
  { id: 'jumprope',  name: 'Nhảy dây',       icon: '🪢', met: 11.0 },
  { id: 'hike',      name: 'Leo núi / Trek', icon: '🥾', met: 6.5 },
  { id: 'other',     name: 'Khác',           icon: '💪', met: 5.0 },
];

function estimateWorkoutKcal(typeId, minutes, weightKg) {
  const t = WORKOUT_TYPES.find(w => w.id === typeId) || WORKOUT_TYPES[WORKOUT_TYPES.length - 1];
  return Math.round(t.met * weightKg * (minutes / 60));
}

// Map loại hoạt động Strava -> loại trong app
const STRAVA_TYPE_MAP = {
  Run: 'run', TrailRun: 'run', VirtualRun: 'run',
  Walk: 'walk', Hike: 'hike',
  Ride: 'ride', VirtualRide: 'ride', MountainBikeRide: 'ride', GravelRide: 'ride', EBikeRide: 'ride',
  Swim: 'swim',
  WeightTraining: 'gym', Workout: 'gym', Crossfit: 'hiit', HighIntensityIntervalTraining: 'hiit',
  Yoga: 'yoga', Pilates: 'yoga',
  Soccer: 'soccer', Badminton: 'badminton', Tennis: 'tennis', Pickleball: 'pickle',
  RockClimbing: 'hike', Snowboard: 'other', AlpineSki: 'other',
};

const STRAVA_TYPE_VN = {
  Run: 'Chạy bộ', TrailRun: 'Chạy trail', VirtualRun: 'Chạy máy',
  Walk: 'Đi bộ', Hike: 'Leo núi',
  Ride: 'Đạp xe', VirtualRide: 'Đạp xe ảo', MountainBikeRide: 'Đạp xe địa hình', GravelRide: 'Đạp xe gravel', EBikeRide: 'Xe đạp điện',
  Swim: 'Bơi lội', WeightTraining: 'Tập tạ', Workout: 'Tập luyện',
  Crossfit: 'CrossFit', HighIntensityIntervalTraining: 'HIIT',
  Yoga: 'Yoga', Pilates: 'Pilates', Soccer: 'Đá bóng',
  Badminton: 'Cầu lông', Tennis: 'Tennis', Pickleball: 'Pickleball',
};

// ===== Ngày tháng =====
function dateKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function todayKey() { return dateKey(new Date()); }
function fmtDateVN(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const days = ['CN', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
  if (key === todayKey()) return 'Hôm nay';
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  if (key === dateKey(yest)) return 'Hôm qua';
  return `${days[dt.getDay()]}, ${d}/${m}`;
}
function shiftDate(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return dateKey(dt);
}
