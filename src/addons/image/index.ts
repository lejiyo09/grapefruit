/**
 * Image Analytics 애드온 (orange3-imageanalytics에 해당): Import Images, Image Viewer, Image Embedding.
 * 카테고리 색은 orangecontrib/imageanalytics/widgets/__init__.py 의 BACKGROUND = "#F7F5A8".
 */
import { registerWidget } from '../../engine/registry';
import { registerCategory, type ViewApi } from '../../engine/types';
import { WorkerCompute } from '../../engine/compute';
import { type Table, type Column, allColumns, findColumn, takeRows, cellText, makeTable } from '../../core/table';
import { naturalCompare } from '../../core/io';
import { h, toast } from '../../ui/dom';
import { box, combo, note, slider, emptyMain, button, varCombo } from '../../ui/controls';
import { waiting, tableInput } from '../../widgets/common';
import type { PreparedImage } from '../../workers/tasks';
import { SQUEEZENET_DIM } from '../../ml/squeezenet';
import type { AddonModule } from '../manager';
import {
  type ImageItem, type ImageSet, REF_PREFIX, refOf, isImageRef, saveSet, loadSet, deleteSet, saveImage, loadImage,
  saveEmbedding, previewUrl, setKeyFor,
} from './store';

const IMAGE_EXT = /\.(jpe?g|png|bmp|gif|webp|tiff?|avif)$/i;
const PREVIEW_MAX = 320;

/** 이미지 참조가 들어 있는 열 찾기: 값이 img:// 또는 http(s)이거나 이미지 확장자인 문자열 열, 이름이 image면 우선 */
export function findImageColumn(t: Table, name = ''): Column | undefined {
  if (name) { const c = findColumn(t, name); if (c && c.variable.kind === 'string') return c; }
  const cands = allColumns(t).filter((c) => c.variable.kind === 'string').filter((c) => {
    const d = c.data as string[];
    const v = d.find((x) => x) ?? '';
    return isImageRef(v) || /^https?:\/\//.test(v) || IMAGE_EXT.test(v);
  });
  return cands.find((c) => c.variable.name.toLowerCase() === 'image') ?? cands[0];
}

/** varCombo는 라벨이 없으면 <select> 자체를, 있으면 감싼 요소를 돌려준다 */
const selectIn = (el: HTMLElement) => (el instanceof HTMLSelectElement ? el : el.querySelector('select'));

// ------------------------------------------------------------------ Import Images
interface ImportSettings { setKey: string; folder: string }

let importer: WorkerCompute | null = null;

