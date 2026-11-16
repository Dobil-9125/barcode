// 모든 파일(CSS, JS, ZXing, products.csv 상품 데이터, 이미지)을 한 파일로 묶은 dist/preview.html 생성
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// products.csv 읽기 (따옴표 안의 쉼표, 줄바꿈 처리)
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}
const KEYS = { '바코드': 'barcode', '상품명': 'name', '영문명': 'english', '용량': 'size', '이미지': 'image', '가격': 'price', '메모': 'memo' };
const [head, ...rows] = parseCsv(read('products.csv'));
const keys = head.map((h) => KEYS[h.trim()] || h.trim());
const products = rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] || '').trim()]).filter(([, v]) => v !== ''))).map((p) => {
  if (p.image && !/^(https?:|data:)/.test(p.image) && existsSync(join(root, p.image))) {
    const mime = MIME[extname(p.image).toLowerCase()] || 'application/octet-stream';
    p = { ...p, image: `data:${mime};base64,${readFileSync(join(root, p.image)).toString('base64')}` };
  }
  return p;
});
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');

const html = read('index.html')
  .replace('<link rel="stylesheet" href="style.css">', () => `<style>\n${read('style.css')}</style>`)
  .replace('<script src="settings.js"></script>', '')
  .replace('<script src="vendor/tesseract/tesseract.min.js"></script>', '')
  .replace('<script src="vendor/zxing-0.21.3.min.js"></script>', () => `<script>${safe(read('vendor/zxing-0.21.3.min.js'))}</script>`)
  .replace('<script src="app.js"></script>', () =>
    `<script>window.PRODUCTS_INLINE = ${safe(JSON.stringify(products))};</script>\n<script>${safe(read('app.js'))}</script>`);

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/preview.html'), html);
// Claude 아티팩트용: 문서 껍데기 없이 본문만, 실시간 카메라 대신 사진 촬영 사용
// 공개 공유 검사를 위해 ZXing은 페이지에 넣지 않고 jsDelivr(npm)에서 불러옴
const ZXING_CDN = '<script src="https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js"></script>';
const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'))
  .replace(`<script>${safe(read('vendor/zxing-0.21.3.min.js'))}</script>`, () => ZXING_CDN)
  .replace('<script>window.PRODUCTS_INLINE', '<script>window.PREVIEW_NO_LIVE_CAMERA = true; window.PREVIEW_NO_OCR = true;</script>\n<script>window.PRODUCTS_INLINE');
const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>') + 8);
writeFileSync(join(root, 'dist/artifact.html'), `<title>바코드 조회</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n${style}\n${body}`);
const test = read('test-barcodes.html').replace('<script>', () => `<script>window.PRODUCTS_INLINE = ${safe(JSON.stringify(products.map(({ barcode, name }) => ({ barcode, name }))))};</script>\n<script>`);
writeFileSync(join(root, 'dist/test-barcodes.html'), test);
writeFileSync(join(root, 'dist/test-artifact.html'), '<title>테스트용 바코드</title>\n' + test.slice(test.indexOf('<style>'), test.indexOf('</head>')) + test.slice(test.indexOf('<body>') + 6, test.lastIndexOf('</body>')));
console.log(`dist/preview.html (${(html.length / 1024).toFixed(0)} KB, 상품 ${products.length}개)`);
