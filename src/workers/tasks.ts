/**
 * Worker에서 실행되는 계산 작업 목록. 메인 스레드 폴백에서도 같은 함수를 사용한다.
 */
import type { Table } from '../core/table';
import { parseTable, type ColumnSpec } from '../core/io';
import { fit, predict, type LearnerSpec, type Model } from '../ml/models';
import { crossValidate, type Sampling } from '../ml/evaluate';
import { encode, fitEncoder } from '../ml/encode';
import { kmeans, silhouette, pca, computeDistances, hierarchical, type Metric, type Linkage, type DistMatrix } from '../ml/unsupervised';

import { resizeLanczosRGB, rgbaToRgb } from '../ml/resample';
import { loadWeights, embedSqueezeNet, SQUEEZENET_SIZE, type SqueezeNetWeights, type WeightIndex } from '../ml/squeezenet';

export type Progress = (p: number) => void;

let squeezeNet: { url: string; w: SqueezeNetWeights } | null = null;
async function squeezeNetWeights(binUrl: string, indexUrl: string): Promise<SqueezeNetWeights> {
  if (squeezeNet?.url === binUrl) return squeezeNet.w;
  const [b, i] = await Promise.all([fetch(binUrl), fetch(indexUrl)]);
  if (!b.ok || !i.ok) throw new Error('SqueezeNet 가중치를 불러오지 못했습니다. Image Analytics 애드온을 다시 설치해 보세요.');
  const w = loadWeights(await b.arrayBuffer(), (await i.json()) as WeightIndex);
  squeezeNet = { url: binUrl, w };
  return w;
}

export interface PreparedImage { px: Uint8Array; preview: Blob; width: number; height: number; jpeg: Record<number, Blob> }

/** 이미지 하나: Orange ImageLoader처럼 RGB로 바꾸고 227×227 LANCZOS로 줄인 픽셀 + 미리보기 JPEG */
/** RGB 바이트 → JPEG Blob (Pillow image.save(format="JPEG") 기본 품질 75) */
async function rgbToJpeg(rgb: Uint8Array, w: number, h: number): Promise<Blob> {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) { rgba[j] = rgb[i]; rgba[j + 1] = rgb[i + 1]; rgba[j + 2] = rgb[i + 2]; rgba[j + 3] = 255; }
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d')!.putImageData(new ImageData(rgba, w, h), 0, 0);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
}

async function prepImage(p: { bitmap: ImageBitmap; previewMax: number; serverSizes?: number[] }): Promise<PreparedImage> {
  const { bitmap } = p;
  const width = bitmap.width, height = bitmap.height;
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bitmap, 0, 0);
  const rgb = rgbaToRgb(g.getImageData(0, 0, width, height).data);
  const px = resizeLanczosRGB(rgb, width, height, SQUEEZENET_SIZE, SQUEEZENET_SIZE);
  const s = Math.min(1, p.previewMax / Math.max(width, height));
  const pw = Math.max(1, Math.round(width * s)), ph = Math.max(1, Math.round(height * s));
  const pc = new OffscreenCanvas(pw, ph);
  const pg = pc.getContext('2d')!;
  pg.imageSmoothingQuality = 'high';
  pg.drawImage(bitmap, 0, 0, pw, ph);
  bitmap.close();
  const preview = await pc.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  // 서버 임베더(Inception v3 등)로 보낼 JPEG: Orange ImageLoader.load_image_bytes 와 같이
  // 원본을 모델 입력 크기로 LANCZOS 축소한 뒤 JPEG 저장
  const jpeg: Record<number, Blob> = {};
  for (const size of p.serverSizes ?? []) jpeg[size] = await rgbToJpeg(size === SQUEEZENET_SIZE ? px : resizeLanczosRGB(rgb, width, height, size, size), size, size);
  return { px, preview, width, height, jpeg };
}
type Signal = { aborted: boolean };

export const TASKS: Record<string, (payload: any, progress: Progress, signal: Signal) => unknown> = {
  prepImage: (p: { bitmap: ImageBitmap; previewMax: number; serverSizes?: number[] }) => prepImage(p),
  embedSqueezeNet: async (p: { binUrl: string; indexUrl: string; images: Uint8Array[] }, progress, signal) => {
    const w = await squeezeNetWeights(p.binUrl, p.indexUrl);
    return p.images.map((img, i) => {
      if (signal.aborted) throw new Error('취소됨');
      const e = embedSqueezeNet(w, img);
      progress((i + 1) / p.images.length);
      return e;
    });
  },
  parse: (p: { text: string; name: string; overrides?: Record<string, Partial<ColumnSpec>> }) => parseTable(p.text, p.name, p.overrides),
  fit: (p: { learner: LearnerSpec; data: Table }, progress, signal) => fit(p.learner, p.data, { signal, onProgress: progress }),
  predict: (p: { model: Model; data: Table }) => predict(p.model, p.data),
  crossValidate: (p: { data: Table; learners: LearnerSpec[]; sampling: Sampling; testData?: Table | null }, progress, signal) =>
    crossValidate(p.data, p.learners, p.sampling, p.testData, progress, signal),
  kmeans: (p: { data: Table; k: number | [number, number]; normalize: boolean; nInit: number; maxIter: number; init: 'kmeans++' | 'random'; silhouetteLimit: number }, progress, signal) => {
    const m = encode(fitEncoder(p.data, p.normalize), p.data);
    if (!m.p) throw new Error('군집화할 수 있는 변수가 없습니다.');
    const kr = p.k;
    const ks = Array.isArray(kr) ? Array.from({ length: kr[1] - kr[0] + 1 }, (_, i) => kr[0] + i) : [kr];
    const runs = ks.map((k, i) => {
      const r = kmeans(m, k, { nInit: p.nInit, maxIter: p.maxIter, init: p.init, signal });
      const sil = m.n <= p.silhouetteLimit ? silhouette(m, r.labels, k) : null;
      progress((i + 1) / ks.length);
      return { k, labels: r.labels, inertia: r.inertia, silhouette: sil, meanSilhouette: sil ? sil.reduce((a, b) => a + b, 0) / sil.length : NaN };
    });
    return { runs };
  },
  pca: (p: { data: Table; normalize: boolean }) => {
    const { result, scores, n } = pca(p.data, p.normalize);
    return { result, scores, n };
  },
  distances: (p: { data: Table; metric: Metric; normalize: boolean; labels: string[] }, _pr, signal): DistMatrix => {
    const m = encode(fitEncoder(p.data, p.normalize), p.data);
    return computeDistances(m, p.metric, p.labels, signal);
  },
  hierarchical: (p: { dm: DistMatrix; linkage: Linkage }, _pr, signal) => hierarchical(p.dm, p.linkage, signal),
};