/** 폴더(또는 여러 파일)를 읽어 저장소에 넣는다. 하위 폴더 이름 = 분류(category) */
async function importFiles(files: File[], onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<ImageSet> {
  const imgs = files.filter((f) => IMAGE_EXT.test(f.name));
  if (!imgs.length) throw new Error('선택한 곳에 이미지 파일(jpg, png, bmp, gif, webp 등)이 없습니다.');
  const rel = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
  const hasRoot = imgs.every((f) => rel(f).includes('/'));
  const folder = hasRoot ? rel(imgs[0]).split('/')[0] : '';
  const entries = imgs.map((f) => {
    const parts = rel(f).split('/');
    const inside = hasRoot ? parts.slice(1) : parts;
    return { file: f, path: inside.join('/'), category: inside.slice(0, -1).join('/') };
  }).sort((a, b) => naturalCompare(a.path, b.path));
  const key = await setKeyFor(entries.map((e) => ({ path: e.path, size: e.file.size })));
  const existing = await loadSet(key);
  if (existing && existing.items.length + existing.skipped.length === entries.length) return existing;
  importer ??= new WorkerCompute();
  const items: ImageItem[] = [];
  const skipped: string[] = [];
  let done = 0;
  for (const e of entries) {
    if (signal.aborted) throw new DOMException('취소됨', 'AbortError');
    try {
      // Orange(Pillow)는 EXIF 회전을 적용하지 않고 저장된 방향 그대로 읽는다
      const bitmap = await createImageBitmap(e.file, { imageOrientation: 'none' } as ImageBitmapOptions).catch(() => createImageBitmap(e.file));
      const r = await importer.run<PreparedImage>('prepImage', { bitmap, previewMax: PREVIEW_MAX }, signal);
      await saveImage(key, e.path, { preview: r.preview, px: r.px, width: r.width, height: r.height });
      items.push({ path: e.path, name: e.file.name.replace(/\.[^.]+$/, ''), category: e.category, size: e.file.size, width: r.width, height: r.height });
    } catch (err) {
      if (signal.aborted) throw err;
      console.warn(`이미지를 읽지 못했습니다: ${e.path}`, err);
      skipped.push(e.path);
    }
    onProgress(++done, entries.length);
  }
  const set: ImageSet = { key, folder, created: new Date().toISOString(), items, skipped };
  await saveSet(set);
  return set;
}

function setToTable(set: ImageSet): Table {
  const cats = [...new Set(set.items.map((i) => i.category).filter(Boolean))].sort(naturalCompare);
  const classVar: Column | null = cats.length
    ? { variable: { name: 'category', kind: 'discrete', values: cats }, data: Float64Array.from(set.items, (i) => (i.category ? cats.indexOf(i.category) : NaN)) }
    : null;
  const num = (name: string, f: (i: ImageItem) => number): Column => ({ variable: { name, kind: 'continuous', decimals: 0 }, data: Float64Array.from(set.items, f) });
  // Orange Import Images 출력: 목표 category, 메타 image name / image / size / width / height
  return makeTable(set.folder || 'images', [], classVar, [
    { variable: { name: 'image name', kind: 'string' }, data: set.items.map((i) => i.name) },
    { variable: { name: 'image', kind: 'string' }, data: set.items.map((i) => refOf(set.key, i.path)) },
    num('size', (i) => i.size), num('width', (i) => i.width), num('height', (i) => i.height),
  ]);
}

function registerImportImages() {
  registerWidget({
    type: 'image.import',
    name: 'Import Images',
    category: 'image',
    abbr: 'Imp',
    description: '이미지 폴더를 불러옵니다. 하위 폴더가 있으면 폴더 이름을 분류(category)로 씁니다.',
    keywords: ['image', 'folder', 'photo', '이미지', '사진', '폴더'],
    inputs: [],
    outputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
    windowSize: [520, 460],
    controlsOnly: true,
    defaultSettings: (): ImportSettings => ({ setKey: '', folder: '' }),
    async execute(_in, s: ImportSettings, ctx) {
      if (!s.setKey) return waiting(ctx, '이미지 폴더를 선택하세요.');
      const set = await loadSet(s.setKey);
      if (!set) throw new Error(`'${s.folder || '이미지'}' 폴더가 이 브라우저에 저장되어 있지 않습니다. 폴더를 다시 선택하세요.`);
      if (set.skipped.length) ctx.warn(`${set.skipped.length}개 파일은 이미지로 읽을 수 없어 건너뛰었습니다.`);
      return { outputs: { data: setToTable(set) }, view: set };
    },
    render({ controls }, api: ViewApi<ImportSettings>) {
      const set = api.view as ImageSet | null;
      const status = h('div', { class: 'info-text' });
      const bar = h('div', { class: 'addon-progress', hidden: true });
      let abort: AbortController | null = null;
      const cancel = button('취소', () => abort?.abort());
      cancel.hidden = true;
      const run = async (files: File[]) => {
        abort = new AbortController();
        bar.hidden = false; cancel.hidden = false;
        try {
          const res = await importFiles(files, (d, n) => { status.textContent = `불러오는 중… ${d} / ${n}`; bar.style.setProperty('--p', String(d / n)); }, abort.signal);
          api.update({ setKey: res.key, folder: res.folder });
          toast(`${res.items.length}개 이미지를 불러왔습니다.`, { kind: 'success' });
        } catch (e) {
          status.textContent = '';
          if ((e as Error).name !== 'AbortError') toast((e as Error).message, { kind: 'error' });
        } finally { bar.hidden = true; cancel.hidden = true; }
      };
      const dirInput = h('input', { type: 'file', multiple: true, style: 'display:none' });
      dirInput.setAttribute('webkitdirectory', '');
      dirInput.addEventListener('change', () => { if (dirInput.files?.length) void run([...dirInput.files]); dirInput.value = ''; });
      const fileInput = h('input', { type: 'file', multiple: true, accept: 'image/*', style: 'display:none' });
      fileInput.addEventListener('change', () => { if (fileInput.files?.length) void run([...fileInput.files]); fileInput.value = ''; });
      const cats = set ? new Set(set.items.map((i) => i.category).filter(Boolean)).size : 0;
      controls.appendChild(box('폴더',
        h('div', { class: 'ctl-file' }, h('span', { class: 'file-name' }, set?.folder || (api.settings.folder ? `${api.settings.folder} (다시 선택 필요)` : '선택된 폴더 없음')),
          button('📁 폴더 선택…', () => dirInput.click(), 'primary'), dirInput, fileInput),
        button('이미지 파일 여러 개 선택…', () => fileInput.click()),
        status, bar, cancel));
      controls.appendChild(box('정보',
        h('div', { class: 'info-text' }, set ? `${set.items.length} images / ${cats} categories` : '이미지 없음'),
        set?.skipped.length ? note(`읽지 못한 파일 ${set.skipped.length}개: ${set.skipped.slice(0, 5).join(', ')}${set.skipped.length > 5 ? ' …' : ''}`, 'warn') : null,
        note('하위 폴더가 있는 폴더를 고르면 각 폴더를 하나의 분류(category)로 인식합니다. 예: 훈련 폴더 / 건원릉정자각, 경원릉, …')));
      if (set) controls.appendChild(box('저장 공간', note('이미지는 이 브라우저에만 저장됩니다(원본 대신 미리보기와 227×227 축소본). 서버로 보내지 않습니다.'),
        button('이 브라우저에서 이 이미지 묶음 지우기', async () => {
          if (!confirm('저장된 이미지와 임베딩 캐시를 지울까요?')) return;
          await deleteSet(set.key); api.update({ setKey: '' });
        })));
    },
  });
}

// ------------------------------------------------------------------ Image Viewer
interface ViewerSettings { imageAttr: string; titleAttr: string; imageSize: number; selection: number[] }

function registerImageViewer() {
  registerWidget({
    type: 'image.viewer',
    name: 'Image Viewer',
    category: 'image',
    abbr: 'IV',
    description: '데이터가 가리키는 이미지를 격자로 보여줍니다. 이미지를 클릭해 고르면 Selected Images로 출력합니다.',
    keywords: ['image', 'gallery', 'thumbnail', '이미지', '사진'],
    inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
    outputs: [{ id: 'selected', name: 'Selected Images', type: 'Data', default: true }, { id: 'data', name: 'Data', type: 'Data' }],
    windowSize: [900, 620],
    // Orange 기본값: imageSize 100
    defaultSettings: (): ViewerSettings => ({ imageAttr: '', titleAttr: '', imageSize: 100, selection: [] }),
    execute(inputs, s: ViewerSettings, ctx) {
      const t = tableInput(inputs.data);
      if (!t) return waiting(ctx);
      if (!findImageColumn(t, s.imageAttr)) throw new Error('이미지 경로가 들어 있는 문자열 열이 없습니다. Import Images의 출력을 연결하세요.');
      const sel = s.selection.filter((i) => i < t.nRows);
      const flag = new Float64Array(t.nRows);
      for (const i of sel) flag[i] = 1;
      return { outputs: { selected: sel.length ? takeRows(t, sel) : null, data: { ...t, metas: [...t.metas, { variable: { name: 'Selected', kind: 'discrete', values: ['No', 'Yes'] }, data: flag }] } } };
    },
    render({ controls, main }, api: ViewApi<ViewerSettings>) {
      const t = tableInput(api.inputs.data);
      if (!t) { emptyMain(main, '입력 데이터가 없습니다.'); return; }
      const s = api.settings;
      const ic = findImageColumn(t, s.imageAttr);
      const titleCol = s.titleAttr ? findColumn(t, s.titleAttr) : t.classVar ?? t.metas.find((c) => c.variable.name === 'image name');
      const iEl = varCombo(api, 'imageAttr', null, t, (c) => c.variable.kind === 'string');
      { const sel = selectIn(iEl); if (ic && sel) sel.value = ic.variable.name; }
      const tEl = varCombo(api, 'titleAttr', null, t, () => true);
      { const sel = selectIn(tEl); if (titleCol && sel) sel.value = titleCol.variable.name; }
      tEl.addEventListener('change', () => api.rerender());
      controls.appendChild(box('이미지 파일 이름 열 (Image Filename Attribute)', iEl));
      controls.appendChild(box('제목 열 (Title Attribute)', tEl));
      controls.appendChild(box('이미지 크기 (Image Size)', slider(api, 'imageSize', '', 40, 320, 10, (v) => `${v}px`)));
      controls.appendChild(box('선택', h('div', { class: 'info-text' }, `${s.selection.length} / ${t.nRows}개 선택`), button('선택 해제', () => api.update({ selection: [] })),
        note('클릭: 선택, Ctrl/Shift+클릭: 추가')));
      if (!ic) { emptyMain(main, '이미지 열이 없습니다.'); return; }
      const sel = new Set(s.selection);
      const limit = Math.min(t.nRows, 3000);
      const grid = h('div', { class: 'img-grid', style: `--cell:${s.imageSize}px` });
      const scroller = h('div', { class: 'main-scroll' }, grid);
      main.appendChild(scroller);
      const obs = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const img = en.target as HTMLImageElement;
          obs.unobserve(img);
          void previewUrl(img.dataset.ref!).then((u) => { if (u) img.src = u; else img.classList.add('missing'); });
        }
      }, { root: scroller, rootMargin: '300px' });
      for (let i = 0; i < limit; i++) {
        const ref = (ic.data as string[])[i];
        const img = h('img', { alt: '', 'data-ref': ref, loading: 'lazy', decoding: 'async' });
        obs.observe(img);
        const cell = h('figure', { class: `img-cell${sel.has(i) ? ' sel' : ''}`, title: ref.startsWith(REF_PREFIX) ? ref.slice(ref.indexOf('/', REF_PREFIX.length) + 1) : ref },
          h('div', { class: 'img-box' }, img), h('figcaption', null, titleCol ? cellText(titleCol, i) : ''));
        cell.addEventListener('click', (ev) => {
          const next = ev.ctrlKey || ev.metaKey || ev.shiftKey ? new Set(s.selection) : new Set<number>();
          if (next.has(i) && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) next.delete(i); else next.add(i);
          api.update({ selection: [...next].sort((a, b) => a - b) });
        });
        grid.appendChild(cell);
      }
      if (t.nRows > limit) main.appendChild(note(`처음 ${limit}개만 표시합니다.`));
    },
  });
}

