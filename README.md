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

> ⚠️ GitHub Pages **không chạy được serverless function** → nút "Kết nối Strava"
> một chạm sẽ không hoạt động. Muốn dùng Strava, hãy deploy bằng **Netlify**
> (Cách 1) để có function OAuth. Các tính năng còn lại vẫn chạy bình thường.

### Cài lên iPhone 15
1. Mở link trên bằng **Safari**
2. Bấm nút **Chia sẻ** (ô vuông mũi tên) → **Thêm vào MH chính** (Add to Home Screen)
3. App xuất hiện với icon 🔥, mở full màn hình như app thật

> ⚠️ Dữ liệu lưu theo từng thiết bị/trình duyệt. Dùng **Cài đặt → Xuất file** để sao lưu.

## Kết nối Strava (lấy dữ liệu Coros / Garmin)

App dùng **một Strava app dùng chung** + **Netlify Function** giữ Client Secret trên
server. Người dùng cuối chỉ bấm **1 nút "Kết nối Strava"** — không phải nhập mã gì.

### Người deploy cài đặt (1 lần)

**Bước 1 — tạo Strava app dùng chung** tại https://www.strava.com/settings/api:
- **Website**: địa chỉ app (vd `https://ten-gi-do.netlify.app`)
- **Authorization Callback Domain**: chỉ tên miền, KHÔNG có `https://` (vd `ten-gi-do.netlify.app`)
- Copy **Client ID** và **Client Secret**

**Bước 2 — khai báo biến môi trường trên Netlify:**
Site settings → Environment variables → thêm:
- `STRAVA_CLIENT_ID` = Client ID
- `STRAVA_CLIENT_SECRET` = Client Secret  🔒 (chỉ nằm trên server, không lộ ra trình duyệt)

Sau đó **Deploy lại** site để function nhận biến mới. Function nằm ở
`netlify/functions/strava-token.js`, cấu hình trong `netlify.toml`.

### Người dùng cuối

**Bước 0 — nối đồng hồ vào Strava (nếu chưa):**
- Coros: app Coros → Profile → Settings → 3rd Party Apps → Strava
- Garmin: app Garmin Connect → Cài đặt → Ứng dụng được kết nối → Strava

**Bước 1:** Cài đặt (hoặc tab Tập luyện) → **Kết nối Strava** → đăng nhập & cấp quyền → xong.

**Bước 2:** Tab Tập luyện → **🔄 Đồng bộ**. Mỗi buổi tập được thêm đúng ngày,
kèm calo do đồng hồ đo (chính xác hơn ước tính).

> 🔒 Client Secret **chỉ nằm trong biến môi trường Netlify**, không bao giờ gửi xuống
> trình duyệt. Access/refresh token của người dùng lưu trong localStorage trên máy họ.

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
js/strava.js          — OAuth (qua function) + đồng bộ Strava
js/app.js             — UI logic (5 màn hình, modal, chart SVG)
netlify/functions/strava-token.js — serverless: đổi token OAuth, giữ Secret
netlify.toml          — cấu hình publish + functions + redirect /api
manifest.webmanifest  — cấu hình PWA
sw.js                 — service worker (offline)
icons/                — icon app
```
