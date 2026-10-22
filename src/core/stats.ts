/** 결측치(NaN)를 건너뛰는 기본 통계 함수 */

export function finiteValues(d: ArrayLike<number>): Float64Array {
  let n = 0;
  for (let i = 0; i < d.length; i++) if (!Number.isNaN(d[i])) n++;
  const out = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < d.length; i++) if (!Number.isNaN(d[i])) out[k++] = d[i];
  return out;
}

export function mean(d: ArrayLike<number>): number {
  let s = 0, n = 0;
  for (let i = 0; i < d.length; i++) { const v = d[i]; if (!Number.isNaN(v)) { s += v; n++; } }
  return n ? s / n : NaN;
}

/** 표본 분산(ddof=1이 아니라 Orange/numpy 기본처럼 ddof=0) */
export function variance(d: ArrayLike<number>, ddof = 0): number {
  const m = mean(d);
  let s = 0, n = 0;
  for (let i = 0; i < d.length; i++) { const v = d[i]; if (!Number.isNaN(v)) { s += (v - m) ** 2; n++; } }
  return n - ddof > 0 ? s / (n - ddof) : NaN;
}

export function std(d: ArrayLike<number>, ddof = 0): number {
  return Math.sqrt(variance(d, ddof));
}

export function minMax(d: ArrayLike<number>): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < d.length; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}

export function sortedFinite(d: ArrayLike<number>): Float64Array {
  return finiteValues(d).sort();
}

/** numpy 'linear' 방식 분위수 (정렬된 배열 입력) */
export function quantileSorted(s: Float64Array, q: number): number {
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function median(d: ArrayLike<number>): number {
  return quantileSorted(sortedFinite(d), 0.5);
}

export function countMissing(d: ArrayLike<number> | string[]): number {
  let n = 0;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    if (typeof v === 'number' ? Number.isNaN(v) : v === '') n++;
  }
  return n;
}

/** 분산 계수(Orange Feature Statistics의 Dispersion, 수치형) = std / |mean| */
export function coefficientOfVariation(d: ArrayLike<number>): number {
  const m = mean(d);
  return Math.abs(m) > 1e-12 ? std(d) / Math.abs(m) : NaN;
}

/** 범주형 엔트로피(Orange Feature Statistics의 Dispersion, 범주형) */
export function entropy(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return NaN;
  let h = 0;
  for (const c of counts) if (c > 0) { const p = c / total; h -= p * Math.log2(p); }
  return h;
}

export function pearson(x: ArrayLike<number>, y: ArrayLike<number>): number {
  let n = 0, sx = 0, sy = 0;
  for (let i = 0; i < x.length; i++) if (!Number.isNaN(x[i]) && !Number.isNaN(y[i])) { n++; sx += x[i]; sy += y[i]; }
  if (n < 2) return NaN;
  const mx = sx / n, my = sy / n;
  let cxy = 0, cxx = 0, cyy = 0;
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(x[i]) || Number.isNaN(y[i])) continue;
    const a = x[i] - mx, b = y[i] - my;
    cxy += a * b; cxx += a * a; cyy += b * b;
  }
  return cxx && cyy ? cxy / Math.sqrt(cxx * cyy) : NaN;
}

/** 동순위 평균 순위 */
export function ranks(d: ArrayLike<number>): Float64Array {
  const idx = Array.from({ length: d.length }, (_, i) => i).filter((i) => !Number.isNaN(d[i]));
  idx.sort((a, b) => d[a] - d[b]);
  const r = new Float64Array(d.length).fill(NaN);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && d[idx[j + 1]] === d[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]] = avg;
    i = j + 1;
  }
  return r;
}

export function spearman(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const keep: number[] = [];
  for (let i = 0; i < x.length; i++) if (!Number.isNaN(x[i]) && !Number.isNaN(y[i])) keep.push(i);
  const xs = Float64Array.from(keep, (i) => x[i]);
  const ys = Float64Array.from(keep, (i) => y[i]);
  return pearson(ranks(xs), ranks(ys));
}

/** 보기 좋은 축 눈금 */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo;
  const step0 = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(step0));
  const err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  return ticks;
}

export function formatNumber(x: number, digits = 3): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? '?' : String(x);
  if (Number.isInteger(x)) return String(x);
  const a = Math.abs(x);
  if (a >= 1e5 || a < 1e-3) return x.toExponential(2);
  return String(Number(x.toFixed(digits)));
}

// ---------------- 분포 함수 (Box Plot / Correlations의 검정 p-값) ----------------

function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const ci of c) ser += ci / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let hh = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; hh *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    hh *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return hh;
}

/** 정규화된 불완전 베타 함수 I_x(a, b) */
export function betainc(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** 정규화된 하부 불완전 감마 함수 P(a, x) */
export function gammainc(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 500; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 3e-14) break; }
    return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, hh = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    hh *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lgamma(a)) * hh;
}

/** 양측 t-검정 p-값 */
export function tTestP(t: number, df: number): number {
  if (!Number.isFinite(t)) return 0;
  return betainc(df / 2, 0.5, df / (df + t * t));
}

/** F 분포 상단 꼬리 확률 */
export function fTestP(f: number, d1: number, d2: number): number {
  if (!(f > 0)) return 1;
  return betainc(d2 / 2, d1 / 2, d2 / (d2 + d1 * f));
}

/** 카이제곱 상단 꼬리 확률 */
export function chi2P(x: number, df: number): number {
  if (!(x > 0)) return 1;
  return 1 - gammainc(df / 2, x / 2);
}

export function formatP(p: number): string {
  if (Number.isNaN(p)) return '?';
  return p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`;
}
