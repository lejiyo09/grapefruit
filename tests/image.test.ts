import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resizeLanczosRGB } from '../src/ml/resample';
import { loadWeights, embedSqueezeNet, type WeightIndex } from '../src/ml/squeezenet';

const fx = JSON.parse(readFileSync('tests/fixtures/lanczos.json', 'utf8'));
function synthetic(w: number, h: number): Uint8Array {
  const a = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    a[i] = (x * 7 + y * 3) % 256; a[i + 1] = (x * x + y) % 256; a[i + 2] = (x ^ y) & 255;
  }
  return a;
}

describe('Pillow LANCZOS resize', () => {
  const src = synthetic(fx.w, fx.h);
  it('matches PIL pixel for pixel (downscale)', () => {
    expect(Array.from(resizeLanczosRGB(src, fx.w, fx.h, 50, 40))).toEqual(fx.small);
    const big = resizeLanczosRGB(src, fx.w, fx.h, 227, 227);
    expect(Array.from(big.subarray(0, 60))).toEqual(fx.bigHead);
    expect(big.reduce((a, b) => a + b, 0)).toBe(fx.bigSum);
  });
  it('matches PIL when upscaling', () => {
    const crop = new Uint8Array(20 * 30 * 3);
    for (let y = 0; y < 30; y++) crop.set(src.subarray(y * fx.w * 3, y * fx.w * 3 + 60), y * 60);
    const up = resizeLanczosRGB(crop, 20, 30, 227, 227);
    expect(Array.from(up.subarray(0, 60))).toEqual(fx.upHead);
    expect(up.reduce((a, b) => a + b, 0)).toBe(fx.upSum);
  });
});

describe('SqueezeNet embedding (Orange local embedder)', () => {
  it('matches the NumPy reference', () => {
    const buf = readFileSync('static/addons/image/squeezenet.bin');
    const index = JSON.parse(readFileSync('static/addons/image/squeezenet.json', 'utf8')) as WeightIndex;
    const W = loadWeights(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), index);
    const rgb = new Uint8Array(readFileSync('tests/fixtures/book-227.rgb'));
    const t0 = performance.now();
    const e = embedSqueezeNet(W, rgb);
    const ms = performance.now() - t0;
    const ref = JSON.parse(readFileSync('tests/fixtures/book-squeezenet.json', 'utf8')).embedding as number[];
    expect(e.length).toBe(1000);
    let maxDiff = 0;
    for (let i = 0; i < 1000; i++) maxDiff = Math.max(maxDiff, Math.abs(e[i] - ref[i]));
    console.log(`squeezenet ${ms.toFixed(0)}ms, max |diff| = ${maxDiff.toExponential(2)}`);
    expect(maxDiff).toBeLessThan(1e-3);
  });
});
