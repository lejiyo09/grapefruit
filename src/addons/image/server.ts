/**
 * Orange 이미지 임베딩 서버 클라이언트 (Orange.misc.server_embedder.ServerEmbedderCommunicator 와 같은 요청).
 *   POST {서버}/image/{모델}?machine={기기 ID}&session={세션 ID}&retry={시도 횟수}
 *   본문: 모델 입력 크기로 줄인 JPEG, Content-Type: image/jpeg → 응답 {"embedding": [...]}
 * 기본 서버는 Orange와 같은 https://api.garaza.io/ (바이오랩, 류블랴나 대학교).
 *
 * 브라우저에서 다른 도메인으로 보내면 CORS에 막힐 수 있어, 다음 순서로 시도하고 성공한 주소를 기억한다.
 *   1) 사용자가 지정한 서버 주소
 *   2) 이 앱과 같은 주소의 /embed-api/ (Render 재작성 규칙·server.mjs·개발 서버가 api.garaza.io로 전달)
 *   3) https://api.garaza.io/ 직접
 */
export const ORANGE_EMBEDDING_SERVER = 'https://api.garaza.io/';
const TIMEOUT_MS = 180_000; // Orange: self.timeout = 180
const MAX_RETRIES = 3;
const PARALLEL = 6;

const LS_MACHINE = 'grapefruit.embedderMachineId';
const LS_ENDPOINT = 'grapefruit.embedderEndpoint';

function machineId(): string {
  try {
    let id = localStorage.getItem(LS_MACHINE);
    if (!id) { id = crypto.randomUUID?.() ?? String(Math.random()).slice(2); localStorage.setItem(LS_MACHINE, id); }
    return id;
  } catch { return 'grapefruit'; }
}
const sessionId = String(1 + Math.floor(Math.random() * 1e10));

export function candidateEndpoints(custom: string): string[] {
  const list: string[] = [];
  const norm = (u: string) => (u.endsWith('/') ? u : `${u}/`);
  if (custom.trim()) list.push(norm(custom.trim()));
  try { const saved = localStorage.getItem(LS_ENDPOINT); if (saved && !list.includes(saved)) list.push(saved); } catch { /* 무시 */ }
  const proxy = new URL('embed-api/', document.baseURI).href;
  for (const u of [proxy, ORANGE_EMBEDDING_SERVER]) if (!list.includes(u)) list.push(u);
  return list;
}

export class EmbeddingServerError extends Error {}

async function postOnce(base: string, model: string, jpeg: Blob, attempt: number, signal: AbortSignal): Promise<number[] | null> {
  const url = `${base}image/${model}?machine=${encodeURIComponent(machineId())}&session=${sessionId}&retry=${attempt}`;
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
  const sig = timeout && (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any ? (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([signal, timeout]) : signal;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg, signal: sig });
  if (!res.ok) throw new EmbeddingServerError(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim().startsWith('{')) throw new EmbeddingServerError('임베딩 서버가 아닌 곳에서 응답했습니다');
  const body = JSON.parse(text) as { embedding?: number[] | null };
  return Array.isArray(body.embedding) ? body.embedding : null;
}

/**
 * 여러 이미지를 서버로 보내 임베딩을 받는다. 결과 배열은 입력 순서와 같고, 실패한 이미지는 null.
 * 연결 자체가 안 되면(모든 주소 실패) EmbeddingServerError.
 */
export async function embedOnServer(
  model: string, jpegs: Blob[], custom: string, signal: AbortSignal, onDone: (i: number, e: number[] | null) => void,
): Promise<{ endpoint: string; results: Array<number[] | null> }> {
  const results: Array<number[] | null> = new Array(jpegs.length).fill(null);
  if (!jpegs.length) return { endpoint: '', results };
  // 첫 이미지로 쓸 수 있는 주소를 찾는다
  let endpoint = '';
  const errors: string[] = [];
  for (const base of candidateEndpoints(custom)) {
    try {
      results[0] = await postOnce(base, model, jpegs[0], 1, signal);
      endpoint = base;
      break;
    } catch (e) {
      if (signal.aborted) throw e;
      errors.push(`${base} → ${(e as Error).message || 'CORS 또는 네트워크 차단'}`);
    }
  }
  if (!endpoint) throw new EmbeddingServerError(`임베딩 서버에 연결하지 못했습니다.\n${errors.join('\n')}`);
  try { localStorage.setItem(LS_ENDPOINT, endpoint); } catch { /* 무시 */ }
  onDone(0, results[0]);
  // 나머지는 동시에 PARALLEL개씩, 실패하면 MAX_RETRIES번까지 다시 시도(Orange도 재시도)
  let next = 1;
  const worker = async () => {
    while (next < jpegs.length) {
      const i = next++;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (signal.aborted) throw new DOMException('취소됨', 'AbortError');
        try { results[i] = await postOnce(endpoint, model, jpegs[i], attempt, signal); break; } catch (e) {
          if (signal.aborted) throw e;
          if (attempt === MAX_RETRIES) results[i] = null;
        }
      }
      onDone(i, results[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, jpegs.length - 1) }, worker));
  return { endpoint, results };
}
