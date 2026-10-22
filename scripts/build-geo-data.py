"""
Geo 애드온 경계 데이터 생성 스크립트.

입력(직접 내려받아 같은 폴더에 둔다):
  - southkorea/southkorea-maps  kostat/2013/json/skorea_provinces_geo_simple.json
  - southkorea/southkorea-maps  kostat/2013/json/skorea_municipalities_geo_simple.json
  - nvkelso/natural-earth-vector geojson/ne_110m_admin_0_countries.geojson
출력: static/addons/geo/{world,kr-provinces,kr-municipalities}.json

사용: python3 scripts/build-geo-data.py <입력 폴더> <출력 폴더>
"""
import json, sys, os

src, out = sys.argv[1], sys.argv[2]

def rnd(v, d):
    return round(v, d)

def ring_area_centroid(ring):
    a = cx = cy = 0.0
    for i in range(len(ring) - 1):
        x0, y0 = ring[i]; x1, y1 = ring[i + 1]
        f = x0 * y1 - x1 * y0
        a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f
    if abs(a) < 1e-12:
        xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
        return 0.0, (sum(xs) / len(xs), sum(ys) / len(ys))
    return a / 2, (cx / (3 * a), cy / (3 * a))

def polygons(geom):
    if geom['type'] == 'Polygon':
        return [geom['coordinates']]
    return geom['coordinates']

def pack(geom, digits):
    polys, best, bbox = [], (0, None), [180, 90, -180, -90]
    for poly in polygons(geom):
        rings = []
        for ring in poly:
            flat, last = [], None
            for x, y in ring:
                p = (rnd(x, digits), rnd(y, digits))
                if p == last:
                    continue
                last = p
                flat += [p[0], p[1]]
                bbox = [min(bbox[0], p[0]), min(bbox[1], p[1]), max(bbox[2], p[0]), max(bbox[3], p[1])]
            if len(flat) >= 8:
                rings.append(flat)
        if rings:
            polys.append(rings)
            area, c = ring_area_centroid(poly[0])
            if abs(area) > best[0]:
                best = (abs(area), c)
    center = [rnd(best[1][0], 4), rnd(best[1][1], 4)]
    return polys, center, bbox

def write(name, meta, feats):
    with open(os.path.join(out, name), 'w', encoding='utf-8') as f:
        json.dump({**meta, 'features': feats}, f, ensure_ascii=False, separators=(',', ':'))

# ---------- 세계 국가 (Natural Earth 1:110m) ----------
ne = json.load(open(os.path.join(src, 'ne_110m_admin_0_countries.geojson'), encoding='utf-8'))['features']
world = []
for f in ne:
    p = f['properties']
    iso2 = p['ISO_A2'] if p['ISO_A2'] != '-99' else p.get('ISO_A2_EH', '-99')
    iso3 = p['ISO_A3'] if p['ISO_A3'] != '-99' else p.get('ADM0_A3')
    polys, center, bbox = pack(f['geometry'], 2)
    aliases = {p.get(k) for k in ('NAME', 'NAME_LONG', 'NAME_EN', 'NAME_KO', 'ADMIN', 'FORMAL_EN', 'NAME_SORT')}
    aliases |= {iso2 if iso2 != '-99' else None, iso3}
    world.append({'id': iso3, 'name': p.get('NAME_KO') or p['NAME'], 'nameEn': p['NAME'], 'iso2': iso2, 'iso3': iso3,
                  'aliases': sorted(a for a in aliases if a), 'center': center, 'bbox': bbox, 'polys': polys})
write('world.json', {'source': 'Natural Earth 1:110m Admin 0 Countries (public domain)', 'level': 0}, world)

# ---------- 대한민국 시·도 ----------
SHORT = {'11': ['서울', '서울시'], '21': ['부산', '부산시'], '22': ['대구', '대구시'], '23': ['인천', '인천시'], '24': ['광주', '광주시'],
         '25': ['대전', '대전시'], '26': ['울산', '울산시'], '29': ['세종', '세종시'], '31': ['경기'], '32': ['강원', '강원특별자치도'],
         '33': ['충북'], '34': ['충남'], '35': ['전북', '전북특별자치도'], '36': ['전남'], '37': ['경북'], '38': ['경남'], '39': ['제주', '제주도']}
pv = json.load(open(os.path.join(src, 'skorea_provinces_geo_simple.json'), encoding='utf-8'))['features']
prov_name = {}
provs = []
for f in pv:
    p = f['properties']
    polys, center, bbox = pack(f['geometry'], 4)
    prov_name[p['code']] = p['name']
    provs.append({'id': p['code'], 'name': p['name'], 'nameEn': p['name_eng'], 'aliases': sorted({p['name'], p['name_eng'], *SHORT.get(p['code'], [])}),
                  'center': center, 'bbox': bbox, 'polys': polys})
write('kr-provinces.json', {'source': '통계청 2013 행정구역 경계 (southkorea/southkorea-maps)', 'level': 1}, provs)

# ---------- 대한민국 시·군·구 ----------
mu = json.load(open(os.path.join(src, 'skorea_municipalities_geo_simple.json'), encoding='utf-8'))['features']
munis = []
for f in mu:
    p = f['properties']
    code, name = p['code'], p['name']
    pc = code[:2]
    polys, center, bbox = pack(f['geometry'], 4)
    names = {name}
    # '창원시진해구' → '창원시 진해구'
    if '시' in name[:-1] and name.endswith('구') and name.index('시') < len(name) - 2:
        i = name.index('시') + 1
        names.add(f'{name[:i]} {name[i:]}')
    aliases = set(names)
    for n in names:
        for pn in [prov_name[pc], *SHORT.get(pc, [])]:
            aliases.add(f'{pn} {n}')
    munis.append({'id': code, 'name': name, 'nameEn': p['name_eng'], 'parent': pc, 'parentName': prov_name[pc],
                  'aliases': sorted(aliases), 'center': center, 'bbox': bbox, 'polys': polys})
write('kr-municipalities.json', {'source': '통계청 2013 행정구역 경계 (southkorea/southkorea-maps)', 'level': 2}, munis)
print(len(world), len(provs), len(munis))
