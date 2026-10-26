/**
 * IndexedDB 저장소.
 *  - projects: 자동 저장된 워크플로와 사용자가 이름 붙여 저장한 워크플로
 *  - files: File 위젯이 불러온 로컬 파일 원문(새로고침 후 다시 선택하지 않아도 되도록)
 * IndexedDB를 쓸 수 없는 환경(시크릿 모드 등)에서는 조용히 메모리 저장소로 대체한다.
 */
const DB_NAME = 'grapefruit';
const DB_VERSION = 2;
export type StoreName = 'projects' | 'files' | 'images' | 'imagesets';
export const MAX_STORED_FILE_BYTES = 30 * 1024 * 1024;

let dbPromise: Promise<IDBDatabase | null> | null = null;
const memory = new Map<string, unknown>();

function open(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects');
          if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
          // v2: Image Analytics 애드온(이미지 미리보기·227px 픽셀·임베딩 캐시, 이미지 묶음 목록)
          if (!db.objectStoreNames.contains('images')) db.createObjectStore('images');
          if (!db.objectStoreNames.contains('imagesets')) db.createObjectStore('imagesets');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return dbPromise;
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** IndexedDB에 저장. 쓸 수 없는 환경(시크릿 모드 등)이거나 저장에 실패하면 메모리에만 보관 */
export async function put(store: StoreName, key: string, value: unknown): Promise<void> {
  try {
    if ((await open()) && (await tx(store, 'readwrite', (s) => s.put(value, key))) !== undefined) { memory.delete(`${store}:${key}`); return; }
  } catch (e) { console.warn('IndexedDB 저장 실패', e); }
  memory.set(`${store}:${key}`, value);
}

export async function get<T>(store: StoreName, key: string): Promise<T | undefined> {
  try {
    const v = await tx<T>(store, 'readonly', (s) => s.get(key) as IDBRequest<T>);
    if (v !== undefined) return v;
  } catch { /* 메모리로 대체 */ }
  return memory.get(`${store}:${key}`) as T | undefined;
}

export async function del(store: StoreName, key: string): Promise<void> {
  memory.delete(`${store}:${key}`);
  try { await tx(store, 'readwrite', (s) => s.delete(key)); } catch { /* 무시 */ }
}

export async function keys(store: StoreName): Promise<string[]> {
  try {
    const k = await tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys());
    if (k) return [...new Set([...k.map(String), ...memoryKeys(store)])];
  } catch { /* 무시 */ }
  return memoryKeys(store);
}

function memoryKeys(store: StoreName): string[] {
  return [...memory.keys()].filter((k) => k.startsWith(`${store}:`)).map((k) => k.slice(store.length + 1));
}

/** key가 prefix로 시작하는 항목 삭제(이미지 묶음 지우기) */
export async function deletePrefix(store: StoreName, prefix: string): Promise<void> {
  for (const k of await keys(store)) if (k.startsWith(prefix)) await del(store, k);
}

export interface StoredFile { name: string; text: string; size: number; savedAt: string }

export async function hashText(text: string): Promise<string> {
  // 큰 파일 전체를 해시하지 않고 길이 + 앞/뒤 일부로 키를 만든다(메모리 절약)
  const sample = text.length + ':' + text.slice(0, 4096) + text.slice(-4096);
  if (crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(sample));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
  }
  let hsh = 0;
  for (let i = 0; i < sample.length; i++) hsh = (Math.imul(31, hsh) + sample.charCodeAt(i)) | 0;
  return `h${(hsh >>> 0).toString(16)}`;
}
