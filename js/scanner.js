// ===== Quét mã vạch/QR thức ăn đóng gói =====
'use strict';

const Scanner = {
  reader: null,

  open() {
    App.modal(`
      <h3>📷 Quét mã vạch</h3>
      <div class="scanner-video-wrap">
        <video id="sc-video" playsinline muted autoplay></video>
        <div class="scanner-frame"></div>
      </div>
      <div class="sub" id="sc-status" style="text-align:center;margin:10px 0">Đang bật camera...</div>
      <div class="field" style="margin-top:14px">
        <label>Hoặc nhập mã vạch bằng tay</label>
        <div class="scanner-manual">
          <input id="sc-code" type="text" inputmode="numeric" placeholder="vd: 8934563138165">
          <button class="btn secondary" id="sc-lookup" style="width:auto;white-space:nowrap">Tra cứu</button>
        </div>
        <div class="hint">Nhập dãy số dưới mã vạch nếu camera không đọc được.</div>
      </div>`);

    const $ = id => document.getElementById(id);
    const videoEl = $('sc-video');

    $('sc-lookup').addEventListener('click', () => {
      const code = $('sc-code').value.trim();
      if (code) this.handleCode(code);
    });
    $('sc-code').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const code = $('sc-code').value.trim();
        if (code) this.handleCode(code);
      }
    });

    // Không có thư viện / trình duyệt không hỗ trợ camera -> chỉ dùng nhập tay
    if (typeof ZXing === 'undefined' || !navigator.mediaDevices) {
      this.setStatus('Không bật được camera trên thiết bị này — hãy nhập mã vạch bằng tay bên dưới.');
      return;
    }

    this.reader = new ZXing.BrowserMultiFormatReader();
    // Dọn camera khi đóng modal (backdrop-click cũng gọi hook này)
    App._onModalClose = () => this.stop();

    // Ưu tiên camera sau; nếu constraint không được hỗ trợ, fallback về mặc định
    const start = (constraints) => {
      this.reader.decodeFromConstraints(constraints, videoEl, (result, err) => {
        if (result) {
          this.stop();
          this.handleCode(result.getText());
        }
        // err mỗi frame không đọc được là bình thường — bỏ qua
      }).then(() => {
        this.setStatus('Đưa mã vạch (dãy số kẻ sọc) vào khung...');
      }).catch(e => this.onCameraError(e, constraints));
    };

    start({ video: { facingMode: { ideal: 'environment' } } });
  },

  onCameraError(e, triedConstraints) {
    // Nếu lỗi do constraint facingMode -> thử lại với camera mặc định
    if (triedConstraints && triedConstraints.video && triedConstraints.video.facingMode) {
      this.reader.decodeFromConstraints({ video: true }, document.getElementById('sc-video'), (result) => {
        if (result) { this.stop(); this.handleCode(result.getText()); }
      }).then(() => {
        this.setStatus('Đưa mã vạch (dãy số kẻ sọc) vào khung...');
      }).catch(err => this.showCameraDenied(err));
      return;
    }
    this.showCameraDenied(e);
  },

  showCameraDenied(e) {
    const name = e && e.name;
    let msg;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      msg = 'Bạn chưa cho phép dùng camera. Hãy nhập mã vạch bằng tay bên dưới.';
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      msg = 'Không tìm thấy camera trên thiết bị. Hãy nhập mã vạch bằng tay bên dưới.';
    } else if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      msg = 'Camera chỉ chạy trên HTTPS. Bạn vẫn có thể nhập mã vạch bằng tay bên dưới.';
    } else {
      msg = 'Không bật được camera. Hãy nhập mã vạch bằng tay bên dưới.';
    }
    this.setStatus(msg);
  },

  stop() {
    if (this.reader) {
      try { this.reader.reset(); } catch { /* an toàn */ }
      this.reader = null;
    }
  },

  setStatus(text) {
    const el = document.getElementById('sc-status');
    if (el) el.textContent = text;
  },

  async handleCode(code) {
    code = String(code).trim();
    if (!code) return;

    // QR chứa link -> không có dữ liệu dinh dưỡng
    if (/^https?:\/\//i.test(code)) {
      this.setStatus('QR này chỉ chứa đường link, không có dữ liệu dinh dưỡng — hãy quét mã vạch (dãy số kẻ sọc) trên bao bì.');
      const codeInput = document.getElementById('sc-code');
      if (codeInput) codeInput.value = '';
      return;
    }

    // Có sẵn trong máy?
    const local = Store.allFoods().find(f => f.barcode === code);
    if (local) {
      this.stop();
      App.closeModal();
      App.openPortionModal(local);
      return;
    }

    // Tra Open Food Facts
    this.setStatus('Đang tra cứu mã ' + code + '...');
    let data;
    try {
      const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,product_name_vi,brands,nutriments,quantity`);
      data = await res.json();
    } catch {
      // Lỗi mạng / offline
      this.stop();
      this.openManualEntry(code, 'network');
      return;
    }

    const n = data && data.product && data.product.nutriments;
    if (data && data.status === 1 && n && (n['energy-kcal_100g'] != null)) {
      const p = data.product;
      const round1 = v => Math.round((v || 0) * 10) / 10;
      let name = p.product_name_vi || p.product_name || 'Sản phẩm ' + code;
      // chỉ thêm thương hiệu khi tên chưa chứa nó (tránh "coca-cola — Coca-Cola")
      const brand = p.brands ? String(p.brands).split(',')[0].trim() : '';
      if (brand && !stripVN(name).includes(stripVN(brand))) name += ' — ' + brand;
      if (name.length > 50) name = name.slice(0, 50).trim();

      const saved = Store.addCustomFood({
        name,
        portion: '100g',
        kcal: Math.round(n['energy-kcal_100g']),
        protein: round1(n.proteins_100g),
        carbs: round1(n.carbohydrates_100g),
        fat: round1(n.fat_100g),
        cat: 'snack',
        barcode: code,
      });
      this.stop();
      App.closeModal();
      App.openPortionModal(saved);
      App.toast('✅ Tìm thấy: ' + saved.name);
      return;
    }

    // Không có trong database (hoặc thiếu kcal)
    this.stop();
    this.openManualEntry(code, 'notfound');
  },

  // Form nhập tay khi không tra được — lưu kèm barcode để lần sau ra ngay
  openManualEntry(code, reason) {
    const note = reason === 'network'
      ? '⚠️ Không kết nối được để tra cứu (có thể đang offline). Bạn có thể nhập từ bao bì:'
      : 'Không tìm thấy mã ' + esc(code) + ' trong cơ sở dữ liệu. Bạn nhập từ bao bì nhé:';

    App.modal(`
      <h3>Nhập dinh dưỡng từ bao bì</h3>
      <div class="m-sub">${note}</div>
      <div class="field"><label>Tên món *</label><input id="mb-name" placeholder="vd: Sữa tươi TH true MILK"></div>
      <div class="field"><label>Calo / 100g (kcal) *</label><input id="mb-kcal" type="number" inputmode="numeric" placeholder="vd: 65"></div>
      <div class="field-row">
        <div class="field"><label>Đạm / 100g</label><input id="mb-p" type="number" inputmode="decimal" placeholder="0"></div>
        <div class="field"><label>Tinh bột / 100g</label><input id="mb-c" type="number" inputmode="decimal" placeholder="0"></div>
        <div class="field"><label>Béo / 100g</label><input id="mb-f" type="number" inputmode="decimal" placeholder="0"></div>
      </div>
      <div class="hint" style="margin-bottom:12px">Chỉ cần nhập 1 lần — lần sau quét mã này là ra ngay.</div>
      <button class="btn" id="mb-save">Lưu món</button>`);

    document.getElementById('mb-save').addEventListener('click', () => {
      const name = document.getElementById('mb-name').value.trim();
      const kcal = +document.getElementById('mb-kcal').value;
      if (!name || !kcal) { App.toast('⚠️ Cần nhập tên món và calo/100g'); return; }
      const saved = Store.addCustomFood({
        name,
        portion: '100g',
        kcal,
        protein: +document.getElementById('mb-p').value || 0,
        carbs: +document.getElementById('mb-c').value || 0,
        fat: +document.getElementById('mb-f').value || 0,
        cat: 'snack',
        barcode: code,
      });
      App.closeModal();
      App.openPortionModal(saved);
    });
  },
};
