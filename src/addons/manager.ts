/**
 * 애드온 관리자 (Orange의 Options → Add-ons에 해당).
 * 애드온은 기본 앱에 포함되지 않은 위젯 묶음이다. 설치하면 코드(별도 JS 조각)와 데이터 파일을 내려받아
 * 브라우저 캐시에 저장하고 위젯을 등록한다. 설치 목록은 이 브라우저(localStorage)에 기억된다.
 */
import { allWidgets, unregisterWidget } from '../engine/registry';
import { CATEGORIES } from '../engine/types';

export interface AddonModule {
  /** 위젯·카테고리를 등록한다 */
  register(): void;
}

export interface AddonInfo {
  id: string;
  name: string;
  description: string;
  /** 위젯 타입 접두어(예: 'geo.') — 프로젝트를 열 때 필요한 애드온을 찾는 데 쓴다 */
  prefix: string;
  widgets: string[];
  /** 설치 시 미리 받아 둘 데이터 파일(앱 기준 상대 경로) */
  assets: string[];
  /** 대략적인 내려받기 크기(압축 전송 기준) */
  size: string;
  credits: string;
  load(): Promise<AddonModule>;
}

export const ADDONS: AddonInfo[] = [
  {
    id: 'geo',
    name: 'Geo',
    description: '지리 데이터 시각화와 변환. 위도·경도를 지도에 표시하고, 지역 이름을 좌표로 바꾸고, 지역별 값을 색으로 칠합니다.',
    prefix: 'geo.',
    widgets: ['Geo Map', 'Choropleth Map', 'Geocoding'],
    assets: ['addons/geo/world.json', 'addons/geo/kr-provinces.json', 'addons/geo/kr-municipalities.json'],
    size: '약 170 KB',
    credits: '경계 데이터: Natural Earth(퍼블릭 도메인), 통계청 2013 행정구역(southkorea/southkorea-maps). 지도 타일: © OpenStreetMap contributors 외',
    load: () => import('./geo/index'),
  },
  {
    id: 'image',
    name: 'Image Analytics',
    description: '이미지 분류·군집을 위한 위젯. 폴더째 이미지를 불러오고, 심층 신경망(SqueezeNet)으로 이미지를 숫자 특징으로 바꿔(임베딩) Neural Network, Test and Score 등 일반 위젯으로 학습합니다.',
    prefix: 'image.',
    widgets: ['Import Images', 'Image Viewer', 'Image Embedding'],
    assets: ['addons/image/squeezenet.bin', 'addons/image/squeezenet.json'],
    size: '약 4.7 MB',
    credits: 'SqueezeNet 가중치: ndf 0.1.4 (MIT, Primož Godec) — Orange Image Analytics의 로컬 SqueezeNet과 같은 모델',
    load: () => import('./image/index'),
  },
];

const LS_KEY = 'grapefruit.addons';
const loaded = new Set<string>();
const listeners = new Set<() => void>();

function readInstalled(): string[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as string[]; } catch { return []; }
}
function writeInstalled(ids: string[]): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(ids)); } catch { /* 무시 */ }
}

export function onAddonsChange(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) fn(); }

export function isInstalled(id: string): boolean { return readInstalled().includes(id); }
export function isLoaded(id: string): boolean { return loaded.has(id); }

async function activate(a: AddonInfo): Promise<void> {
  if (loaded.has(a.id)) return;
  const mod = await a.load();
  if (!loaded.has(a.id)) { mod.register(); loaded.add(a.id); }
}

/** 설치: 코드와 데이터를 내려받고(서비스 워커가 캐시해 오프라인에서도 사용 가능) 위젯 등록 */
export async function install(id: string, onProgress?: (p: number) => void): Promise<void> {
  const a = ADDONS.find((x) => x.id === id);
  if (!a) throw new Error(`알 수 없는 애드온: ${id}`);
  onProgress?.(0.05);
  await activate(a);
  let done = 0;
  for (const path of a.assets) {
    const res = await fetch(new URL(path, document.baseURI), { cache: 'reload' });
    if (!res.ok) throw new Error(`데이터 파일을 받지 못했습니다 (HTTP ${res.status}): ${path}`);
    await res.arrayBuffer();
    onProgress?.(0.1 + (0.9 * ++done) / a.assets.length);
  }
  writeInstalled([...new Set([...readInstalled(), id])]);
  emit();
}

/** 제거: 캔버스에서 쓰고 있으면 거부 */
export function uninstall(id: string, usedTypes: Set<string>): void {
  const a = ADDONS.find((x) => x.id === id);
  if (!a) return;
  const inUse = [...usedTypes].filter((t) => t.startsWith(a.prefix));
  if (inUse.length) throw new Error(`캔버스에서 ${a.name} 위젯을 사용 중입니다. 해당 위젯을 지운 뒤 제거하세요.`);
  for (const w of allWidgets()) if (w.type.startsWith(a.prefix)) unregisterWidget(w.type);
  const ci = CATEGORIES.findIndex((c) => c.addon === id);
  if (ci >= 0) CATEGORIES.splice(ci, 1);
  loaded.delete(id);
  writeInstalled(readInstalled().filter((x) => x !== id));
  emit();
}

/** 앱 시작 시 설치된 애드온을 불러온다(실패해도 앱은 계속 동작) */
export async function loadInstalled(): Promise<string[]> {
  const errors: string[] = [];
  for (const id of readInstalled()) {
    const a = ADDONS.find((x) => x.id === id);
    if (!a) continue;
    try { await activate(a); } catch (e) { errors.push(`${a.name} 애드온을 불러오지 못했습니다: ${(e as Error).message}`); }
  }
  if (errors.length) emit();
  return errors;
}

/** 프로젝트에 있는 위젯 타입 중 설치되지 않은 애드온 */
export function missingAddons(types: string[]): AddonInfo[] {
  return ADDONS.filter((a) => !loaded.has(a.id) && types.some((t) => t.startsWith(a.prefix)));
}
