import { describe, it, expect } from 'vitest';
import { Workflow } from '../src/engine/workflow';
import { InlineCompute } from '../src/engine/compute';
import { registerWidget } from '../src/engine/registry';

let runs: string[] = [];
registerWidget({
  type: 'test.source', name: 'Source', category: 'data', abbr: 'S', description: '', inputs: [],
  outputs: [{ id: 'out', name: 'Data', type: 'Data', default: true }],
  defaultSettings: () => ({ value: 1 }),
  execute: (_i, s) => { runs.push('source'); return { outputs: { out: s.value } }; },
});
registerWidget({
  type: 'test.double', name: 'Double', category: 'transform', abbr: 'D', description: '',
  inputs: [{ id: 'in', name: 'Data', type: 'Data', default: true }],
  outputs: [{ id: 'out', name: 'Data', type: 'Data', default: true }],
  defaultSettings: () => ({ fail: false }),
  execute: (i, s) => {
    runs.push('double');
    if (s.fail) throw new Error('boom');
    return { outputs: { out: i.in === null ? null : (i.in as number) * 2 } };
  },
});
registerWidget({
  type: 'test.sum', name: 'Sum', category: 'evaluate', abbr: 'Σ', description: '',
  inputs: [{ id: 'many', name: 'Data', type: 'Data', multiple: true, default: true }],
  outputs: [{ id: 'out', name: 'Data', type: 'Data', default: true }],
  defaultSettings: () => ({}),
  execute: (i) => { runs.push('sum'); return { outputs: { out: (i.many as number[]).reduce((a, b) => a + b, 0) } }; },
});
registerWidget({
  type: 'test.learner', name: 'L', category: 'model', abbr: 'L', description: '', inputs: [],
  outputs: [{ id: 'learner', name: 'Learner', type: 'Learner', default: true }],
  defaultSettings: () => ({}), execute: () => ({ outputs: { learner: {} } }),
});

const idle = (wf: Workflow) => new Promise<void>((resolve) => {
  const check = () => (wf.isBusy() ? setTimeout(check, 5) : resolve());
  setTimeout(check, 5);
});

describe('workflow engine', () => {
  it('propagates data and re-runs only downstream nodes', async () => {
    const wf = new Workflow(new InlineCompute());
    const a = wf.addNode('test.source', 0, 0);
    const b = wf.addNode('test.double', 100, 0);
    const c = wf.addNode('test.double', 200, 0);
    wf.autoConnect(a.id, b.id); wf.autoConnect(b.id, c.id);
    await idle(wf);
    expect(wf.runtime.get(c.id)!.outputs.out).toBe(4);
    runs = [];
    wf.updateSettings(b.id, { fail: false });
    await idle(wf);
    expect(runs).toEqual(['double', 'double']); // source는 다시 실행되지 않음
    wf.updateSettings(a.id, { value: 5 });
    await idle(wf);
    expect(wf.runtime.get(c.id)!.outputs.out).toBe(20);
  });

  it('isolates errors', async () => {
    const wf = new Workflow(new InlineCompute());
    const a = wf.addNode('test.source', 0, 0);
    const b = wf.addNode('test.double', 100, 0, { fail: true });
    const c = wf.addNode('test.double', 200, 0);
    wf.autoConnect(a.id, b.id); wf.autoConnect(b.id, c.id);
    await idle(wf);
    expect(wf.runtime.get(b.id)!.status).toBe('error');
    expect(wf.runtime.get(b.id)!.message).toBe('boom');
    expect(wf.runtime.get(c.id)!.outputs.out).toBeNull();
    expect(wf.runtime.get(a.id)!.status).toBe('done');
  });

  it('rejects cycles and type mismatches, supports multiple inputs', async () => {
    const wf = new Workflow(new InlineCompute());
    const a = wf.addNode('test.source', 0, 0);
    const b = wf.addNode('test.double', 100, 0);
    const c = wf.addNode('test.double', 200, 0);
    wf.autoConnect(a.id, b.id); wf.autoConnect(b.id, c.id);
    expect(wf.canConnect(c.id, 'out', b.id, 'in')).toMatch(/순환/);
    const l = wf.addNode('test.learner', 0, 100);
    expect(typeof wf.autoConnect(l.id, b.id)).toBe('string');
    const s = wf.addNode('test.sum', 300, 0);
    wf.autoConnect(a.id, s.id); wf.autoConnect(b.id, s.id); wf.autoConnect(c.id, s.id);
    await idle(wf);
    expect(wf.runtime.get(s.id)!.outputs.out).toBe(1 + 2 + 4);
  });

  it('serializes and restores', async () => {
    const wf = new Workflow(new InlineCompute());
    const a = wf.addNode('test.source', 0, 0, { value: 3 });
    const b = wf.addNode('test.double', 100, 0);
    wf.autoConnect(a.id, b.id);
    const json = JSON.parse(JSON.stringify(wf.toJSON()));
    const wf2 = new Workflow(new InlineCompute());
    expect(wf2.load(json)).toEqual([]);
    await idle(wf2);
    expect(wf2.runtime.get(b.id)!.outputs.out).toBe(6);
  });
});
