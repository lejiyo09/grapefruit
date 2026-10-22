import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { matchName, regionAt, findLatLon, type RegionSet } from '../src/addons/geo/regions';

const load = (f: string) => JSON.parse(readFileSync(`static/addons/geo/${f}`, 'utf8')) as RegionSet;
const world = load('world.json'), prov = load('kr-provinces.json'), muni = load('kr-municipalities.json');

describe('geocoding names', () => {
  it('countries by Korean/English name and ISO code', () => {
    for (const v of ['대한민국', 'South Korea', 'KR', 'KOR', 'france', 'FR', 'Japan']) expect(matchName(world, v).region, v).not.toBeNull();
    expect(matchName(world, '일본').region?.iso3).toBe('JPN');
  });
  it('provinces with short and renamed names', () => {
    expect(matchName(prov, '서울').region?.name).toBe('서울특별시');
    expect(matchName(prov, '충남').region?.name).toBe('충청남도');
    expect(matchName(prov, '강원특별자치도').region?.name).toBe('강원도');
    expect(matchName(prov, '전북특별자치도').region?.name).toBe('전라북도');
  });
  it('municipalities, suffix-less names and ambiguity', () => {
    expect(matchName(muni, '군산').region?.name).toBe('군산시');
    expect(matchName(muni, '충남 태안군').region?.name).toBe('태안군');
    expect(matchName(muni, '부산광역시 중구').region?.parentName).toBe('부산광역시');
    expect(matchName(muni, '창원시 의창구').region?.name).toBe('창원시의창구');
    const amb = matchName(muni, '중구');
    expect(amb.region).toBeNull();
    expect(amb.region === null && amb.reason).toBe('ambiguous');
  });
});

describe('point in region', () => {
  it('finds the region containing coordinates', () => {
    expect(regionAt(prov, 126.978, 37.566)?.name).toBe('서울특별시'); // 서울시청
    expect(regionAt(muni, 126.7369, 35.9676)?.name).toBe('군산시'); // 군산시청
    expect(regionAt(world, 2.35, 48.86)?.iso3).toBe('FRA'); // 파리
    expect(regionAt(prov, 0, 0)).toBeNull();
  });
});

describe('lat/lon detection (orange3-geo find_lat_lon)', () => {
  const col = (name: string, v: number[]) => ({ name, data: Float64Array.from(v) });
  it('by name, including Korean', () => {
    expect(findLatLon([col('x', [1]), col('위도', [36]), col('경도', [127])])).toEqual({ lat: '위도', lon: '경도' });
    expect(findLatLon([col('Latitude', [36]), col('lng', [127]), col('z', [1])])).toEqual({ lat: 'Latitude', lon: 'lng' });
  });
  it('by value range when exactly two', () => {
    expect(findLatLon([col('a', [127, 128]), col('b', [36, 37])])).toEqual({ lat: 'b', lon: 'a' });
  });
});
