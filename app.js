/* 바코드 조회 웹
 * - 실시간 스캔: 브라우저 내장 BarcodeDetector(안드로이드 크롬 등)가 있으면 사용, 없으면 ZXing(아이폰 Safari 포함)
 * - 사진으로 찍기: 실시간 카메라를 못 쓰는 환경을 위한 대체 경로
 * - 데이터: 구글시트(웹에 게시) 또는 products.csv + 이 기기에서 직접 등록한 상품(localStorage)
 */
(() => {
  'use strict';

  const MY_KEY = 'barcode.myProducts.v1';
  const HISTORY_KEY = 'barcode.history.v1';
  const $ = (id) => document.getElementById(id);

  const els = {
    viewport: $('viewport'), video: $('video'), status: $('status'),
    btnCamera: $('btnCamera'), photo: $('photo'), packPhoto: $('packPhoto'), manual: $('manual'), manualCode: $('manualCode'),
    result: $('result'), register: $('register'), regForm: $('regForm'), regCode: $('regCode'),
    regName: $('regName'), regPrice: $('regPrice'), regMemo: $('regMemo'), regImage: $('regImage'),
    regCancel: $('regCancel'), regTitle: $('regTitle'), regHint: $('regHint'), regEnglish: $('regEnglish'), regSave: $('regSave'),
    adminForm: $('adminForm'), adminPin: $('adminPin'), adminOn: $('adminOn'), btnLogout: $('btnLogout'), adminBadge: $('adminBadge'), history: $('history'), historyCard: $('historyCard'),
    dataInfo: $('dataInfo'), sheetForm: $('sheetForm'), sheetUrl: $('sheetUrl'), btnReload: $('btnReload'), btnExport: $('btnExport'), btnClearMine: $('btnClearMine'), exportBox: $('exportBox'),
  };

  /* ---------- 저장소 (실패해도 동작하도록) ---------- */
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
  };

  /* ---------- 상품 데이터 ----------
   * 읽는 순서: 구글시트(웹에 게시한 CSV) → products.csv(엑셀에서 저장) → products.json
   * 시트를 못 읽으면 마지막으로 읽은 시트 내용을 이 기기에 저장해 둔 것으로 보여줌
   */
  const SHEET_KEY = 'barcode.sheetUrl.v1';
  const CACHE_KEY = 'barcode.sheetCache.v1';
  // 숫자 바코드는 앞의 0을 떼고 비교 (UPC-A 12자리 = 0을 붙인 EAN-13, 시트가 앞의 0을 지운 경우도 같은 상품)
  const keyOf = (code) => { const c = String(code).replace(/[\s-]+/g, ''); return /^\d+$/.test(c) ? (c.replace(/^0+/, '') || '0') : c; };
  let baseProducts = new Map();
  let myProducts = new Map(Object.entries(store.get(MY_KEY, {})).map(([c, p]) => [keyOf(c), { ...p, barcode: p.barcode || c }]));
  let dataSource = '';

  const HEADER_MAP = {
    barcode: 'barcode', '바코드': 'barcode', '바코드번호': 'barcode', 'code': 'barcode',
    name: 'name', '상품명': 'name', '이름': 'name', '제품명': 'name', '품명': 'name',
    image: 'image', '이미지': 'image', '사진': 'image', '이미지주소': 'image', '이미지url': 'image',
    price: 'price', '가격': 'price', '판매가': 'price', '기본가격(원)': 'price',
    english: 'english', '영문명': 'english', '영어이름': 'english', '영문이름': 'english', '영문상품명': 'english',
    size: 'size', '용량': 'size', '규격': 'size', '중량': 'size',
    memo: 'memo', '메모': 'memo', '비고': 'memo', '설명': 'memo',
  };

  function sheetUrl() {
    const own = store.get(SHEET_KEY, '');
    return own || (window.BARCODE_SETTINGS && window.BARCODE_SETTINGS.sheetCsvUrl) || '';
  }

  // 구글시트 주소를 CSV로 받을 수 있는 주소로 바꿈
  function toCsvUrl(url) {
    const u = String(url).trim();
    if (/\/spreadsheets\/d\/e\//.test(u)) return /output=csv/.test(u) ? u : u.replace(/\/pub(html)?.*$/, '/pub?output=csv');
    const m = u.match(/\/spreadsheets\/d\/([\w-]+)/);
    if (m) {
      const gid = (u.match(/[#&?]gid=(\d+)/) || [])[1];
      return `https://docs.google.com/spreadsheets/d/${m[1]}/gviz/tq?tqx=out:csv${gid ? '&gid=' + gid : ''}`;
    }
    return u;
  }

  // 구글 드라이브 공유 링크는 바로 보이는 이미지 주소로 바꿈
  function toImageUrl(v) {
    const s = String(v || '').trim();
    const m = s.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]+)/);
    return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w800` : s;
  }

  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    text = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim() !== ''));
  }

  let skipped = 0;
  function rowsToProducts(rows) {
    skipped = 0;
    if (!rows.length) return [];
    const keys = rows[0].map((h) => {
      const k = h.trim();
      return HEADER_MAP[k.toLowerCase().replace(/\s+/g, '')] || k;
    });
    if (!keys.includes('barcode')) throw new Error('첫 줄에 "바코드" 열이 없어요');
    const list = [];
    for (const r of rows.slice(1)) {
      const p = {};
      keys.forEach((k, i) => { if (k && r[i] != null && r[i].trim() !== '') p[k] = r[i].trim(); });
      if (!p.barcode) continue;
      p.barcode = p.barcode.replace(/^'/, '').replace(/[\s-]+/g, '');
      if (/e\+/i.test(p.barcode)) { skipped++; continue; } // 엑셀이 1.23E+12처럼 바꿔 버린 번호
      if (p.image) p.image = toImageUrl(p.image);
      list.push(p);
    }
    return list;
  }

  // 엑셀 한글 CSV는 EUC-KR일 수 있어 UTF-8로 안 읽히면 EUC-KR로 다시 읽음
  async function fetchCsv(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    const buf = await res.arrayBuffer();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch { text = new TextDecoder('euc-kr').decode(buf); }
    if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('시트가 공개되어 있지 않아요');
    return rowsToProducts(parseCsv(text));
  }

  async function loadProducts() {
    let list = window.PRODUCTS_INLINE || null;
    if (list) dataSource = '미리보기용 샘플 데이터';
    const api = !list && adminUrl();
    const url = !list && (api || sheetUrl());
    if (url) {
      try {
        if (api) {
          const res = await fetch(api, { cache: 'no-cache' });
          const d = await res.json();
          if (!d.ok) throw new Error(d.error || '시트를 읽지 못했어요');
          list = d.products.map((p) => (p.image ? { ...p, image: toImageUrl(p.image) } : p)).filter((p) => !/e\+/i.test(p.barcode));
        } else {
          list = await fetchCsv(toCsvUrl(url));
        }
        store.set(CACHE_KEY, { at: Date.now(), list });
        dataSource = `구글시트 (${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}에 불러옴)`;
      } catch (err) {
        const e = err instanceof TypeError ? new Error('인터넷 연결이나 시트 공유 설정을 확인해 주세요') : err;
        const cache = store.get(CACHE_KEY, null);
        if (cache && cache.list) {
          list = cache.list;
          dataSource = `저장해 둔 시트 내용 (${new Date(cache.at).toLocaleString('ko-KR')})`;
          setStatus(`구글시트를 읽지 못해 저장해 둔 내용을 보여줘요. (${e.message})`, true);
        } else {
          setStatus(`구글시트를 읽지 못했어요: ${e.message}. "데이터 관리"에서 주소를 확인해 주세요.`, true);
        }
      }
    }
    if (!list) {
      try { list = await fetchCsv('products.csv'); dataSource = 'products.csv 파일'; }
      catch {
        try {
          const res = await fetch('products.json', { cache: 'no-cache' });
          if (!res.ok) throw new Error(res.status);
          list = await res.json(); dataSource = 'products.json 파일';
        } catch { list = []; dataSource = '없음'; if (!url) setStatus('상품 데이터를 불러오지 못했어요.', true); }
      }
    }
    baseProducts = new Map();
    for (const p of list) if (p && p.barcode) baseProducts.set(keyOf(p.barcode), p);
    buildGroups();
    renderDataInfo();
  }

  function findProduct(code) {
    const k = keyOf(code);
    if (myProducts.has(k)) return { ...myProducts.get(k), barcode: myProducts.get(k).barcode || code, mine: true };
    if (baseProducts.has(k)) return { ...baseProducts.get(k), mine: false };
    return null;
  }

  /* ---------- 화면 출력 ---------- */
  function setStatus(text, isError = false) {
    els.status.textContent = text;
    els.status.classList.toggle('error', isError);
  }

  const FIELD_LABELS = { price: '가격', memo: '메모' };
  const HIDDEN_FIELDS = new Set(['barcode', 'name', 'image', 'mine', 'english', 'size']);

  /* ---------- 용량 묶기 ----------
   * 같은 상품의 다른 용량을 한 묶음으로: 영문명이 같으면 한 묶음,
   * 영문명이 없으면 상품명에서 용량(2kg, 85g, 374g / 6 …)을 뗀 이름이 같으면 한 묶음
   */
  const SIZE_RE = /\d+(?:\.\s?\d+)?\s*(?:kg|g|ml|l|p)(?![a-z])/i;
  function splitName(name) {
    const n = String(name || '').trim();
    const m = n.match(SIZE_RE);
    if (!m) return { base: n, size: '' };
    return { base: n.slice(0, m.index).trim() || n, size: n.slice(m.index).replace(/(\d)\.\s+(\d)/, '$1.$2').trim() };
  }
  const sizeOf = (p) => p.size || splitName(p.name).size;
  const baseOf = (p) => splitName(p.name).base;
  // Entrée → ENTREE 처럼 악센트는 떼고 비교
  const normEn = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const groupKey = (p) => p.english
    ? 'en:' + normEn(p.english.split('|')[0])
    : 'ko:' + baseOf(p).replace(/[\s&+·,.]/g, '').replace(/[\d.]+$/, '');
  function sizeValue(s) {
    const m = String(s).match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l|p)/i);
    if (!m) return Infinity;
    const u = m[2].toLowerCase();
    return parseFloat(m[1]) * (u === 'kg' || u === 'l' ? 1000 : 1);
  }
  let groups = new Map();
  function buildGroups() {
    groups = new Map();
    const all = [...baseProducts.values(), ...[...myProducts.values()].map((p) => ({ ...p, mine: true }))];
    for (const p of all) {
      const k = groupKey(p);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    for (const list of groups.values()) list.sort((a, b) => sizeValue(sizeOf(a)) - sizeValue(sizeOf(b)));
  }

  function notFoundBox(code) {
    const box = document.createElement('div');
    box.className = 'notfound';
    box.innerHTML = '<strong>등록되지 않은 바코드예요</strong><div class="code"></div>';
    box.querySelector('.code').textContent = code;
    const btn = document.createElement('button');
    btn.className = 'primary'; btn.type = 'button';
    btn.textContent = isAdmin() ? '시트에 이 상품 등록하기' : '이 바코드 등록하기';
    btn.addEventListener('click', () => openRegister(code, null, isAdmin() ? 'admin-new' : 'local'));
    box.append(btn);
    return box;
  }

  function showResult(code) {
    const p = findProduct(code);
    els.register.hidden = true;
    els.result.hidden = false;
    if (!p) {
      els.result.replaceChildren(notFoundBox(code));
      addHistory(code, null);
      return;
    }
    const list = groups.get(groupKey(p)) || [p];
    renderGroup(list, list.find((x) => keyOf(x.barcode) === keyOf(p.barcode)) || p);
    addHistory(p.barcode, p.name);
  }

  // 한 상품 묶음을 카드로: 용량 버튼을 누르면 그 용량의 가격과 바코드를 보여줌
  // selected가 없으면(사진으로 찾은 경우) 용량을 고르라고 안내
  function renderGroup(list, selected, extra) {
    const multi = list.length > 1;
    const shown = selected || (multi ? null : list[0]);
    const head = shown || list[0];

    const card = document.createElement('article');
    card.className = 'product';
    const imgSrc = (shown && shown.image) || (list.find((x) => x.image) || {}).image;
    const imgWrap = document.createElement('div');
    imgWrap.className = 'img';
    if (imgSrc) {
      const img = document.createElement('img');
      img.alt = head.name || '상품 이미지';
      img.src = imgSrc;
      img.onerror = () => { imgWrap.innerHTML = '<span class="noimg">이미지를 불러오지 못했어요</span>'; };
      imgWrap.append(img);
    }

    const body = document.createElement('div');
    body.className = 'body';
    const name = document.createElement('p');
    name.className = 'name';
    name.textContent = multi ? baseOf(head) : (head.name || '(이름 없음)');
    body.append(name);
    if (head.english) {
      const en = document.createElement('p');
      en.className = 'en';
      en.textContent = head.english.split('|')[0].trim();
      body.append(en);
    }
    if (shown && shown.mine) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = '이 기기에서 등록'; body.append(t); }

    if (multi) {
      const label = document.createElement('p');
      label.className = 'sizes-label';
      label.textContent = '용량';
      const chips = document.createElement('div');
      chips.className = 'sizes';
      chips.setAttribute('role', 'group');
      chips.setAttribute('aria-label', '용량 선택');
      for (const item of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'size';
        b.textContent = sizeOf(item) || item.name;
        b.setAttribute('aria-pressed', String(!!shown && keyOf(item.barcode) === keyOf(shown.barcode)));
        b.addEventListener('click', () => renderGroup(list, item, extra));
        chips.append(b);
      }
      body.append(label, chips);
    }

    const price = document.createElement('p');
    price.className = 'price';
    if (shown) price.textContent = shown.price || '가격 정보 없음';
    else { price.textContent = '용량을 고르면 가격이 나와요'; price.classList.add('pending'); }
    body.append(price);

    if (shown) {
      const dl = document.createElement('dl');
      const add = (k, v) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); };
      if (multi) add('상품명', shown.name);
      add('바코드', shown.barcode);
      for (const [k, v] of Object.entries(shown)) {
        if (HIDDEN_FIELDS.has(k) || k === 'price' || v === '' || v == null) continue;
        add(FIELD_LABELS[k] || k, String(v));
      }
      body.append(dl);
      if (isAdmin() && !shown.mine) body.append(adminActions(shown));
      else if (shown.mine) {
        const row = document.createElement('div'); row.className = 'row';
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'ghost'; edit.textContent = '수정';
        edit.addEventListener('click', () => openRegister(shown.barcode, shown, 'local'));
        row.append(edit); body.append(row);
      }
    }
    if (imgSrc) card.append(imgWrap);
    card.append(body);
    els.result.replaceChildren(card);
    if (extra) els.result.append(extra);
  }

  /* ---------- 최근 조회 ---------- */
  let history = store.get(HISTORY_KEY, []);
  function addHistory(code, name) {
    history = [{ code, name }, ...history.filter((h) => h.code !== code)].slice(0, 10);
    store.set(HISTORY_KEY, history);
    renderHistory();
  }
  function renderHistory() {
    els.historyCard.hidden = history.length === 0;
    els.history.replaceChildren(...history.map((h) => {
      const li = document.createElement('li');
      const b = document.createElement('button'); b.type = 'button';
      const n = document.createElement('span'); n.className = 'n';
      const p = findProduct(h.code);
      n.textContent = p ? p.name : '미등록';
      const c = document.createElement('span'); c.className = 'c'; c.textContent = h.code;
      b.append(n, c);
      b.addEventListener('click', () => showResult(h.code));
      li.append(b); return li;
    }));
  }

  /* ---------- 관리자 모드 ----------
   * settings.js의 adminApiUrl(구글시트에 붙인 Apps Script 주소)이 있으면
   * 관리자 비밀번호로 들어가 웹에서 바로 시트의 상품을 추가, 수정, 삭제
   */
  const ADMIN_KEY = 'barcode.adminPin.v1';
  const adminUrl = () => (window.BARCODE_SETTINGS && window.BARCODE_SETTINGS.adminApiUrl) || '';
  let adminPin = store.get(ADMIN_KEY, '');
  const isAdmin = () => !!(adminUrl() && adminPin);

  async function adminCall(body) {
    const res = await fetch(adminUrl(), { method: 'POST', body: JSON.stringify({ pin: adminPin, ...body }) });
    let data;
    try { data = await res.json(); } catch { throw new Error('관리 스크립트 응답을 읽지 못했어요'); }
    if (!data.ok) {
      if (data.code === 'bad_pin') { adminPin = ''; store.set(ADMIN_KEY, ''); renderAdmin(); }
      throw new Error(data.error || '저장하지 못했어요');
    }
    return data;
  }

  function renderAdmin() {
    const on = isAdmin();
    els.adminForm.hidden = !adminUrl() || on;
    els.adminOn.hidden = !on;
    els.adminBadge.hidden = !on;
    els.sheetForm.hidden = !!adminUrl(); // 관리 연결을 쓰면 시트 주소 칸은 필요 없음
    document.body.classList.toggle('is-admin', on);
  }
  els.adminForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = els.adminPin.value.trim();
    if (!pin) return;
    adminPin = pin;
    setStatus('비밀번호 확인 중…');
    try {
      await adminCall({ action: 'login' });
      store.set(ADMIN_KEY, pin);
      els.adminPin.value = '';
      setStatus('관리자 모드예요. 상품 카드의 "수정"으로 바로 고칠 수 있어요.');
    } catch (err) {
      adminPin = '';
      setStatus(err.message, true);
    }
    renderAdmin();
    if (els.result.querySelector('.product, .notfound') && history[0]) showResult(history[0].code);
  });
  els.btnLogout.addEventListener('click', () => {
    adminPin = ''; store.set(ADMIN_KEY, '');
    renderAdmin();
    setStatus('관리자 모드에서 나왔어요.');
  });

  // 상품 카드 아래 관리자 버튼: 수정, 같은 상품 다른 용량 추가, 삭제(한 번 더 눌러 확인)
  function adminActions(p) {
    const row = document.createElement('div');
    row.className = 'row admin-actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'ghost'; edit.textContent = '수정';
    edit.addEventListener('click', () => openRegister(p.barcode, p, 'admin'));
    const more = document.createElement('button'); more.type = 'button'; more.className = 'ghost'; more.textContent = '다른 용량 추가';
    more.addEventListener('click', () => openRegister('', { name: baseOf(p) + ' ', english: p.english, memo: '' }, 'admin-new'));
    const del = document.createElement('button'); del.type = 'button'; del.className = 'ghost danger'; del.textContent = '삭제';
    let armed = false;
    del.addEventListener('click', async () => {
      if (!armed) { armed = true; del.textContent = '한 번 더 누르면 삭제돼요'; setTimeout(() => { armed = false; del.textContent = '삭제'; }, 4000); return; }
      del.disabled = true;
      setStatus('삭제하는 중…');
      try {
        await adminCall({ action: 'delete', barcode: p.barcode });
        await loadProducts(); renderHistory();
        els.result.hidden = true;
        setStatus(`"${p.name}"을(를) 삭제했어요.`);
      } catch (err) { setStatus(err.message, true); del.disabled = false; }
    });
    row.append(edit, more, del);
    return row;
  }

  /* ---------- 등록, 수정 ----------
   * mode: 'local'(이 기기에만), 'admin'(시트의 상품 수정), 'admin-new'(시트에 새로 등록)
   */
  let regImageData = null, regMode = 'local', regOriginal = '';
  function openRegister(code, existing, mode) {
    regMode = mode || (isAdmin() ? 'admin-new' : 'local');
    const admin = regMode !== 'local';
    regOriginal = regMode === 'admin' ? code : '';
    els.register.hidden = false;
    els.register.classList.toggle('for-admin', admin);
    els.regTitle.textContent = regMode === 'admin' ? '상품 수정' : admin ? '시트에 상품 등록' : '이 바코드 등록하기';
    els.regHint.textContent = admin ? '저장하면 구글시트에 바로 반영돼서 모든 폰에서 보여요.' : '등록한 상품은 이 기기에만 저장돼요.';
    els.regCode.readOnly = !admin;
    els.regCode.value = code || '';
    els.regName.value = existing?.name || '';
    els.regEnglish.value = existing?.english || '';
    els.regPrice.value = existing?.price || '';
    els.regMemo.value = existing?.memo || '';
    els.regImage.value = '';
    regImageData = admin ? null : (existing?.image || null);
    els.register.scrollIntoView({ behavior: 'smooth', block: 'start' });
    (code ? els.regName : els.regCode).focus({ preventScroll: true });
  }
  els.regCancel.addEventListener('click', () => { els.register.hidden = true; });
  els.regImage.addEventListener('change', async () => {
    const f = els.regImage.files[0];
    if (!f) return;
    try { regImageData = await shrinkImage(f, regMode === 'local' ? 480 : 900); } catch { regImageData = null; }
  });
  els.regForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = els.regCode.value.replace(/[\s-]+/g, '');
    if (!code) { setStatus('바코드를 입력해 주세요.', true); els.regCode.focus(); return; }
    const item = { name: els.regName.value.trim(), price: els.regPrice.value.trim(), memo: els.regMemo.value.trim() };

    if (regMode !== 'local') {
      item.english = els.regEnglish.value.trim();
      els.regSave.disabled = true;
      try {
        if (regImageData) {
          setStatus('사진 올리는 중…');
          item.image = (await adminCall({ action: 'photo', dataUrl: regImageData, barcode: code })).url;
        }
        setStatus('시트에 저장하는 중…');
        await adminCall({ action: 'save', originalBarcode: regOriginal || undefined, product: { barcode: code, ...item } });
        await loadProducts(); renderHistory();
        els.register.hidden = true;
        showResult(code);
        setStatus('시트에 저장했어요.');
      } catch (err) {
        setStatus(err.message, true);
      } finally { els.regSave.disabled = false; }
      return;
    }

    if (regImageData) item.image = regImageData;
    item.barcode = code;
    myProducts.set(keyOf(code), item);
    const ok = store.set(MY_KEY, Object.fromEntries(myProducts));
    els.register.hidden = true;
    buildGroups();
    showResult(code);
    renderDataInfo();
    if (!ok) setStatus('이 브라우저에서는 저장이 막혀 있어 새로고침하면 사라져요.', true);
    else setStatus('저장했어요.');
  });

  async function shrinkImage(file, max) {
    const img = await loadImage(file);
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  }
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }

  /* ---------- 데이터 관리 ---------- */
  function renderDataInfo() {
    els.dataInfo.textContent = `상품 ${baseProducts.size}개 · 출처: ${dataSource}` +
      (skipped ? ` · 바코드가 1.23E+12처럼 바뀐 ${skipped}줄은 건너뜀` : '') +
      (myProducts.size ? ` · 이 기기에서 등록한 상품 ${myProducts.size}개` : '');
    els.sheetUrl.value = store.get(SHEET_KEY, '') || '';
  }
  els.btnExport.addEventListener('click', async () => {
    // 이 기기에서 등록한 상품을 시트에 붙여 넣을 수 있는 형태로 (사진은 시트에 넣을 수 없어 제외)
    const lines = ['바코드\t상품명\t이미지\t가격\t메모'];
    for (const p of myProducts.values()) {
      const img = p.image && !p.image.startsWith('data:') ? p.image : '';
      lines.push([p.barcode, p.name, img, p.price, p.memo].map((v) => String(v ?? '').replace(/[\t\n\r]/g, ' ')).join('\t'));
    }
    const text = lines.join('\n');
    els.exportBox.hidden = false;
    els.exportBox.value = myProducts.size ? text : '이 기기에서 등록한 상품이 없어요.';
    els.exportBox.select();
    try { await navigator.clipboard.writeText(text); setStatus('복사했어요. 구글시트 빈 줄에 붙여 넣으세요. (첫 줄 제목은 빼고)'); }
    catch { setStatus('아래 상자의 내용을 길게 눌러 복사해 주세요.'); }
  });
  els.sheetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    store.set(SHEET_KEY, els.sheetUrl.value.trim());
    setStatus('데이터를 다시 불러오는 중…');
    await loadProducts(); renderHistory();
    if (!els.status.classList.contains('error')) setStatus(`상품 ${baseProducts.size}개를 불러왔어요.`);
  });
  els.btnReload.addEventListener('click', async () => {
    setStatus('데이터를 다시 불러오는 중…');
    await loadProducts(); renderHistory();
    if (!els.status.classList.contains('error')) setStatus(`상품 ${baseProducts.size}개를 불러왔어요.`);
  });
  els.btnClearMine.addEventListener('click', () => {
    if (myProducts.size === 0) return;
    myProducts = new Map();
    store.set(MY_KEY, {});
    buildGroups();
    renderDataInfo(); renderHistory();
    setStatus('이 기기에서 등록한 상품을 지웠어요.');
  });

  /* ---------- 바코드 인식 ---------- */
  const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
  let nativeDetector = null;
  async function initNative() {
    if (!('BarcodeDetector' in window)) return;
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
      if (formats.length) nativeDetector = new window.BarcodeDetector({ formats });
    } catch { nativeDetector = null; }
  }

  let zxReader = null;
  function getZx() {
    if (zxReader || !window.ZXing) return zxReader;
    const Z = window.ZXing;
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
      Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E,
      Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.ITF,
    ]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    zxReader = new Z.MultiFormatReader();
    zxReader.setHints(hints);
    return zxReader;
  }
  let flip = false;
  function zxDecodeCanvas(canvas, both = false) {
    const reader = getZx();
    if (!reader) return null;
    const Z = window.ZXing;
    const binarizers = both ? [Z.HybridBinarizer, Z.GlobalHistogramBinarizer] : [(flip = !flip) ? Z.HybridBinarizer : Z.GlobalHistogramBinarizer];
    for (const B of binarizers) {
      try {
        const src = new Z.HTMLCanvasElementLuminanceSource(canvas);
        return reader.decodeWithState(new Z.BinaryBitmap(new B(src))).getText();
      } catch { /* 이 프레임에서는 못 찾음 */ } finally { reader.reset(); }
    }
    return null;
  }

  /* ---------- 실시간 카메라 ---------- */
  let stream = null, running = false, lastCode = '', lastAt = 0, busy = false;
  const frame = document.createElement('canvas');
  const fctx = frame.getContext('2d', { willReadFrequently: true });

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus(location.protocol === 'https:' || location.hostname === 'localhost'
        ? '이 화면에서는 실시간 카메라를 쓸 수 없어요. "사진으로 찍기"를 눌러 주세요.'
        : '카메라는 https 주소에서만 켜져요. "사진으로 찍기"를 이용하거나 https로 열어 주세요.', true);
      return;
    }
    setStatus('카메라를 켜는 중…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
    } catch (e) {
      const msg = e && e.name === 'NotAllowedError'
        ? '카메라 권한이 거부됐어요. 브라우저 설정에서 카메라를 허용하거나 "사진으로 찍기"를 이용하세요.'
        : '카메라를 켜지 못했어요. "사진으로 찍기"를 이용해 주세요.';
      setStatus(msg, true);
      return;
    }
    els.video.srcObject = stream;
    els.viewport.hidden = false;
    try { await els.video.play(); } catch { /* iOS: autoplay 속성으로 재생됨 */ }
    try {
      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities?.();
      if (caps?.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch { /* 초점 설정 미지원 */ }
    running = true;
    els.btnCamera.textContent = '카메라 끄기';
    const ocrOn = startLiveOcr();
    setStatus(ocrOn ? '바코드나 포장 앞면을 비춰 주세요. 찾으면 바로 넘어가요.' : '바코드를 네모 칸 안에 가로로 맞춰 주세요.');
    requestAnimationFrame(tick);
  }

  function stopCamera() {
    running = false;
    stopLiveOcr();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    els.video.srcObject = null;
    els.viewport.hidden = true;
    els.btnCamera.textContent = '카메라로 찾기';
  }

  let lastTick = 0;
  async function tick(now) {
    if (!running) return;
    requestAnimationFrame(tick);
    if (busy || now - lastTick < 110) return;
    const v = els.video;
    if (v.readyState < 2 || !v.videoWidth) return;
    lastTick = now; busy = true;
    try {
      let code = null;
      if (nativeDetector) {
        const found = await nativeDetector.detect(v);
        code = found[0]?.rawValue || null;
      } else {
        // 가이드 상자 주변(가운데 띠)만 잘라서 빠르게 인식
        const vw = v.videoWidth, vh = v.videoHeight;
        const cw = Math.round(vw * 0.9), ch = Math.round(vh * 0.5);
        const scale = Math.min(1, 800 / cw);
        frame.width = Math.round(cw * scale); frame.height = Math.round(ch * scale);
        fctx.drawImage(v, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, frame.width, frame.height);
        code = zxDecodeCanvas(frame);
      }
      if (code) onDetected(code);
    } catch { /* 다음 프레임에서 다시 */ } finally { busy = false; }
  }

  /* ---------- 포장 그림으로 찾기 (vision-worker.js) ----------
   * 글자를 못 읽어도 포장 디자인(그림, 로고 배치)이 상품 사진과 맞는지 비교
   * 같은 사진을 쓰는 상품(맛만 다른 캔 등)은 글자 점수로 순서를 정함
   */
  let vision = null, visionReq = 0, refUrls = new Map(), refsSig = '', refsJob = null;
  const visionWait = new Map();
  function getVision() {
    if (vision || window.PREVIEW_NO_OCR || !window.Worker) return vision;
    try { vision = new Worker('vision-worker.js'); } catch { return null; }
    vision.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'result' && visionWait.has(m.req)) { visionWait.get(m.req)(m); visionWait.delete(m.req); }
    };
    return vision;
  }
  function toGray(src, sw, sh, max) {
    const s = Math.min(1, max / Math.max(sw, sh));
    const w = Math.round(sw * s), h = Math.round(sh * s);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data, gray = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    return { w, h, gray };
  }
  // 상품 사진들을 비교 기준으로 등록 (데이터가 바뀌었을 때만 다시)
  function buildRefs() {
    const wk = getVision();
    if (!wk) return Promise.resolve(0);
    const map = new Map();
    for (const list of groups.values()) {
      const url = (list.find((p) => p.image) || {}).image;
      if (!url) continue;
      if (!map.has(url)) map.set(url, []);
      map.get(url).push(list);
    }
    const sig = [...map.keys()].join('\n') + '|' + groups.size;
    if (sig === refsSig && refsJob) return refsJob;
    refsSig = sig;
    wk.postMessage({ type: 'clear' });
    const next = new Map();
    refsJob = Promise.all([...map].map(([url, lists]) => new Promise((res) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const g = toGray(img, img.naturalWidth, img.naturalHeight, 640);
          wk.postMessage({ type: 'ref', id: url, ...g }, [g.gray.buffer]);
          next.set(url, lists);
        } catch { /* 다른 사이트 사진은 읽을 수 없어 건너뜀 */ }
        res();
      };
      img.onerror = () => res();
      img.src = url;
    }))).then(() => { refUrls = next; return next.size; });
    return refsJob;
  }
  function visualMatch(src, sw, sh) {
    const wk = getVision();
    if (!wk || !refUrls.size) return Promise.resolve(null);
    const g = toGray(src, sw, sh, 720);
    const req = ++visionReq;
    return new Promise((res) => {
      visionWait.set(req, res);
      wk.postMessage({ type: 'match', req, ...g }, [g.gray.buffer]);
      setTimeout(() => { if (visionWait.has(req)) { visionWait.delete(req); res(null); } }, 10000);
    });
  }
  // 그림 비교: 1등과 비슷하게 맞은 사진들(같은 라인의 맛만 다른 상품 등)을 후보로 모아
  // 글자에서 맛 이름 등이 읽혔으면 그 상품을 앞으로
  function visualPick(vr, text) {
    if (!vr || !vr.results.length) return null;
    const [a, b] = vr.results;
    if (!refUrls.get(a.id)) return null;
    const second = b ? b.inliers : 0;
    const sure = (a.inliers >= 12 && a.inliers >= 1.5 * second) || (a.inliers >= 20 && a.inliers >= 1.15 * second);
    const ocr = matchGroups(text || '');
    const scoreOf = (list) => (ocr.find((f) => f.list === list) || {}).score || 0;
    const found = [];
    vr.results.forEach((r, rank) => {
      if (rank > 0 && (r.inliers < 8 || r.inliers < a.inliers * 0.75)) return;
      for (const list of refUrls.get(r.id) || []) if (!found.some((f) => f.list === list)) found.push({ list, score: scoreOf(list), inl: r.inliers });
    });
    found.sort((x, y) => (y.score - x.score) || (y.inl - x.inl));
    return { sure, found: found.slice(0, 4), inliers: a.inliers, id: a.id };
  }

  /* 카메라를 비추는 동안 포장 그림과 글자를 계속 비교하다가, 확실하면 바로 결과로 넘어감 */
  let liveOcr = false, ocrBusy = false, ocrTimer = 0, lastPick = null, lastShownKey = '', lastShownAt = 0;
  const ocrFrame = document.createElement('canvas');
  let liveVis = false, visBusy = false, visTimer = 0, lastVis = null, lastText = '';
  function startLiveOcr() {
    if (window.PREVIEW_NO_OCR) return false;
    lastPick = null; lastVis = null; lastText = '';
    if (window.Tesseract && [...groups.values()].some((l) => l.some((p) => p.english))) {
      liveOcr = true;
      getOcr().catch(() => { liveOcr = false; });
      clearTimeout(ocrTimer);
      ocrTimer = setTimeout(ocrLoop, 600);
    }
    if (getVision() && [...groups.values()].some((l) => l.some((p) => p.image))) {
      liveVis = true;
      clearTimeout(visTimer);
      buildRefs().then(() => { if (running && liveVis) visTimer = setTimeout(visionLoop, 100); });
    }
    return liveOcr || liveVis;
  }
  function stopLiveOcr() { liveOcr = false; liveVis = false; clearTimeout(ocrTimer); clearTimeout(visTimer); }
  async function visionLoop() {
    if (!running || !liveVis) return;
    const v = els.video;
    if (!visBusy && v.readyState >= 2 && v.videoWidth) {
      visBusy = true;
      try {
        const vp = visualPick(await visualMatch(v, v.videoWidth, v.videoHeight), lastText);
        // 같은 사진이 두 번 연속 확실하게 나와야 넘어감
        if (vp && vp.sure) {
          if (lastVis === vp.id) { lastVis = null; if (running && liveVis) showLive(vp.found, lastText); } else lastVis = vp.id;
        } else lastVis = null;
      } catch { /* 다음 번에 다시 */ } finally { visBusy = false; }
    }
    if (running && liveVis) visTimer = setTimeout(visionLoop, 150);
  }
  function showLive(found, text) {
    const key = groupKey(found[0].list[0]);
    const now = Date.now();
    if (key === lastShownKey && now - lastShownAt < 8000) return; // 같은 상품 반복 표시 방지
    lastShownKey = key; lastShownAt = now; lastPick = null;
    els.viewport.classList.add('hit');
    setTimeout(() => els.viewport.classList.remove('hit'), 400);
    showPhotoResult(text, found);
  }
  async function ocrLoop() {
    if (!running || !liveOcr) return;
    const v = els.video;
    if (!ocrBusy && v.readyState >= 2 && v.videoWidth) {
      ocrBusy = true;
      try {
        const worker = await getOcr();
        const scale = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
        ocrFrame.width = Math.round(v.videoWidth * scale); ocrFrame.height = Math.round(v.videoHeight * scale);
        const c = ocrFrame.getContext('2d');
        c.filter = 'grayscale(1) contrast(1.3)';
        c.drawImage(v, 0, 0, ocrFrame.width, ocrFrame.height);
        const { data } = await worker.recognize(ocrFrame);
        lastText = data.text || '';
        if (running && liveOcr) judgeLive(lastText);
      } catch { /* 다음 번에 다시 */ } finally { ocrBusy = false; }
    }
    if (running && liveOcr) ocrTimer = setTimeout(ocrLoop, 250);
  }
  // 잘못 넘어가지 않게: 한 번에 아주 확실하거나, 같은 상품이 두 번 연속 1등일 때만 넘어감
  function judgeLive(text) {
    const found = matchGroups(text);
    const top = found[0];
    if (!top) { lastPick = null; return; }
    const key = groupKey(top.list[0]);
    const clear = !found[1] || top.score >= found[1].score * 1.25;
    // 비슷한 상품끼리 비기면(퍼피/성견 등) 1등을 보여주고 나머지는 "다른 상품일 수도" 후보로
    const sure = (clear && top.score >= 0.7) || (top.score >= 0.45 && lastPick === key);
    lastPick = top.score >= 0.45 ? key : null;
    if (!sure) return;
    showLive(found, text);
  }

  function onDetected(code) {
    const now = Date.now();
    if (code === lastCode && now - lastAt < 2500) return; // 같은 바코드 연속 인식 방지
    lastCode = code; lastAt = now;
    feedback();
    els.viewport.classList.add('hit');
    setTimeout(() => els.viewport.classList.remove('hit'), 400);
    setStatus(`인식: ${code}`);
    showResult(code);
    els.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  let audioCtx = null;
  function feedback() {
    try { navigator.vibrate?.(60); } catch { /* 진동 미지원 */ }
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 1400; g.gain.value = 0.06;
      o.connect(g).connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.08);
    } catch { /* 소리 미지원 */ }
  }

  els.btnCamera.addEventListener('click', () => {
    // iOS는 사용자 동작 안에서 오디오를 열어야 이후 소리가 남
    try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.(); } catch { /* 무시 */ }
    running ? stopCamera() : startCamera();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && running) stopCamera(); });

  /* ---------- 사진으로 찍기 ---------- */
  els.photo.addEventListener('change', async () => {
    const f = els.photo.files[0];
    els.photo.value = '';
    if (!f) return;
    setStatus('사진에서 바코드를 찾는 중…');
    try {
      const code = await decodeImageFile(f);
      if (code) onDetected(code);
      else setStatus('사진에서 바코드를 찾지 못했어요. 바코드가 크고 선명하게 나오도록 다시 찍어 주세요.', true);
    } catch {
      setStatus('사진을 읽지 못했어요.', true);
    }
  });

  async function decodeImageFile(file) {
    const img = await loadImage(file);
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    for (const max of [1600, 1000, 2400]) {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      if (nativeDetector) {
        try { const r = await nativeDetector.detect(c); if (r[0]) return r[0].rawValue; } catch { /* ZXing으로 */ }
      }
      const code = zxDecodeCanvas(c, true);
      if (code) return code;
    }
    return null;
  }

  /* ---------- 포장 사진으로 찾기 (영어 글자 인식) ----------
   * 폰에서 Tesseract로 영어 글자를 읽고, 데이터의 "영문명"과 가장 비슷한 상품 묶음을 찾음
   * 영문명 칸에는 "|"로 여러 이름(별칭)을 넣을 수 있음
   */
  const VENDOR = window.TESSERACT_BASE || new URL('vendor/tesseract/', location.href).href;
  let ocrWorker = null;
  async function getOcr(onProgress) {
    if (ocrWorker) return ocrWorker;
    if (!window.Tesseract) throw new Error('글자 인식 기능을 불러오지 못했어요');
    ocrWorker = window.Tesseract.createWorker('eng', 1, {
      workerPath: VENDOR + 'worker.min.js',
      corePath: VENDOR + 'core/',
      langPath: window.TESSERACT_LANG_PATH || VENDOR + 'lang',
      gzip: true,
      logger: (m) => onProgress && onProgress(m),
    }).then(async (w) => {
      if (window.OCR_PSM) await w.setParameters({ tessedit_pageseg_mode: String(window.OCR_PSM) });
      return w;
    }).catch((e) => { ocrWorker = null; throw e; });
    return ocrWorker;
  }

  function lev(a, b) {
    if (a === b) return 0;
    const v = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = v[0]; v[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const t = v[j];
        v[j] = Math.min(v[j] + 1, v[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = t;
      }
    }
    return v[b.length];
  }
  // 같은 뜻의 포장 문구를 하나로 (CANINE/DOGS → DOG, FELINE/CATS → CAT)
  const SYN = { DOGS: 'DOG', CANINE: 'DOG', PUPPIES: 'PUPPY', CATS: 'CAT', FELINE: 'CAT', KITTENS: 'KITTEN' };
  const tokens = (s) => normEn(s).split(' ').map((t) => SYN[t] || t).filter((t) => t.length >= 3 || /^\d+$/.test(t));

  // 사진에서 읽은 글자와 각 묶음의 영문명을 비교해 점수 순으로
  function matchGroups(text) {
    const seen = tokens(text);
    if (!seen.length) return [];
    // 글자가 띄어져 읽힌 경우(Nutri Source → NUTRISOURCE)도 맞추도록 붙인 낱말도 추가
    const raw = normEn(text).split(' ');
    for (let i = 0; i + 1 < raw.length; i++) if (raw[i].length >= 2 && raw[i + 1].length >= 2) seen.push(raw[i] + raw[i + 1]);
    const entries = [];
    for (const [key, list] of groups) {
      const en = list.find((p) => p.english);
      if (!en) continue;
      for (const alias of en.english.split('|')) {
        const t = [...new Set(tokens(alias))];
        if (t.length) entries.push({ key, list, t, brand: t[0] });
      }
    }
    // 여러 상품에 공통인 단어(브랜드명 등)는 덜 중요하게
    const df = new Map();
    for (const e of entries) for (const w of e.t) df.set(w, (df.get(w) || 0) + 1);
    const idf = (w) => Math.log(1 + entries.length / (df.get(w) || 1));
    const near = (w) => seen.some((s) => Math.abs(s.length - w.length) <= 2 && 1 - lev(s, w) / Math.max(s.length, w.length) >= 0.8);
    // 브랜드 글자(영문명 첫 단어)가 보이면 다른 브랜드 상품은 낮추기
    const brands = new Set(entries.map((e) => e.brand).filter(near));
    // 강아지/고양이가 한쪽만 보이면 반대쪽 상품은 낮추기
    const dog = near('DOG') || near('PUPPY'), cat = near('CAT') || near('KITTEN');
    const best = new Map();
    for (const e of entries) {
      let got = 0, total = 0;
      for (const w of e.t) {
        const weight = idf(w) * Math.min(w.length, 8);
        total += weight;
        let sim = 0;
        for (const s of seen) {
          if (Math.abs(s.length - w.length) > 3) continue;
          sim = Math.max(sim, 1 - lev(s, w) / Math.max(s.length, w.length));
          if (sim === 1) break;
        }
        if (sim >= 0.7) got += weight * sim;
      }
      let score = total ? got / total : 0;
      if (brands.size && !brands.has(e.brand)) score *= 0.6;
      const eDog = e.t.includes('DOG') || e.t.includes('PUPPY'), eCat = e.t.includes('CAT') || e.t.includes('KITTEN');
      if (dog && !cat && eCat && !eDog) score *= 0.7;
      if (cat && !dog && eDog && !eCat) score *= 0.7;
      if (score > (best.get(e.key)?.score || 0)) best.set(e.key, { score, list: e.list });
    }
    const ranked = [...best.values()].filter((x) => x.score >= 0.3).sort((a, b) => b.score - a.score);
    // 1등보다 많이 낮은 후보는 빼기
    return ranked.filter((x) => x.score >= ranked[0].score * 0.6).slice(0, 4);
  }

  async function prepareForOcr(file) {
    const img = await loadImage(file);
    // 큰 사진은 1600px로 줄이고, 작은 사진(인터넷 이미지 등)은 키워야 글자를 읽음
    const m = Math.max(img.width, img.height);
    const scale = m > 1600 ? 1600 / m : m < 1200 ? Math.min(4, 1400 / m) : 1;
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.filter = 'grayscale(1) contrast(1.3)';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  async function findByPhoto(file) {
    const all = [...groups.values()];
    if (!all.some((l) => l.some((p) => p.english || p.image))) {
      setStatus('아직 영문명이나 사진이 들어간 상품이 없어요. 데이터의 "영문명", "이미지" 칸을 채우면 사진으로 찾을 수 있어요.', true);
      return;
    }
    setStatus('포장 그림과 글자를 비교하는 중… (처음 한 번은 몇 초 걸려요)');
    try {
      const canvas = await prepareForOcr(file);
      const [vr, text] = await Promise.all([
        buildRefs().then(() => visualMatch(canvas, canvas.width, canvas.height)).catch(() => null),
        getOcr((m) => {
          if (m.status === 'recognizing text') setStatus(`포장 그림과 글자를 비교하는 중… ${Math.round(m.progress * 100)}%`);
        }).then((w) => w.recognize(canvas)).then((r) => r.data.text || '').catch(() => ''),
      ]);
      const vp = visualPick(vr, text);
      // 그림이 확실하거나, 그림이 어느 정도 맞고 글자도 그 상품을 가리키면 그림 결과로
      if (vp && (vp.sure || vp.inliers >= 15 || (vp.inliers >= 8 && vp.found.some((f) => f.score > 0)))) showPhotoResult(text, vp.found);
      else showPhotoResult(text);
    } catch (e) {
      setStatus(`사진을 읽지 못했어요. (${e && e.message ? e.message : e})`, true);
    }
  }

  function showPhotoResult(text, found = matchGroups(text)) {
    els.register.hidden = true;
    els.result.hidden = false;
    const raw = document.createElement('details');
    raw.className = 'ocr-text';
    raw.innerHTML = '<summary>사진에서 읽은 글자 보기</summary><pre></pre>';
    raw.querySelector('pre').textContent = text.trim() || '(읽은 글자 없음)';
    if (!found.length) {
      const box = document.createElement('div');
      box.className = 'notfound';
      box.innerHTML = '<strong>맞는 상품을 찾지 못했어요</strong><p class="hint">상품 이름(영어)이 크게 나오도록 가까이에서 다시 찍어 주세요. 바코드로 찾으면 더 정확해요.</p>';
      box.append(raw);
      els.result.replaceChildren(box);
      setStatus('맞는 상품을 찾지 못했어요.', true);
      return;
    }
    const render = (i) => {
      const extra = document.createElement('div');
      if (found.length > 1) {
        const alts = document.createElement('div');
        alts.className = 'alts';
        alts.innerHTML = '<h3>다른 상품일 수도 있어요</h3><ul></ul>';
        found.forEach((f, j) => {
          if (j === i) return;
          const li = document.createElement('li');
          const b = document.createElement('button'); b.type = 'button';
          b.textContent = baseOf(f.list[0]);
          b.addEventListener('click', () => render(j));
          li.append(b); alts.querySelector('ul').append(li);
        });
        extra.append(alts);
      }
      extra.append(raw);
      const list = found[i].list;
      renderGroup(list, list.length === 1 ? list[0] : null, extra);
    };
    render(0);
    els.result.dataset.score = found[0].score.toFixed(2);
    setStatus(found[0].list.length > 1 ? '상품을 찾았어요. 용량을 골라 주세요.' : '상품을 찾았어요.');
    feedback();
    els.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  els.packPhoto.addEventListener('change', () => {
    const f = els.packPhoto.files[0];
    els.packPhoto.value = '';
    if (f) findByPhoto(f);
  });

  /* ---------- 직접 입력 ---------- */
  els.manual.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = els.manualCode.value.replace(/\s+/g, '');
    if (!code) return;
    showResult(code);
    els.manualCode.blur();
  });

  /* ---------- 시작 ---------- */
  // 한 파일 미리보기(Claude 아티팩트 등)는 실시간 카메라가 막혀 있어 사진 촬영만 사용
  // 공개 공유용 미리보기는 글자 인식 파일을 싣지 않음
  if (window.PREVIEW_NO_OCR) { els.packPhoto.disabled = true; document.getElementById('packLabel').hidden = true; }
  if (window.PREVIEW_NO_LIVE_CAMERA) {
    els.btnCamera.hidden = true;
    document.querySelector('.actions').style.gridTemplateColumns = '1fr';
    setStatus('미리보기에서는 "사진으로 찍기"로 바코드를 찍어 주세요. 실시간 스캔은 웹에 올린 뒤 사용할 수 있어요.');
  }
  initNative();
  renderAdmin();
  loadProducts().then(renderHistory);
})();
