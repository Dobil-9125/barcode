/**
 * 바코드 조회 웹 · 관리자 연결용 Google Apps Script
 *
 * 상품 구글시트에 붙여서 웹 앱으로 배포하면
 *  - 누구나: 상품 목록 읽기 (GET)
 *  - 관리자 비밀번호를 아는 사람만: 상품 추가, 수정, 삭제, 사진 올리기 (POST)
 *
 * 설치 방법은 README.md의 "관리자 모드" 참고.
 * 비밀번호는 코드에 적지 않고 "프로젝트 설정 > 스크립트 속성"에 ADMIN_PIN으로 넣습니다.
 */

var SHEET_NAME = '';            // 비우면 첫 번째 시트
var PHOTO_FOLDER = '바코드조회 상품사진';

// 시트 첫 줄 제목 → 웹에서 쓰는 이름
var HEADERS = {
  '바코드': 'barcode', '상품명': 'name', '영문명': 'english',
  '가격': 'price', '이미지': 'image', '메모': 'memo', '용량': 'size'
};

function doGet() {
  return json_({ ok: true, products: readAll_() });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: '요청 형식이 잘못됐어요' }); }

  if (!checkPin_(req.pin)) return json_({ ok: false, error: '관리자 비밀번호가 맞지 않아요', code: 'bad_pin' });

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    switch (req.action) {
      case 'login':  return json_({ ok: true });
      case 'save':   return json_(save_(req.product || {}, req.originalBarcode));
      case 'delete': return json_(remove_(req.barcode));
      case 'photo':  return json_(photo_(req.dataUrl, req.barcode));
      default:       return json_({ ok: false, error: '알 수 없는 요청이에요' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 비밀번호 ---------- */
function checkPin_(pin) {
  var props = PropertiesService.getScriptProperties();
  var real = props.getProperty('ADMIN_PIN');
  if (!real) throw new Error('스크립트 속성에 ADMIN_PIN이 없어요');
  // 연속으로 틀리면 잠깐 막기 (10번 틀리면 10분)
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('fails') || 0);
  if (fails >= 10) { Utilities.sleep(1000); return false; }
  if (String(pin || '') === real) { cache.remove('fails'); return true; }
  cache.put('fails', String(fails + 1), 600);
  Utilities.sleep(1000);
  return false;
}

/* ---------- 시트 읽고 쓰기 ---------- */
function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
}

function columns_(sh) {
  var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
  var map = {};
  head.forEach(function (h, i) {
    var k = String(h).trim();
    if (k) map[HEADERS[k] || k] = i;
  });
  if (map.barcode === undefined) throw new Error('첫 줄에 "바코드" 열이 없어요');
  return { head: head, map: map };
}

// 숫자 바코드는 앞의 0을 떼고 비교
function key_(code) {
  var c = String(code == null ? '' : code).replace(/[\s-]+/g, '').replace(/^'/, '');
  return /^\d+$/.test(c) ? (c.replace(/^0+/, '') || '0') : c;
}

function readAll_() {
  var sh = sheet_();
  var cols = columns_(sh);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, cols.head.length).getDisplayValues();
  var out = [];
  rows.forEach(function (r) {
    var p = {};
    Object.keys(cols.map).forEach(function (k) {
      var v = String(r[cols.map[k]] || '').trim();
      if (v) p[k] = v;
    });
    if (p.barcode) out.push(p);
  });
  return out;
}

function findRow_(sh, cols, barcode) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var k = key_(barcode);
  var vals = sh.getRange(2, cols.map.barcode + 1, last - 1, 1).getDisplayValues();
  for (var i = 0; i < vals.length; i++) if (key_(vals[i][0]) === k) return i + 2;
  return -1;
}

function save_(p, originalBarcode) {
  var barcode = String(p.barcode || '').replace(/[\s-]+/g, '');
  if (!barcode) return { ok: false, error: '바코드를 입력해 주세요' };
  if (!String(p.name || '').trim()) return { ok: false, error: '상품명을 입력해 주세요' };
  var sh = sheet_();
  var cols = columns_(sh);

  // 없는 열(영문명 등)은 오른쪽에 새로 만들기
  ['name', 'english', 'price', 'image', 'memo'].forEach(function (k) {
    if (p[k] !== undefined && p[k] !== '' && cols.map[k] === undefined) {
      var title = Object.keys(HEADERS).filter(function (h) { return HEADERS[h] === k; })[0];
      sh.getRange(1, cols.head.length + 1).setValue(title);
      cols = columns_(sh);
    }
  });

  var row = findRow_(sh, cols, originalBarcode || barcode);
  var dup = findRow_(sh, cols, barcode);
  if (dup !== -1 && dup !== row) return { ok: false, error: '이미 등록된 바코드예요' };
  var created = row === -1;
  if (created) row = sh.getLastRow() + 1;

  var range = sh.getRange(row, 1, 1, cols.head.length);
  var values = created ? cols.head.map(function () { return ''; }) : range.getValues()[0];
  Object.keys(cols.map).forEach(function (k) {
    if (k === 'barcode') values[cols.map[k]] = barcode;
    else if (p[k] !== undefined) values[cols.map[k]] = String(p[k]).trim();
  });
  sh.getRange(row, cols.map.barcode + 1).setNumberFormat('@'); // 앞의 0이 지워지지 않게
  range.setValues([values]);
  return { ok: true, created: created };
}

function remove_(barcode) {
  var sh = sheet_();
  var row = findRow_(sh, columns_(sh), barcode);
  if (row === -1) return { ok: false, error: '시트에서 이 바코드를 찾지 못했어요' };
  sh.deleteRow(row);
  return { ok: true };
}

/* ---------- 사진: 구글 드라이브 폴더에 저장하고 주소 돌려주기 ---------- */
function photo_(dataUrl, barcode) {
  var m = String(dataUrl || '').match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (!m) return { ok: false, error: '사진 형식이 잘못됐어요' };
  var it = DriveApp.getFoldersByName(PHOTO_FOLDER);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER);
  var blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], (barcode || 'photo') + '-' + Date.now() + '.jpg');
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { ok: true, url: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w800' };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
