/* 포장 그림으로 찾기 (외부 라이브러리 없이 직접 구현한 ORB 방식 특징점 비교)
 * 1) 상품 사진(기준)과 카메라 화면에서 모서리 같은 특징점(FAST)을 찾고
 * 2) 점마다 주변 밝기 패턴을 256비트 지문(회전 BRIEF)으로 만든 뒤
 * 3) 지문이 비슷한 점끼리 짝짓고, 짝들이 같은 위치/크기/회전 관계로 맞는지(RANSAC) 세어
 *    맞는 짝이 많은 상품 사진을 고름
 * 메시지: {type:'ref', id, w, h, gray} / {type:'match', req, w, h, gray}
 */
'use strict';

const PATCH = 15;          // 방향 계산 반지름
const MARGIN = 20;         // 가장자리 여백 (회전된 BRIEF 패턴이 들어갈 만큼)
const ANGLE_BINS = 30;

/* ---------- BRIEF 패턴 (고정 시드) ---------- */
let seed = 12345;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const clip = (x) => Math.max(-13, Math.min(13, Math.round(x)));
const PAIRS = [];
for (let i = 0; i < 256; i++) PAIRS.push([clip(gauss() * 6), clip(gauss() * 6), clip(gauss() * 6), clip(gauss() * 6)]);
// 각도 칸마다 회전한 패턴을 미리 계산
const ROT = [];
for (let b = 0; b < ANGLE_BINS; b++) {
  const a = (b / ANGLE_BINS) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
  ROT.push(PAIRS.map(([x1, y1, x2, y2]) => [
    Math.round(c * x1 - s * y1), Math.round(s * x1 + c * y1),
    Math.round(c * x2 - s * y2), Math.round(s * x2 + c * y2),
  ]));
}

/* ---------- 영상 처리 ---------- */
function resize(src, w, h, nw, nh) {
  const out = new Uint8Array(nw * nh);
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(h, Math.floor((y + 1) * sy) || y0 + 1);
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(w, Math.floor((x + 1) * sx) || x0 + 1);
      let sum = 0, n = 0;
      for (let yy = y0; yy < Math.max(y1, y0 + 1); yy++) for (let xx = x0; xx < Math.max(x1, x0 + 1); xx++) { sum += src[yy * w + xx]; n++; }
      out[y * nw + x] = sum / n;
    }
  }
  return out;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Uint8Array(w * h), k = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / k;
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / k;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// 밝기 차이를 키워 조명 영향 줄이기 (평균/표준편차 정규화)
function normalize(g) {
  let s = 0, s2 = 0;
  for (let i = 0; i < g.length; i++) { s += g[i]; s2 += g[i] * g[i]; }
  const m = s / g.length, sd = Math.sqrt(Math.max(1, s2 / g.length - m * m));
  const out = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = Math.max(0, Math.min(255, 128 + ((g[i] - m) / sd) * 50));
  return out;
}

/* ---------- FAST-9 ---------- */
const CIRCLE = [[0, -3], [1, -3], [2, -2], [3, -1], [3, 0], [3, 1], [2, 2], [1, 3], [0, 3], [-1, 3], [-2, 2], [-3, 1], [-3, 0], [-3, -1], [-2, -2], [-1, -3]];
function fast(img, w, h, t, maxN) {
  const off = CIRCLE.map(([dx, dy]) => dy * w + dx);
  const score = new Float32Array(w * h);
  const cand = [];
  const st = new Int8Array(16);
  for (let y = MARGIN; y < h - MARGIN; y++) {
    for (let x = MARGIN; x < w - MARGIN; x++) {
      const i = y * w + x, p = img[i], hi = p + t, lo = p - t;
      // 빠른 걸러내기: 위/오른쪽/아래/왼쪽 4점 중 3점 이상이 밝거나 어두워야 함
      const a = img[i + off[0]], b = img[i + off[4]], c = img[i + off[8]], d = img[i + off[12]];
      const nb = (a > hi) + (b > hi) + (c > hi) + (d > hi), nd = (a < lo) + (b < lo) + (c < lo) + (d < lo);
      if (nb < 3 && nd < 3) continue;
      let sum = 0;
      for (let k = 0; k < 16; k++) { const v = img[i + off[k]]; st[k] = v > hi ? 1 : v < lo ? -1 : 0; sum += Math.abs(v - p); }
      let best = 0, run = 0, prev = 0;
      for (let k = 0; k < 32; k++) {
        const s = st[k & 15];
        if (s !== 0 && s === prev) run++; else run = s !== 0 ? 1 : 0;
        prev = s;
        if (run > best) best = run;
      }
      if (best >= 9) { score[i] = sum; cand.push(i); }
    }
  }
  // 3x3 안에서 가장 강한 점만, 화면 전체에 고르게 퍼지도록 칸마다 개수 제한
  const pts = [];
  for (const i of cand) {
    const s = score[i];
    if (s < score[i - 1] || s < score[i + 1] || s < score[i - w] || s < score[i + w] ||
        s < score[i - w - 1] || s < score[i - w + 1] || s < score[i + w - 1] || s < score[i + w + 1]) continue;
    pts.push({ x: i % w, y: (i / w) | 0, s });
  }
  pts.sort((p, q) => q.s - p.s);
  const G = 6, cap = Math.ceil((maxN / (G * G)) * 2.5), cells = new Int32Array(G * G), keep = [];
  for (const p of pts) {
    const c = Math.min(G - 1, ((p.y / h) * G) | 0) * G + Math.min(G - 1, ((p.x / w) * G) | 0);
    if (cells[c] >= cap) continue;
    cells[c]++; keep.push(p);
    if (keep.length >= maxN) break;
  }
  return keep;
}

