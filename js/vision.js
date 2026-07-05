// ===== AI phân tích ảnh món ăn → ước tính calo (Anthropic) =====
'use strict';

const Vision = {
  // Schema structured output — bắt buộc additionalProperties:false + required đầy đủ
  SCHEMA: {
    type: 'object',
    properties: {
      dishes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Tên món tiếng Việt ngắn gọn' },
            portion: { type: 'string', description: 'Khẩu phần nhìn thấy, vd "1 tô vừa", "1 dĩa ~300g"' },
            kcal: { type: 'integer' },
            protein: { type: 'number' },
            carbs: { type: 'number' },
            fat: { type: 'number' },
            confidence: { type: 'string', enum: ['cao', 'vừa', 'thấp'] },
          },
          required: ['name', 'portion', 'kcal', 'protein', 'carbs', 'fat', 'confidence'],
          additionalProperties: false,
        },
      },
      notes: { type: 'string', description: 'Giả định quan trọng (dầu mỡ, đường ẩn...) — 1 câu tiếng Việt, rỗng nếu không có' },
    },
    required: ['dishes', 'notes'],
    additionalProperties: false,
  },

  PROMPT: "Đây là ảnh bữa ăn (chủ yếu món Việt Nam). Liệt kê TỪNG món ăn/đồ uống nhìn thấy. Với mỗi món: ước tính calo và macro (đạm/tinh bột/béo, gram) cho TOÀN BỘ phần nhìn thấy trong ảnh, dựa trên khẩu phần ước lượng từ kích thước tô/dĩa/ly và vật tham chiếu nếu có. Tính cả dầu mỡ chiên xào và đường ẩn theo cách chế biến phổ biến ở quán VN. Tên món bằng tiếng Việt. confidence: 'cao' nếu món rõ và khẩu phần dễ đoán, 'thấp' nếu món nước/món trộn khó ước lượng.",

  // Schema đọc bảng "Thông tin dinh dưỡng" trên bao bì → giá trị per-100g
  LABEL_SCHEMA: {
    type: 'object',
    properties: {
      found: { type: 'boolean', description: 'true nếu ảnh có bảng thông tin dinh dưỡng đọc được' },
      name: { type: 'string', description: 'Tên sản phẩm đọc được trên bao bì, rỗng nếu không rõ' },
      kcal: { type: 'number', description: 'Năng lượng (kcal) trên 100g hoặc 100ml' },
      protein: { type: 'number', description: 'Đạm (g) trên 100g/100ml' },
      carbs: { type: 'number', description: 'Tinh bột / carbohydrate (g) trên 100g/100ml' },
      fat: { type: 'number', description: 'Chất béo (g) trên 100g/100ml' },
    },
    required: ['found', 'name', 'kcal', 'protein', 'carbs', 'fat'],
    additionalProperties: false,
  },

  LABEL_PROMPT: "Đây là ảnh bao bì thực phẩm. Đọc bảng 'Thông tin dinh dưỡng / Nutrition Facts'. Trả về giá trị TRÊN 100g (hoặc 100ml nếu là đồ uống). Nếu bảng chỉ ghi theo khẩu phần (per serving / mỗi phần ăn), hãy quy đổi về 100g dựa trên khối lượng khẩu phần in trên bao bì. Nếu năng lượng chỉ có kJ, quy đổi sang kcal (kcal = kJ ÷ 4.184). name = tên sản phẩm đọc được trên bao bì. found=false nếu ảnh KHÔNG có bảng dinh dưỡng rõ ràng. CHỈ đọc số thật in trên bao bì, tuyệt đối không tự bịa.",

  // Giá per triệu token (USD): input / output
  PRICES: {
    'claude-haiku-4-5': { in: 1, out: 5 },
    'claude-opus-4-8': { in: 5, out: 25 },
  },
  USD_VND: 26000,

  cfg() { return Store.ai || {}; },

  // ---------- Modal chụp/chọn ảnh ----------
  open() {
    const cfg = this.cfg();
    if (!cfg.apiKey) {
      App.modal(`
        <h3>🤖 Phân tích ảnh món ăn</h3>
        <div class="m-sub">Chụp ảnh bữa ăn, AI ước tính calo & macro giúp bạn.</div>
        <div class="sub" style="line-height:1.6;margin-bottom:14px">
          Cần <b>API key Anthropic</b> để dùng:<br>
          1. Tạo tại <b>console.anthropic.com → API Keys</b><br>
          2. Nạp tối thiểu <b>$5</b> vào tài khoản<br>
          3. Mỗi ảnh chỉ tốn <b>~100đ</b> với model Haiku
        </div>
        <button class="btn" id="vi-goto-settings">Mở Cài đặt</button>`);
      document.getElementById('vi-goto-settings').addEventListener('click', () => {
        App.closeModal();
        App.go('settings');
      });
      return;
    }

    App.modal(`
      <h3>📸 Phân tích ảnh món ăn</h3>
      <div class="m-sub">Chụp hoặc chọn ảnh bữa ăn — AI ước tính calo & macro.</div>
      <input type="file" accept="image/*" capture="environment" id="vi-file" style="display:none">
      <button class="btn" id="vi-pick">📸 Chụp / chọn ảnh món ăn</button>
      <div id="vi-preview-wrap" style="margin-top:14px"></div>
      <div class="hint" style="margin-top:12px;line-height:1.5">
        💡 Chụp góc ~45°, để đũa/thìa trong khung làm thước đo. AI ước tính — bạn sẽ được duyệt/sửa trước khi lưu.
      </div>
      <div class="sub" id="vi-status" style="text-align:center;margin-top:10px"></div>`);

    const $ = id => document.getElementById(id);
    const fileInput = $('vi-file');
    $('vi-pick').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      this.setStatus('Đang xử lý ảnh...');
      let b64;
      try {
        b64 = await this.compress(file);
      } catch {
        this.setStatus('⚠️ Không đọc được ảnh này — thử ảnh khác.');
        return;
      }
      this.setStatus('');
      $('vi-preview-wrap').innerHTML = `
        <img src="data:image/jpeg;base64,${b64}" alt="Ảnh món ăn"
          style="width:100%;max-height:240px;object-fit:contain;border-radius:12px;background:var(--bg)">
        <button class="btn" id="vi-analyze" style="margin-top:12px">🔍 Phân tích</button>`;

      $('vi-analyze').addEventListener('click', async () => {
        const btn = $('vi-analyze');
        btn.disabled = true;
        this.setStatus('🤖 AI đang phân tích... (vài giây)');
        try {
          const { parsed, costText } = await this.analyze(b64);
          if (!parsed.dishes || !parsed.dishes.length) {
            this.setStatus('Không nhận ra món ăn nào trong ảnh.');
            btn.disabled = false;
            return;
          }
          this.showResults(parsed, costText);
        } catch (e) {
          this.setStatus('⚠️ ' + e.message);
          btn.disabled = false;
        }
      });
    });
  },

  setStatus(text) {
    const el = document.getElementById('vi-status');
    if (el) el.textContent = text;
  },

  // ---------- Nén ảnh: max 1024px cạnh dài, JPEG 0.82, trả base64 (không prefix) ----------
  compress(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const max = 1024;
        let { width: w, height: h } = img;
        if (w > max || h > max) {
          if (w >= h) { h = Math.round(h * max / w); w = max; }
          else { w = Math.round(w * max / h); h = max; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        resolve(dataUrl.replace(/^data:image\/jpeg;base64,/, ''));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Lỗi đọc ảnh')); };
      img.src = url;
    });
  },

  // ---------- Gọi API + parse → { parsed, costText } ----------
  async analyze(b64, schema = this.SCHEMA, prompt = this.PROMPT) {
    const cfg = this.cfg();
    const model = cfg.model || 'claude-haiku-4-5';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        output_config: { format: { type: 'json_schema', schema } },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    if (!res.ok) {
      let msg = '';
      try {
        const err = await res.json();
        msg = (err && err.error && err.error.message) || '';
      } catch { /* body không phải JSON */ }
      if (res.status === 401) throw new Error('API key không đúng — kiểm tra lại trong Cài đặt');
      if (res.status === 429) throw new Error('Gọi quá nhanh, đợi chút rồi thử lại');
      if (res.status === 400 && /credit/i.test(msg)) throw new Error('Tài khoản Anthropic hết credit');
      throw new Error(msg || ('Lỗi ' + res.status));
    }

    const data = await res.json();
    if (data.stop_reason === 'refusal') {
      throw new Error('AI từ chối phân tích ảnh này — thử ảnh khác.');
    }

    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) throw new Error('Không nhận được kết quả từ AI — thử lại.');
    const parsed = JSON.parse(textBlock.text); // structured output đảm bảo JSON hợp lệ

    // Chi phí
    const price = this.PRICES[model] || this.PRICES['claude-haiku-4-5'];
    const u = data.usage || { input_tokens: 0, output_tokens: 0 };
    const usd = (u.input_tokens || 0) * price.in / 1e6 + (u.output_tokens || 0) * price.out / 1e6;
    const vnd = Math.round(usd * this.USD_VND / 10) * 10;
    return { parsed, costText: '~' + vnd.toLocaleString('vi-VN') + ' đ' };
  },

  // ---------- Modal kết quả — duyệt trước khi lưu ----------
  showResults(parsed, costText) {
    const dishes = parsed.dishes || [];
    const defaultMeal = guessMeal();
    const confTag = c => c === 'cao'
      ? '<span class="tag green">cao</span>'
      : c === 'vừa'
        ? '<span class="tag orange">vừa</span>'
        : '<span class="tag" style="background:#fde8e8;color:var(--red)">thấp</span>';

    const rows = dishes.map((d, i) => `
      <div class="vi-dish" data-i="${i}" style="padding:10px 0;border-bottom:1px solid var(--line)">
        <div style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" class="vi-chk" data-i="${i}" checked style="width:20px;height:20px;flex:0 0 auto">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600">${esc(d.name)} ${confTag(d.confidence)}</div>
            <div class="sub">${esc(d.portion || '')}</div>
          </div>
          <div style="display:flex;align-items:center;gap:4px;flex:0 0 auto">
            <input type="number" class="vi-kcal" data-i="${i}" value="${Math.round(d.kcal)}"
              inputmode="numeric" style="width:64px;text-align:right"><span class="sub">kcal</span>
          </div>
        </div>
        <div class="sub" style="margin-left:28px;margin-top:2px">Đ${Math.round(d.protein || 0)} · T${Math.round(d.carbs || 0)} · B${Math.round(d.fat || 0)}</div>
      </div>`).join('');

    App.modal(`
      <h3>Kết quả phân tích</h3>
      ${parsed.notes ? `<div class="m-sub">${esc(parsed.notes)}</div>` : ''}
      <div class="sub" style="margin-bottom:8px">Phí lần này: ${esc(costText)}</div>
      <div id="vi-dishes">${rows}</div>
      <div class="field" style="margin-top:14px"><label>Bữa</label>
        <select id="vi-meal">${MEALS.map(m => `<option value="${m.id}" ${m.id === defaultMeal ? 'selected' : ''}>${m.icon} ${m.name}</option>`).join('')}</select>
      </div>
      <button class="btn" id="vi-add"></button>`);

    const $ = id => document.getElementById(id);

    // Cập nhật live tổng trên nút theo checkbox + kcal đã sửa
    const updBtn = () => {
      let n = 0, total = 0;
      dishes.forEach((d, i) => {
        if ($('vi-dishes').querySelector(`.vi-chk[data-i="${i}"]`).checked) {
          n++;
          total += +$('vi-dishes').querySelector(`.vi-kcal[data-i="${i}"]`).value || 0;
        }
      });
      const btn = $('vi-add');
      btn.disabled = n === 0;
      btn.textContent = n === 0 ? 'Chọn ít nhất 1 món' : `Thêm ${n} món — ${Math.round(total)} kcal`;
    };
    $('vi-dishes').querySelectorAll('.vi-chk').forEach(c => c.addEventListener('change', updBtn));
    $('vi-dishes').querySelectorAll('.vi-kcal').forEach(c => c.addEventListener('input', updBtn));
    updBtn();

    $('vi-add').addEventListener('click', () => {
      const meal = $('vi-meal').value;
      let n = 0;
      dishes.forEach((d, i) => {
        if (!$('vi-dishes').querySelector(`.vi-chk[data-i="${i}"]`).checked) return;
        const kcalNew = +$('vi-dishes').querySelector(`.vi-kcal[data-i="${i}"]`).value || 0;
        const kcalOrig = Math.round(d.kcal) || 0;
        // scale macro theo tỷ lệ nếu user sửa kcal
        const ratio = kcalOrig > 0 ? kcalNew / kcalOrig : 1;
        const r1 = v => Math.round((v || 0) * ratio * 10) / 10;
        Store.addMeal(App.dayKey, {
          name: d.name,
          portion: d.portion,
          qty: 1,
          kcal: kcalNew,
          protein: r1(d.protein),
          carbs: r1(d.carbs),
          fat: r1(d.fat),
          meal,
        });
        n++;
      });
      App.closeModal();
      App.toast(`✅ Đã thêm ${n} món`);
      App.go('today');
    });
  },

  // ---------- Đọc bảng dinh dưỡng trên bao bì → per-100g, gọi onResult(data) ----------
  // Dùng cho scanner khi quét mã không ra: chụp bảng dinh dưỡng, AI điền giúp form.
  scanLabel(onResult) {
    const cfg = this.cfg();
    if (!cfg.apiKey) {
      App.toast('⚠️ Cần API key ở Cài đặt → 🤖 AI phân tích ảnh');
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      App.toast('🤖 AI đang đọc bảng dinh dưỡng...');
      try {
        const b64 = await this.compress(file);
        const { parsed } = await this.analyze(b64, this.LABEL_SCHEMA, this.LABEL_PROMPT);
        if (!parsed.found) {
          App.toast('⚠️ Không thấy bảng dinh dưỡng — chụp rõ phần bảng số liệu hơn nhé.');
          return;
        }
        onResult(parsed);
      } catch (e) {
        App.toast('⚠️ ' + e.message);
      }
    });

    input.click();
  },
};
