/** 행정구역 경계 데이터: 불러오기, 이름 매칭(Geocoding), 좌표 → 지역(점-다각형 포함 판정) */

export type AdminLevel = 0 | 1 | 2;

export interface Region {
  id: string;
  name: string;
  nameEn: string;
  aliases: string[];
  parentName?: string;
  /** 국가 코드(세계 데이터만) */
  iso2?: string;
  iso3?: string;
  /** [경도, 위도] */
  center: [number, number];
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
  /** 다각형 목록 → 고리 목록(첫 고리가 바깥) → [lon, lat, lon, lat, …] */
  polys: number[][][];
}

export interface RegionSet {
  level: AdminLevel;
  source: string;
  features: Region[];
}

export const LEVELS: Array<{ level: AdminLevel; label: string; file: string; column: string }> = [
  { level: 0, label: '국가 (세계)', file: 'world.json', column: 'Country' },
  { level: 1, label: '대한민국 시·도', file: 'kr-provinces.json', column: '시·도' },
  { level: 2, label: '대한민국 시·군·구 (2013 경계)', file: 'kr-municipalities.json', column: '시·군·구' },
];

const cache = new Map<AdminLevel, Promise<RegionSet>>();

export function loadRegions(level: AdminLevel): Promise<RegionSet> {
  let p = cache.get(level);
  if (!p) {
    const file = LEVELS[level].file;
    p = fetch(new URL(`addons/geo/${file}`, document.baseURI)).then(async (res) => {
      if (!res.ok) throw new Error(`경계 데이터(${file})를 받지 못했습니다 (HTTP ${res.status}). 애드온을 다시 설치해 보세요.`);
      return (await res.json()) as RegionSet;
    });
    p.catch(() => cache.delete(level));
    cache.set(level, p);
  }
  return p;
}

// ---------------- 이름 매칭 ----------------

export function normalizeName(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[\s.,'’()\-_·]/g, '');
}

const AMBIGUOUS = Symbol('ambiguous');
type IndexValue = Region | typeof AMBIGUOUS;

const indexCache = new WeakMap<RegionSet, Map<string, IndexValue>>();

/** 정규화한 이름 → 지역. 둘 이상에 해당하는 이름(예: '중구')은 모호함으로 표시 */
export function nameIndex(set: RegionSet): Map<string, IndexValue> {
  let idx = indexCache.get(set);
  if (idx) return idx;
  idx = new Map();
  const add = (key: string, r: Region, weak: boolean) => {
    if (!key) return;
    const cur = idx!.get(key);
    if (cur === undefined) idx!.set(key, r);
    else if (cur !== r && !weak) idx!.set(key, AMBIGUOUS);
  };
  // 1) 공식 이름·별칭
  for (const r of set.features) for (const a of r.aliases) add(normalizeName(a), r, false);
  // 2) '군산시' → '군산', '태안군' → '태안' 처럼 행정 단위 접미사를 뗀 이름(이미 있는 이름은 덮어쓰지 않음)
  if (set.level >= 1) {
    const stripped = new Map<string, Region[]>();
    for (const r of set.features) {
      for (const a of r.aliases) {
        const m = /^(.{2,}?)(특별자치시|특별자치도|특별시|광역시|시|군|구|도)$/.exec(a.replace(/\s+/g, ''));
        if (!m) continue;
        const k = normalizeName(m[1]);
        if (!stripped.has(k)) stripped.set(k, []);
        if (!stripped.get(k)!.includes(r)) stripped.get(k)!.push(r);
      }
    }
    for (const [k, rs] of stripped) if (!idx.has(k)) idx.set(k, rs.length === 1 ? rs[0] : AMBIGUOUS);
  }
  indexCache.set(set, idx);
  return idx;
}

export type MatchResult = { region: Region } | { region: null; reason: 'unknown' | 'ambiguous' };

export function matchName(set: RegionSet, value: string): MatchResult {
  const v = nameIndex(set).get(normalizeName(value));
  if (v === undefined) return { region: null, reason: 'unknown' };
  if (v === AMBIGUOUS) return { region: null, reason: 'ambiguous' };
  return { region: v };
}

// ---------------- 좌표 → 지역 ----------------

function inRing(ring: number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function regionContains(r: Region, lon: number, lat: number): boolean {
  const [x0, y0, x1, y1] = r.bbox;
  if (lon < x0 || lon > x1 || lat < y0 || lat > y1) return false;
  for (const poly of r.polys) {
    if (!inRing(poly[0], lon, lat)) continue;
    let hole = false;
    for (let k = 1; k < poly.length; k++) if (inRing(poly[k], lon, lat)) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}

/** 좌표가 속한 지역. 경계 데이터가 단순화되어 해안선 바로 바깥 점은 가장 가까운 지역 중심(0.15° 이내)으로 보정 */
export function regionAt(set: RegionSet, lon: number, lat: number): Region | null {
  if (Number.isNaN(lon) || Number.isNaN(lat)) return null;
  for (const r of set.features) if (regionContains(r, lon, lat)) return r;
  const tol = set.level === 0 ? 1.5 : 0.15;
  let best: Region | null = null, bd = Infinity;
  for (const r of set.features) {
    const [x0, y0, x1, y1] = r.bbox;
    if (lon < x0 - tol || lon > x1 + tol || lat < y0 - tol || lat > y1 + tol) continue;
    const d = nearestVertexDist(r, lon, lat);
    if (d < bd) { bd = d; best = r; }
  }
  return bd <= tol ? best : null;
}

function nearestVertexDist(r: Region, lon: number, lat: number): number {
  let best = Infinity;
  for (const poly of r.polys) {
    const ring = poly[0];
    for (let i = 0; i < ring.length; i += 2) best = Math.min(best, Math.hypot(ring[i] - lon, ring[i + 1] - lat));
  }
  return best;
}

// ---------------- 위도/경도 열 찾기 (orangecontrib.geo.utils.find_lat_lon) ----------------

const LAT_NAMES = ['latitude', 'lat', '위도'];
const LON_NAMES = ['longitude', 'lng', 'long', 'lon', '경도'];

export function findLatLon(cols: Array<{ name: string; data: Float64Array }>): { lat: string; lon: string } | null {
  if (cols.length < 2) return null;
  const starts = (n: string, list: string[]) => list.some((p) => n.toLowerCase().startsWith(p));
  let lat = cols.find((c) => starts(c.name, LAT_NAMES));
  let lon = cols.find((c) => starts(c.name, LON_NAMES));
  if (lat && lon) return { lat: lat.name, lon: lon.name };
  const maxAbs = (c: { data: Float64Array }) => { let m = 0; for (const v of c.data) if (!Number.isNaN(v)) m = Math.max(m, Math.abs(v)); return m; };
  if (cols.length === 2) {
    if (lat) lon = cols[1 - cols.indexOf(lat)];
    else if (lon) lat = cols[1 - cols.indexOf(lon)];
    else {
      [lat, lon] = maxAbs(cols[1]) <= 90 && maxAbs(cols[0]) > 90 ? [cols[1], cols[0]] : [cols[0], cols[1]];
      if (maxAbs(lon) > 180) return { lat: cols[0].name, lon: cols[0].name };
    }
    return { lat: lat!.name, lon: lon!.name };
  }
  return { lat: cols[0].name, lon: cols[0].name };
}