/* ---------- 방향 + 지문 ---------- */
function describe(img, w, h, pts, scale, out) {
  for (const p of pts) {
    let m01 = 0, m10 = 0;
    for (let dy = -PATCH; dy <= PATCH; dy++) {
      const r = Math.floor(Math.sqrt(PATCH * PATCH - dy * dy));
      const row = (p.y + dy) * w + p.x;
      for (let dx = -r; dx <= r; dx++) { const v = img[row + dx]; m10 += dx * v; m01 += dy * v; }
    }
    const ang = Math.atan2(m01, m10);
    const bin = ((Math.round((ang / (2 * Math.PI)) * ANGLE_BINS) % ANGLE_BINS) + ANGLE_BINS) % ANGLE_BINS;
    const pat = ROT[bin], d = new Uint32Array(8), base = p.y * w + p.x;
    for (let k = 0; k < 256; k++) {
      const q = pat[k];
      if (img[base + q[1] * w + q[0]] < img[base + q[3] * w + q[2]]) d[k >> 5] |= 1 << (k & 31);
    }
    out.push({ x: p.x / scale, y: p.y / scale, a: ang, sc: 1 / scale, d });
  }
}

function features(gray, w, h, longSide, levels, perLevel, t) {
  const base = longSide / Math.max(w, h);
  const out = [];
  for (const lv of levels) {
    const s = base * lv, nw = Math.round(w * s), nh = Math.round(h * s);
    if (nw < 2 * MARGIN + 10 || nh < 2 * MARGIN + 10) continue;
    let img = normalize(resize(gray, w, h, nw, nh));
    const pts = fast(img, nw, nh, t, perLevel);
    img = boxBlur(boxBlur(img, nw, nh, 2), nw, nh, 1);
    describe(img, nw, nh, pts, s, out);
  }
  return out;
}

/* ---------- 비교 ---------- */
function pop(x) { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }
function ham(a, b) { let n = 0; for (let k = 0; k < 8; k++) n += pop(a[k] ^ b[k]); return n; }

function matchRef(frame, ref) {
  const pairs = [];
  for (const f of frame) {
    let b1 = 999, b2 = 999, bi = -1;
    for (let j = 0; j < ref.length; j++) {
      const dd = ham(f.d, ref[j].d);
      if (dd < b1) { b2 = b1; b1 = dd; bi = j; } else if (dd < b2) b2 = dd;
    }
    if (b1 < 64 && b1 < 0.8 * b2) pairs.push([f, ref[bi]]);
  }
  return pairs;
}

// 2쌍으로 닮음 변환(위치/크기/회전)을 정하고, 그 변환에 맞는 쌍 수를 셈
function ransac(pairs, tol) {
  const n = pairs.length;
  if (n < 5) return 0;
  let best = 0;
  const iters = Math.min(300, (n * (n - 1)) / 2);
  for (let it = 0; it < iters; it++) {
    const i = (rand() * n) | 0; let j = (rand() * n) | 0;
    if (i === j) continue;
    const [f1, r1] = pairs[i], [f2, r2] = pairs[j];
    const rx = r2.x - r1.x, ry = r2.y - r1.y, fx = f2.x - f1.x, fy = f2.y - f1.y;
    const rl = rx * rx + ry * ry;
    if (rl < 25) continue;
    // 복소수 곱으로: f = z * r + t
    const zr = (fx * rx + fy * ry) / rl, zi = (fy * rx - fx * ry) / rl;
    const sc = Math.hypot(zr, zi);
    if (sc < 0.15 || sc > 6) continue;
    const tx = f1.x - (zr * r1.x - zi * r1.y), ty = f1.y - (zi * r1.x + zr * r1.y);
    const rot = Math.atan2(zi, zr);
    let inl = 0;
    for (const [f, r] of pairs) {
      const px = zr * r.x - zi * r.y + tx, py = zi * r.x + zr * r.y + ty;
      if ((px - f.x) ** 2 + (py - f.y) ** 2 > tol * tol) continue;
      // 점의 방향도 회전과 맞아야 함
      let da = Math.abs(((f.a - r.a - rot) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
      if (da < 0.6) inl++;
    }
    if (inl > best) best = inl;
  }
  return best;
}

const refs = new Map();
const FRAME_SIDE = 480;
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'clear') {
    refs.clear();
  } else if (m.type === 'ref') {
    refs.set(m.id, features(m.gray, m.w, m.h, 480, [1, 0.8, 0.64, 0.51, 0.41], 140, 18));
    self.postMessage({ type: 'ref-done', id: m.id, n: refs.get(m.id).length });
  } else if (m.type === 'match') {
    const t0 = Date.now();
    const frame = features(m.gray, m.w, m.h, FRAME_SIDE, [1, 0.8, 0.64], 260, 15);
    const results = [];
    for (const [id, ref] of refs) {
      const pairs = matchRef(frame, ref);
      results.push({ id, matches: pairs.length, inliers: ransac(pairs, 8) });
    }
    results.sort((a, b) => b.inliers - a.inliers);
    self.postMessage({ type: 'result', req: m.req, results: results.slice(0, 6), ms: Date.now() - t0, nf: frame.length });
  }
};
