/**
 * Web Worker 계산 클라이언트.
 * - 저사양 기기를 위해 Worker는 하나만 사용하고 작업을 순서대로 처리한다.
 * - 취소하면 Worker를 종료(terminate)하고 새로 만든다. 계산 도중이어도 즉시 메모리가 해제된다.
 * - Worker를 만들 수 없는 환경에서는 메인 스레드에서 실행한다(폴백).
 */
import type { ComputeClient } from './types';
import { TASKS } from '../workers/tasks';

interface Pending {
  id: number;
  task: string;
  payload: unknown;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onProgress?: (p: number) => void;
  signal: AbortSignal;
}

export class WorkerCompute implements ComputeClient {
  private worker: Worker | null = null;
  private queue: Pending[] = [];
  private current: Pending | null = null;
  private seq = 0;
  private failed = false;

  private spawn(): Worker | null {
    if (this.failed) return null;
    try {
      const w = new Worker(new URL('../workers/compute.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => this.onMessage(ev.data);
      w.onerror = (ev) => {
        ev.preventDefault();
        const cur = this.current;
        this.current = null;
        this.worker?.terminate();
        this.worker = null;
        cur?.reject(new Error(`계산 Worker 오류: ${ev.message || '메모리 부족일 수 있습니다.'}`));
        this.next();
      };
      return w;
    } catch {
      this.failed = true;
      return null;
    }
  }

  run<T>(task: string, payload: unknown, signal: AbortSignal, onProgress?: (p: number) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException('취소됨', 'AbortError')); return; }
      const job: Pending = { id: ++this.seq, task, payload, resolve, reject, onProgress, signal };
      signal.addEventListener('abort', () => this.abort(job), { once: true });
      this.queue.push(job);
      this.next();
    });
  }

  private abort(job: Pending) {
    if (this.current === job) {
      this.worker?.terminate();
      this.worker = null;
      this.current = null;
      job.reject(new DOMException('취소됨', 'AbortError'));
      this.next();
    } else {
      const i = this.queue.indexOf(job);
      if (i >= 0) { this.queue.splice(i, 1); job.reject(new DOMException('취소됨', 'AbortError')); }
    }
  }

  private next() {
    if (this.current || !this.queue.length) return;
    const job = this.queue.shift()!;
    this.current = job;
    if (!this.worker) this.worker = this.spawn();
    if (!this.worker) {
      // 메인 스레드 폴백
      setTimeout(() => {
        try {
          const r = TASKS[job.task](job.payload, (p) => job.onProgress?.(p), job.signal);
          this.current = null; job.resolve(r);
        } catch (e) { this.current = null; job.reject(e as Error); }
        this.next();
      }, 0);
      return;
    }
    try {
      this.worker.postMessage({ id: job.id, task: job.task, payload: job.payload });
    } catch (e) {
      this.current = null;
      job.reject(new Error(`데이터를 계산 Worker로 보낼 수 없습니다: ${(e as Error).message}`));
      this.next();
    }
  }

  private onMessage(msg: { id: number; result?: unknown; error?: string; progress?: number }) {
    const job = this.current;
    if (!job || job.id !== msg.id) return;
    if (msg.progress !== undefined) { job.onProgress?.(msg.progress); return; }
    this.current = null;
    if (msg.error) job.reject(new Error(msg.error)); else job.resolve(msg.result);
    this.next();
  }
}

/** 테스트/노드 환경용: 메인 스레드에서 바로 실행 */
export class InlineCompute implements ComputeClient {
  async run<T>(task: string, payload: unknown, signal: AbortSignal, onProgress?: (p: number) => void): Promise<T> {
    const s = { get aborted() { return signal.aborted; } };
    return TASKS[task](payload, (p) => onProgress?.(p), s) as T;
  }
}
