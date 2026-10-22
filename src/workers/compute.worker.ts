/// <reference lib="webworker" />
import { TASKS } from './tasks';

interface Req { id: number; task: string; payload: unknown }

self.onmessage = async (ev: MessageEvent<Req>) => {
  const { id, task, payload } = ev.data;
  const fn = TASKS[task];
  if (!fn) { self.postMessage({ id, error: `알 수 없는 작업: ${task}` }); return; }
  try {
    let last = 0;
    const result = await fn(payload, (p) => {
      const now = Date.now();
      if (now - last > 100) { last = now; self.postMessage({ id, progress: p }); }
    }, { aborted: false });
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: (e as Error).message ?? String(e) });
  }
};
