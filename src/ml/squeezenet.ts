/**
 * SqueezeNet 이미지 임베딩 — Orange Image Analytics의 로컬 "SqueezeNet" 임베더와 같은 계산.
 * 구조와 가중치: ndf 0.1.4 example_models.squeezenet (MIT, Primož Godec), include_softmax=False → 1000차원.
 * 전처리: orangecontrib.imageanalytics.squeezenet_model.SqueezenetModel.preprocess 를 그대로 따른다.
 *   원본 코드는 4차원 배열에 [:, :, 0] 인덱싱을 해서 색 채널이 아니라 "가로 0열과 2열"을 서로 바꾼다.
 *   Orange와 같은 값을 얻기 위해 이 동작도 똑같이 재현하고, RGB 순서 그대로 [104.006, 116.669, 122.679]를 뺀다.
 * 텐서 배치: HWC(높이 × 너비 × 채널) Float32Array, 커널: [kh, kw, in, out].
 */

export const SQUEEZENET_SIZE = 227;
export const SQUEEZENET_DIM = 1000;

export interface WeightIndex { tensors: Array<{ name: string; part: 'kernel' | 'bias'; shape: number[]; offset: number; length: number }> }

export interface SqueezeNetWeights { k: Map<string, { data: Float32Array; shape: number[] }>; b: Map<string, Float32Array> }

export function loadWeights(buf: ArrayBuffer, index: WeightIndex): SqueezeNetWeights {
  const all = new Float32Array(buf);
  const k = new Map<string, { data: Float32Array; shape: number[] }>();
  const b = new Map<string, Float32Array>();
  for (const t of index.tensors) {
    const data = all.subarray(t.offset, t.offset + t.length);
    if (t.part === 'kernel') k.set(t.name, { data, shape: t.shape }); else b.set(t.name, data);
  }
  return { k, b };
}

interface Tensor { d: Float32Array; h: number; w: number; c: number }

/** 합성곱(+ReLU). out이 주어지면 그 버퍼의 채널 오프셋 위치에 쓴다(fire 모듈 concat 용) */
function conv(x: Tensor, W: SqueezeNetWeights, name: string, stride: number, same: boolean, relu: boolean, out?: Tensor, chOffset = 0): Tensor {
  const { data: k, shape } = W.k.get(name)!;
  const bias = W.b.get(name)!;
  const [kh, kw, cin, cout] = shape;
  const outH = same ? Math.ceil(x.h / stride) : Math.floor((x.h - kh) / stride) + 1;
  const outW = same ? Math.ceil(x.w / stride) : Math.floor((x.w - kw) / stride) + 1;
  const padT = same ? Math.floor(Math.max((outH - 1) * stride + kh - x.h, 0) / 2) : 0;
  const padL = same ? Math.floor(Math.max((outW - 1) * stride + kw - x.w, 0) / 2) : 0;
  const o: Tensor = out ?? { d: new Float32Array(outH * outW * cout), h: outH, w: outW, c: cout };
  const oc = o.c;
  const acc = new Float32Array(cout);
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      acc.set(bias);
      for (let ky = 0; ky < kh; ky++) {
        const iy = oy * stride + ky - padT;
        if (iy < 0 || iy >= x.h) continue;
        for (let kx = 0; kx < kw; kx++) {
          const ix = ox * stride + kx - padL;
          if (ix < 0 || ix >= x.w) continue;
          const xo = (iy * x.w + ix) * cin;
          const ko = (ky * kw + kx) * cin * cout;
          for (let ci = 0; ci < cin; ci++) {
            const v = x.d[xo + ci];
            if (v === 0) continue;
            const kk = ko + ci * cout;
            for (let co = 0; co < cout; co++) acc[co] += v * k[kk + co];
          }
        }
      }
      const base = (oy * outW + ox) * oc + chOffset;
      if (relu) for (let co = 0; co < cout; co++) o.d[base + co] = acc[co] > 0 ? acc[co] : 0;
      else for (let co = 0; co < cout; co++) o.d[base + co] = acc[co];
    }
  }
  return o;
}

function maxPool(x: Tensor, f: number, s: number): Tensor {
  const oh = Math.floor((x.h - f) / s) + 1, ow = Math.floor((x.w - f) / s) + 1;
  const d = new Float32Array(oh * ow * x.c).fill(-Infinity);
  for (let oy = 0; oy < oh; oy++) for (let ox = 0; ox < ow; ox++) {
    const o = (oy * ow + ox) * x.c;
    for (let ky = 0; ky < f; ky++) for (let kx = 0; kx < f; kx++) {
      const i = ((oy * s + ky) * x.w + ox * s + kx) * x.c;
      for (let c = 0; c < x.c; c++) if (x.d[i + c] > d[o + c]) d[o + c] = x.d[i + c];
    }
  }
  return { d, h: oh, w: ow, c: x.c };
}

function fire(x: Tensor, W: SqueezeNetWeights, name: string): Tensor {
  const sq = conv(x, W, `${name}/squeeze1x1`, 1, true, true);
  const e1 = W.k.get(`${name}/expand1x1`)!.shape[3], e3 = W.k.get(`${name}/expand3x3`)!.shape[3];
  const out: Tensor = { d: new Float32Array(sq.h * sq.w * (e1 + e3)), h: sq.h, w: sq.w, c: e1 + e3 };
  conv(sq, W, `${name}/expand1x1`, 1, true, true, out, 0);
  conv(sq, W, `${name}/expand3x3`, 1, true, true, out, e1);
  return out;
}

/** Orange SqueezenetModel.preprocess 재현 (227×227×3 RGB 바이트 → 실수 텐서) */
export function preprocess(rgb: Uint8Array): Tensor {
  const S = SQUEEZENET_SIZE;
  const d = new Float32Array(S * S * 3);
  const mean = [104.006, 116.669, 122.679];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    // 원본 코드의 img_out[:, :, 0] = swap[:, :, 2] 등은 가로 0열 ↔ 2열 교환
    const sx = x === 0 ? 2 : x === 2 ? 0 : x;
    const si = (y * S + sx) * 3, di = (y * S + x) * 3;
    for (let c = 0; c < 3; c++) d[di + c] = rgb[si + c] - mean[c];
  }
  return { d, h: S, w: S, c: 3 };
}

/** 227×227 RGB 이미지 하나 → 1000차원 임베딩 */
export function embedSqueezeNet(W: SqueezeNetWeights, rgb: Uint8Array): Float32Array {
  let x = preprocess(rgb);
  x = conv(x, W, 'conv1', 2, true, true);
  x = maxPool(x, 3, 2);
  x = fire(x, W, 'fire2'); x = fire(x, W, 'fire3');
  x = maxPool(x, 3, 2);
  x = fire(x, W, 'fire4'); x = fire(x, W, 'fire5');
  x = maxPool(x, 3, 2);
  for (const n of ['fire6', 'fire7', 'fire8', 'fire9']) x = fire(x, W, n);
  x = conv(x, W, 'conv10', 1, false, false);
  // AveragePooling2D(13×13) + Flatten
  const out = new Float32Array(x.c);
  const n = x.h * x.w;
  for (let i = 0; i < n; i++) for (let c = 0; c < x.c; c++) out[c] += x.d[i * x.c + c];
  for (let c = 0; c < x.c; c++) out[c] /= n;
  return out;
}