// ------------------------------------------------------------------ Image Embedding
/** Orange image_embedder.MODELS 순서. 로컬 계산은 SqueezeNet만 가능(나머지는 Orange도 바이오랩 서버에서 계산) */
const EMBEDDERS: Array<{ id: string; name: string; local: boolean; description: string }> = [
  { id: 'inception-v3', name: 'Inception v3', local: false, description: "Google's Inception v3 model trained on ImageNet." },
  { id: 'squeezenet', name: 'SqueezeNet (local)', local: true, description: 'Deep model for image recognition that achieves AlexNet-level accuracy on ImageNet with 50x fewer parameters.' },
  { id: 'vgg16', name: 'VGG-16', local: false, description: '16-layer image recognition model trained on ImageNet.' },
  { id: 'vgg19', name: 'VGG-19', local: false, description: '19-layer image recognition model trained on ImageNet.' },
  { id: 'painters', name: 'Painters', local: false, description: 'A model trained to predict painters from artwork images.' },
  { id: 'deeploc', name: 'DeepLoc', local: false, description: 'A model trained to analyze yeast cell images.' },
  { id: 'openface', name: 'openface', local: false, description: 'Face recognition model trained on FaceScrub and InstaFace datasets.' },
];

interface EmbedSettings { imageAttr: string; embedder: string }

