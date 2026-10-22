/**
 * IndexedDB 저장소.
 *  - projects: 자동 저장된 워크플로와 사용자가 이름 붙여 저장한 워크플로
 *  - files: File 위젯이 불러온 로컬 파일 원문(새로고침 후 다시 선택하지 않아도 되도록)
 * IndexedDB를 쓸 수 없는 환경(시크릿 모드 등)에서는 조용히 메모리 저장소로 대체한다.
 */
const DB_NAME = 'grapefruit';
const DB_VERSION = 1;
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

export async function put(store: 'projects' | 'files', key: string, value: unknown): Promise<void> {
  memory.set(`${store}:${key}`, value);
  try { await tx(store, 'readwrite', (s) => s.put(value, key)); } catch (e) { console.warn('IndexedDB 저장 실패', e); }
}

export async function get<T>(store: 'projects' | 'files', key: string): Promise<T | undefined> {
  try {
    const v = await tx<T>(store, 'readonly', (s) => s.get(key) as IDBRequest<T>);
    if (v !== undefined) return v;
  } catch { /* 메모리로 대체 */ }
  return memory.get(`${store}:${key}`) as T | undefined;
}

export async function del(store: 'projects' | 'files', key: string): Promise<void> {
  memory.delete(`${store}:${key}`);
  try { await tx(store, 'readwrite', (s) => s.delete(key)); } catch { /* 무시 */ }
}

export async function keys(store: 'projects' | 'files'): Promise<string[]> {
  try {
    const k = await tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys());
    if (k) return k.map(String);
  } catch { /* 무시 */ }
  return [...memory.keys()].filter((k) => k.startsWith(`${store}:`)).map((k) => k.slice(store.length + 1));
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
