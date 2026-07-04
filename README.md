# 🔥 Calo Việt — App theo dõi Calo In / Calo Out

PWA (Progressive Web App) theo dõi calo nạp vào − tiêu hao hằng ngày, tối ưu cho
món ăn Việt Nam và đồng bộ workout từ **Coros / Garmin / Strava**.

Chạy hoàn toàn trên trình duyệt — **không cần server, không cần tài khoản**,
dữ liệu lưu ngay trên máy của bạn.

## Tính năng

- 📊 **Dashboard hằng ngày**: vòng calo còn lại, đã nạp, calo tập, macro (đạm / tinh bột / béo)
- 🍜 **135+ món ăn Việt Nam** có sẵn calo + macro theo khẩu phần phổ biến (phở, bún bò, cơm tấm, bánh mì, trà sữa...) — tìm kiếm không cần gõ dấu (`pho bo` → Phở bò)
- ⭐ **Tạo món riêng** và lưu để dùng lại
- 🏃 **Ghi buổi tập thủ công** — calo tự ước tính theo môn (MET) × cân nặng × thời gian
- 🟠 **Đồng bộ Strava** — lấy toàn bộ workout kèm calo. Đồng hồ **Coros / Garmin tự sync sang Strava**, nên kết nối Strava = lấy được dữ liệu từ cả 3
- 🎯 **Tính mục tiêu calo tự động** (BMR Mifflin-St Jeor → TDEE → mục tiêu theo giảm/giữ/tăng cân)
- 📈 **Thống kê 7 ngày** + theo dõi cân nặng
- 💾 Xuất / nhập file sao lưu JSON
- 📱 Cài lên màn hình chính iPhone như app thật, chạy offline

## Chạy thử trên máy tính

```
npx -y http-server -p 3456 -c-1 .
```
Mở http://localhost:3456

## Đưa lên iPhone (2 cách)

Muốn dùng trên iPhone, app cần được đưa lên một địa chỉ **https**. Chọn 1 trong 2:

### Cách 1 — Netlify Drop (dễ nhất, miễn phí, ~1 phút)
1. Mở https://app.netlify.com/drop
2. Kéo-thả **cả thư mục này** vào trang
3. Nhận link dạng `https://ten-gi-do.netlify.app`

### Cách 2 — GitHub Pages
1. Tạo repo, push toàn bộ thư mục lên
2. Settings → Pages → Deploy from branch `main`
3. Nhận link `https://<user>.github.io/<repo>`

### Cài lên iPhone 15
1. Mở link trên bằng **Safari**
2. Bấm nút **Chia sẻ** (ô vuông mũi tên) → **Thêm vào MH chính** (Add to Home Screen)
3. App xuất hiện với icon 🔥, mở full màn hình như app thật

> ⚠️ Dữ liệu lưu theo từng thiết bị/trình duyệt. Dùng **Cài đặt → Xuất file** để sao lưu.

## Kết nối Strava (lấy dữ liệu Coros / Garmin)

**Bước 0 — nối đồng hồ vào Strava (nếu chưa):**
- Coros: app Coros → Profile → Settings → 3rd Party Apps → Strava
- Garmin: app Garmin Connect → Cài đặt → Ứng dụng được kết nối → Strava

**Bước 1 — tạo API app cá nhân trên Strava (1 lần, ~2 phút):**
1. Đăng nhập https://www.strava.com/settings/api
2. Điền form tạo app:
   - **Website**: địa chỉ app của bạn (vd `https://ten-gi-do.netlify.app`)
   - **Authorization Callback Domain**: chỉ tên miền, KHÔNG có `https://` (vd `ten-gi-do.netlify.app`)
   - Các mục khác điền tùy ý
3. Copy **Client ID** và **Client Secret**

**Bước 2 — trong app:** Cài đặt → mục Strava API → dán Client ID + Secret →
**Lưu & Kết nối Strava** → cấp quyền → xong.

**Bước 3:** Tab Tập luyện → **🔄 Đồng bộ**. Mỗi buổi tập sẽ được thêm đúng ngày,
kèm calo do đồng hồ đo (chính xác hơn ước tính).

> 🔒 Client ID/Secret và token chỉ lưu trong localStorage trên máy bạn,
> chỉ gửi tới `strava.com` khi xác thực/đồng bộ.

## Ghi chú về độ chính xác

- Calo món ăn là **ước tính theo khẩu phần quán phổ biến** — sai số ±15% là bình thường. Quan trọng là ghi **đều đặn** để thấy xu hướng.
- Mức vận động trong hồ sơ là mức **nền (không tính buổi tập)** — buổi tập được cộng riêng, tránh tính trùng.
- Quy tắc tham khảo: thâm hụt ~7.700 kcal ≈ giảm 1 kg mỡ.

## Cấu trúc mã nguồn

```
index.html            — khung app (5 tab)
css/style.css         — giao diện mobile-first
js/foods.js           — database 135+ món ăn VN
js/calc.js            — BMR/TDEE/MET, ngày tháng
js/store.js           — lưu trữ localStorage
js/strava.js          — OAuth + đồng bộ Strava
js/app.js             — UI logic (5 màn hình, modal, chart SVG)
manifest.webmanifest  — cấu hình PWA
sw.js                 — service worker (offline)
icons/                — icon app
```
