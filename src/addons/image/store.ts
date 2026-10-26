/**
 * 가져온 이미지 저장소(IndexedDB).
 *  - imagesets[setKey]           : 묶음 목록(파일 이름·분류·크기 등)
 *  - images[setKey/경로]          : 미리보기 JPEG, 227×227 RGB 픽셀, 임베딩 캐시
 * 원본 파일은 저장하지 않는다(저사양 기기 저장 공간 보호). 대신 Orange와 같은 방식으로 줄인 픽셀을 저장해
 * 임베딩은 원본 없이도 다시 계산할 수 있다.
 * 데이터 테이블의 image 열에는 "img://<setKey>/<경로>" 형태의 참조 문자열이 들어간다.
 */
import * as db from '../../storage/db';

export interface ImageItem { path: string; name: string; category: string; size: number; width: number; height: number }
export interface ImageSet { key: string; folder: string; created: string; items: ImageItem[]; skipped: string[] }
export interface ImageRecord { preview: Blob; px: Uint8Array; width: number; height: number; emb?: Record<string, Float32Array> }

export const REF_PREFIX = 'img://';
export const refOf = (setKey: string, path: string) => `${REF_PREFIX}${setKey}/${path}`;
export const isImageRef = (v: string) => v.startsWith(REF_PREFIX);
const keyOfRef = (ref: string) => ref.slice(REF_PREFIX.length);

export async function saveSet(set: ImageSet): Promise<void> { await db.put('imagesets', set.key, set); }
export async function loadSet(key: string): Promise<ImageSet | undefined> { return db.get<ImageSet>('imagesets', key); }
export async function deleteSet(key: string): Promise<void> {
  await db.deletePrefix('images', `${key}/`);
  await db.del('imagesets', key);
}

export async function saveImage(setKey: string, path: string, rec: ImageRecord): Promise<void> {
  await db.put('images', `${setKey}/${path}`, rec);
}

export async function loadImage(ref: string): Promise<ImageRecord | undefined> {
  return isImageRef(ref) ? db.get<ImageRecord>('images', keyOfRef(ref)) : undefined;
}

export async function saveEmbedding(ref: string, embedder: string, e: Float32Array): Promise<void> {
  const rec = await loadImage(ref);
  if (!rec) return;
  rec.emb = { ...(rec.emb ?? {}), [embedder]: e };
  await db.put('images', keyOfRef(ref), rec);
}

// 미리보기 URL 캐시(창을 다시 그려도 같은 URL 재사용). 너무 많아지면 오래된 것부터 해제
const urlCache = new Map<string, string>();
const URL_CACHE_MAX = 600;

export async function previewUrl(ref: string): Promise<string | null> {
  if (!isImageRef(ref)) return /^(https?:|data:|blob:)/.test(ref) ? ref : null;
  const hit = urlCache.get(ref);
  if (hit) return hit;
  const rec = await loadImage(ref);
  if (!rec) return null;
  const url = URL.createObjectURL(rec.preview);
  urlCache.set(ref, url);
  if (urlCache.size > URL_CACHE_MAX) {
    const [k, u] = urlCache.entries().next().value!;
    URL.revokeObjectURL(u); urlCache.delete(k);
  }
  return url;
}

/** 파일 목록을 묶음 키로(같은 폴더를 다시 고르면 같은 키) */
export async function setKeyFor(files: Array<{ path: string; size: number }>): Promise<string> {
  return `s${(await db.hashText(files.map((f) => `${f.path}:${f.size}`).sort().join('\n'))).slice(0, 14)}`;
}
