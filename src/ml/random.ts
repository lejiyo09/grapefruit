/** 재현 가능한 결과를 위한 시드 기반 난수 생성기 (mulberry32) */
export class Rng {
  private s: number;
  constructor(seed = 0) { this.s = seed >>> 0 || 0x9e3779b9; }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number { return Math.floor(this.next() * n); }
  normal(): number {
    const u = 1 - this.next(), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  shuffle<T>(a: T[] | Int32Array): void {
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
  }
}

export function range(n: number): Int32Array {
  const r = new Int32Array(n);
  for (let i = 0; i < n; i++) r[i] = i;
  return r;
}