function registerImageEmbedding() {
  registerWidget({
    type: 'image.embedding',
    name: 'Image Embedding',
    category: 'image',
    abbr: 'Emb',
    description: '심층 신경망으로 이미지의 특징을 숫자 벡터(n0, n1, …)로 바꿉니다. 이 벡터로 분류·군집 등 일반 머신러닝을 할 수 있습니다.',
    keywords: ['embedding', 'cnn', 'squeezenet', 'feature', '임베딩', '특징'],
    inputs: [{ id: 'images', name: 'Images', type: 'Data', default: true }],
    outputs: [{ id: 'embeddings', name: 'Embeddings', type: 'Data', default: true }, { id: 'skipped', name: 'Skipped Images', type: 'Data' }],
    windowSize: [480, 460],
    controlsOnly: true,
    defaultSettings: (): EmbedSettings => ({ imageAttr: '', embedder: 'squeezenet' }),
    async execute(inputs, s: EmbedSettings, ctx) {
      const t = tableInput(inputs.images);
      if (!t) return waiting(ctx, 'Import Images의 출력을 연결하세요.');
      const emb = EMBEDDERS.find((e) => e.id === s.embedder);
      if (!emb?.local) throw new Error(`${emb?.name ?? s.embedder}은(는) Orange에서도 바이오랩 서버로 이미지를 보내 계산하는 임베더라 이 앱에서는 쓸 수 없습니다. SqueezeNet (local)을 고르세요.`);
      const ic = findImageColumn(t, s.imageAttr);
      if (!ic) throw new Error('이미지 경로가 들어 있는 문자열 열이 없습니다.');
      const refs = ic.data as string[];
      const n = t.nRows;
      const out = new Array<Float32Array | null>(n).fill(null);
      const binUrl = new URL('addons/image/squeezenet.bin', document.baseURI).href;
      const indexUrl = new URL('addons/image/squeezenet.json', document.baseURI).href;
      // 1) 캐시 확인, 계산할 이미지 준비
      const todo: Array<{ rows: number[]; ref: string; px: Uint8Array }> = [];
      const byRef = new Map<string, number[]>();
      refs.forEach((r, i) => { if (r) { if (!byRef.has(r)) byRef.set(r, []); byRef.get(r)!.push(i); } });
      let k = 0;
      for (const [ref, rows] of byRef) {
        if (ctx.signal.aborted) throw new DOMException('취소됨', 'AbortError');
        let rec = await loadImage(ref);
        if (!rec && !isImageRef(ref) && /^https?:/.test(ref)) {
          try {
            const blob = await (await fetch(ref, { signal: ctx.signal })).blob();
            const p = await ctx.compute<PreparedImage>('prepImage', { bitmap: await createImageBitmap(blob), previewMax: PREVIEW_MAX });
            rec = { preview: p.preview, px: p.px, width: p.width, height: p.height };
          } catch (e) { if (ctx.signal.aborted) throw e; }
        }
        const cached = rec?.emb?.[emb.id];
        if (cached) for (const r of rows) out[r] = cached;
        else if (rec) todo.push({ rows, ref, px: rec.px });
        ctx.progress((0.05 * ++k) / byRef.size);
      }
      // 2) 묶음 단위로 Worker에서 계산(취소 가능), 결과는 이미지별로 캐시
      const B = 6;
      for (let i = 0; i < todo.length; i += B) {
        const chunk = todo.slice(i, i + B);
        const res = await ctx.compute<Float32Array[]>('embedSqueezeNet', { binUrl, indexUrl, images: chunk.map((c) => c.px) });
        for (let j = 0; j < chunk.length; j++) {
          for (const r of chunk[j].rows) out[r] = res[j];
          if (isImageRef(chunk[j].ref)) await saveEmbedding(chunk[j].ref, emb.id, res[j]);
        }
        ctx.progress(0.05 + (0.95 * Math.min(todo.length, i + B)) / todo.length);
      }
      const okRows: number[] = [], badRows: number[] = [];
      out.forEach((e, i) => (e ? okRows : badRows).push(i));
      if (badRows.length) ctx.warn(`${badRows.length}개 이미지를 읽지 못해 Skipped Images로 보냈습니다.`);
      if (!okRows.length) return { outputs: { embeddings: null, skipped: t } };
      const base = takeRows(t, okRows);
      const feats: Column[] = Array.from({ length: SQUEEZENET_DIM }, (_, f) => ({
        variable: { name: `n${f}`, kind: 'continuous' as const, decimals: 3 },
        data: Float64Array.from(okRows, (r) => out[r]![f]),
      }));
      ctx.info(`${okRows.length}개 이미지 임베딩 (${todo.length}개 새로 계산, ${okRows.length - todo.reduce((a, c) => a + c.rows.length, 0)}개 캐시)`);
      return {
        outputs: { embeddings: { ...base, attributes: [...base.attributes, ...feats] }, skipped: badRows.length ? takeRows(t, badRows) : null },
        view: { ok: okRows.length, computed: todo.length, skipped: badRows.length },
      };
    },
    render({ controls }, api: ViewApi<EmbedSettings>) {
      const t = tableInput(api.inputs.images);
      const ic = t ? findImageColumn(t, api.settings.imageAttr) : undefined;
      if (t) {
        const el = varCombo(api, 'imageAttr', '이미지 열', t, (c) => c.variable.kind === 'string');
        { const sel = selectIn(el); if (ic && sel) sel.value = ic.variable.name; }
        controls.appendChild(box('설정', el,
          combo(api, 'embedder', '임베더 (Embedder)', EMBEDDERS.map((e) => [e.id, e.local ? e.name : `${e.name} — 서버 필요`]))));
      } else controls.appendChild(box('설정', combo(api, 'embedder', '임베더 (Embedder)', EMBEDDERS.map((e) => [e.id, e.local ? e.name : `${e.name} — 서버 필요`]))));
      const e = EMBEDDERS.find((x) => x.id === api.settings.embedder);
      controls.appendChild(note(e?.description ?? ''));
      controls.appendChild(note('임베딩: 비정형 데이터(이미지)에서 특징을 뽑아 숫자 벡터로 만드는 것. SqueezeNet은 이미지마다 1000개의 특징(n0~n999)을 만듭니다. 계산은 이 기기에서 하며, 한 번 계산한 이미지는 저장해 두었다가 다시 씁니다.'));
      const v = api.view as { ok: number; computed: number; skipped: number } | null;
      if (v) controls.appendChild(box('결과', h('div', { class: 'info-text' }, `임베딩 ${v.ok}개 (새로 계산 ${v.computed}개) · 건너뜀 ${v.skipped}개`)));
      if (api.status === 'error') controls.appendChild(note(api.message, 'error'));
    },
  });
}

const module: AddonModule = {
  register() {
    registerCategory({ id: 'image', name: 'Image Analytics', color: '#F7F5A8', addon: 'image' });
    registerImportImages();
    registerImageViewer();
    registerImageEmbedding();
  },
};

export const register = module.register;
export default module;
