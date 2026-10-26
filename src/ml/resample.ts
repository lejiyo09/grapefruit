/**
 * Pillow의 Image.resize(size, LANCZOS)와 같은 결과를 내는 8비트 RGB 리사이즈.
 * Pillow src/libImaging/Resample.c 의 precompute_coeffs / normalize_coeffs_8bpc /
 * ImagingResampleHorizontal_8bpc / ImagingResampleVertical_8bpc 를 그대로 옮겼다.
 * (가로 → 세로 순서, 22비트 고정소수점, 반올림 오프셋, 0~255 자르기)
 * Orange Image Embedding은 이미지를 이렇게 227×227로 줄인 뒤 신경망에 넣는다.
 */

const PRECISION_BITS = 32 - 8 - 2;

function sinc(x: number): number {
  if (x === 0) return 1;
  x *= Math.PI;
  return Math.sin(x) / x;
}

function lanczos(x: number): number {
  return x >= -3 && x < 3 ? sinc(x) * sinc(x / 3) : 0;
}

interface Coeffs { ksize: number; bounds: Int32Array; kk: Int32Array }

function precompute(inSize: number, outSize: number): Coeffs {
  const scale = inSize / outSize;
  const filterscale = Math.max(1, scale);
  const support = 3 * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const pre = new Float64Array(outSize * ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const ss = 1 / filterscale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    let ww = 0;
    for (let x = 0; x < xmax; x++) {
      const w = lanczos((x + xmin - center + 0.5) * ss);
      pre[xx * ksize + x] = w;
      ww += w;
    }
    if (ww !== 0) for (let x = 0; x < xmax; x++) pre[xx * ksize + x] /= ww;
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  const kk = new Int32Array(outSize * ksize);
  const one = 1 << PRECISION_BITS;
  for (let i = 0; i < pre.length; i++) kk[i] = pre[i] < 0 ? Math.trunc(-0.5 + pre[i] * one) : Math.trunc(0.5 + pre[i] * one);
  return { ksize, bounds, kk };
}

const clip8 = (ss: number) => { const v = ss >> PRECISION_BITS; return v < 0 ? 0 : v > 255 ? 255 : v; };

/** src: RGB(채널 3개) 바이트 배열 → outW×outH RGB */
export function resizeLanczosRGB(src: Uint8Array | Uint8ClampedArray, w: number, h: number, outW: number, outH: number): Uint8Array {
  const half = 1 << (PRECISION_BITS - 1);
  // 가로
  let tmp: Uint8Array | Uint8ClampedArray = src;
  let tw = w;
  if (outW !== w) {
    const { ksize, bounds, kk } = precompute(w, outW);
    const out = new Uint8Array(outW * h * 3);
    for (let y = 0; y < h; y++) {
      const row = y * w * 3;
      for (let xx = 0; xx < outW; xx++) {
        const xmin = bounds[xx * 2], xmax = bounds[xx * 2 + 1], k = xx * ksize;
        let s0 = half, s1 = half, s2 = half;
        for (let x = 0; x < xmax; x++) {
          const p = row + (x + xmin) * 3, c = kk[k + x];
          s0 = (s0 + Math.imul(src[p], c)) | 0;
          s1 = (s1 + Math.imul(src[p + 1], c)) | 0;
          s2 = (s2 + Math.imul(src[p + 2], c)) | 0;
        }
        const o = (y * outW + xx) * 3;
        out[o] = clip8(s0); out[o + 1] = clip8(s1); out[o + 2] = clip8(s2);
      }
    }
    tmp = out;
    tw = outW;
  }
  if (outH === h) return tmp instanceof Uint8Array ? tmp : Uint8Array.from(tmp);
  // 세로
  const { ksize, bounds, kk } = precompute(h, outH);
  const out = new Uint8Array(tw * outH * 3);
  for (let yy = 0; yy < outH; yy++) {
    const ymin = bounds[yy * 2], ymax = bounds[yy * 2 + 1], k = yy * ksize;
    for (let x = 0; x < tw; x++) {
      let s0 = half, s1 = half, s2 = half;
      for (let y = 0; y < ymax; y++) {
        const p = ((y + ymin) * tw + x) * 3, c = kk[k + y];
        s0 = (s0 + Math.imul(tmp[p], c)) | 0;
        s1 = (s1 + Math.imul(tmp[p + 1], c)) | 0;
        s2 = (s2 + Math.imul(tmp[p + 2], c)) | 0;
      }
      const o = (yy * tw + x) * 3;
      out[o] = clip8(s0); out[o + 1] = clip8(s1); out[o + 2] = clip8(s2);
    }
  }
  return out;
}

/** 캔버스 RGBA → RGB (알파는 버림: Pillow convert('RGB')와 같음) */
export function rgbaToRgb(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const n = rgba.length / 4;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { out[i * 3] = rgba[i * 4]; out[i * 3 + 1] = rgba[i * 4 + 1]; out[i * 3 + 2] = rgba[i * 4 + 2]; }
  return out;
}
