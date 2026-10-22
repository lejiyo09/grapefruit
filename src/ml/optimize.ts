/** 제한 메모리 BFGS. f(x, grad) 는 목적함수 값을 반환하고 grad에 기울기를 채운다. */
export function lbfgs(
  f: (x: Float64Array, g: Float64Array) => number,
  x0: Float64Array,
  opts: { maxIter?: number; m?: number; tol?: number; signal?: { aborted: boolean } } = {},
): Float64Array {
  const maxIter = opts.maxIter ?? 200;
  const m = opts.m ?? 7;
  const tol = opts.tol ?? 1e-6;
  const n = x0.length;
  let x = Float64Array.from(x0);
  let g = new Float64Array(n);
  let fx = f(x, g);
  const S: Float64Array[] = [];
  const Y: Float64Array[] = [];
  const rho: number[] = [];
  const dot = (a: Float64Array, b: Float64Array) => { let s = 0; for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; };

  for (let it = 0; it < maxIter; it++) {
    if (opts.signal?.aborted) throw new Error('취소됨');
    const gnorm = Math.sqrt(dot(g, g));
    if (gnorm < tol * Math.max(1, Math.sqrt(dot(x, x)))) break;
    // 2-loop recursion
    const q = Float64Array.from(g);
    const alpha: number[] = [];
    for (let k = S.length - 1; k >= 0; k--) {
      const a = rho[k] * dot(S[k], q);
      alpha[k] = a;
      for (let i = 0; i < n; i++) q[i] -= a * Y[k][i];
    }
    if (S.length) {
      const k = S.length - 1;
      const gamma = dot(S[k], Y[k]) / dot(Y[k], Y[k]);
      for (let i = 0; i < n; i++) q[i] *= gamma;
    } else {
      const s = 1 / Math.max(gnorm, 1e-12);
      for (let i = 0; i < n; i++) q[i] *= s;
    }
    for (let k = 0; k < S.length; k++) {
      const b = rho[k] * dot(Y[k], q);
      for (let i = 0; i < n; i++) q[i] += S[k][i] * (alpha[k] - b);
    }
    // 방향 d = -q, 백트래킹 라인서치(Armijo)
    let gd = -dot(g, q);
    if (gd >= 0) { for (let i = 0; i < n; i++) q[i] = g[i]; gd = -dot(g, g); S.length = 0; Y.length = 0; rho.length = 0; }
    let step = 1;
    const xn = new Float64Array(n);
    const gn = new Float64Array(n);
    let fn = Infinity;
    for (let ls = 0; ls < 40; ls++) {
      for (let i = 0; i < n; i++) xn[i] = x[i] - step * q[i];
      fn = f(xn, gn);
      if (fn <= fx + 1e-4 * step * gd) break;
      step *= 0.5;
    }
    if (!(fn < fx) && Math.abs(fn - fx) < 1e-14) break;
    const s = new Float64Array(n), y = new Float64Array(n);
    for (let i = 0; i < n; i++) { s[i] = xn[i] - x[i]; y[i] = gn[i] - g[i]; }
    const sy = dot(s, y);
    if (sy > 1e-12) {
      S.push(s); Y.push(y); rho.push(1 / sy);
      if (S.length > m) { S.shift(); Y.shift(); rho.shift(); }
    }
    const rel = Math.abs(fx - fn) / Math.max(1, Math.abs(fx));
    x = Float64Array.from(xn); g = Float64Array.from(gn); fx = fn;
    if (rel < 1e-10) break;
  }
  return x;
}

/** 대칭 행렬 고유분해(야코비). a는 d×d row-major. 고유값 내림차순 정렬 */
export function symmetricEigen(a: Float64Array, d: number): { values: Float64Array; vectors: Float64Array } {
  const A = Float64Array.from(a);
  const V = new Float64Array(d * d);
  for (let i = 0; i < d; i++) V[i * d + i] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < d; p++) for (let q = p + 1; q < d; q++) off += A[p * d + q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < d; p++) {
      for (let q = p + 1; q < d; q++) {
        const apq = A[p * d + q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (A[q * d + q] - A[p * d + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < d; k++) {
          const akp = A[k * d + p], akq = A[k * d + q];
          A[k * d + p] = c * akp - s * akq;
          A[k * d + q] = s * akp + c * akq;
        }
        for (let k = 0; k < d; k++) {
          const apk = A[p * d + k], aqk = A[q * d + k];
          A[p * d + k] = c * apk - s * aqk;
          A[q * d + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < d; k++) {
          const vkp = V[k * d + p], vkq = V[k * d + q];
          V[k * d + p] = c * vkp - s * vkq;
          V[k * d + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: d }, (_, i) => i).sort((i, j) => A[j * d + j] - A[i * d + i]);
  const values = Float64Array.from(order, (i) => A[i * d + i]);
  const vectors = new Float64Array(d * d); // 열 = 고유벡터
  order.forEach((src, dst) => { for (let k = 0; k < d; k++) vectors[k * d + dst] = V[k * d + src]; });
  return { values, vectors };
}

/** 대칭 양의 정부호 선형계 풀이(촐레스키). 실패 시 null */
export function choleskySolve(A: Float64Array, b: Float64Array, d: number): Float64Array | null {
  const L = new Float64Array(d * d);
  for (let i = 0; i < d; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * d + j];
      for (let k = 0; k < j; k++) s -= L[i * d + k] * L[j * d + k];
      if (i === j) { if (s <= 1e-12) return null; L[i * d + i] = Math.sqrt(s); } else L[i * d + j] = s / L[j * d + j];
    }
  }
  const z = new Float64Array(d);
  for (let i = 0; i < d; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * d + k] * z[k]; z[i] = s / L[i * d + i]; }
  const x = new Float64Array(d);
  for (let i = d - 1; i >= 0; i--) { let s = z[i]; for (let k = i + 1; k < d; k++) s -= L[k * d + i] * x[k]; x[i] = s / L[i * d + i]; }
  return x;
}
