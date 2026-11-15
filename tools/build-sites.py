# Builds the landing sites the app ships with: picks one landing point in each of NASA's 13 Artemis III candidate
# regions, cuts NASA elevation maps around every site, ray-casts each site's skyline from the finest data out to
# 300 km, and writes site/assets/sites/ plus the site list in site/lib/lunar.js.
#
# Landing point in a region: the sunniest 60 m spot in NASA's own sunlight map (Mazarico et al. 2011) whose ground,
# within 50 m, is at least 95 percent under 8 degrees of slope on NASA's 5 m map. Earth's share breaks ties.
# (Tried on 15 Nov 2026: the spot whose 3 x 3 NASA pixels are all sunny. It gave 26 to 32 points less sunlight at
# several regions and agreed with NASA's map at only 6 of 14 sites, against 13 of 14 for this rule.)
#
# Inputs (tools/.cache/, see each fetch step):
#   sfs/*_ELEV.tif        NASA 5 m shape-from-shading maps, 13 regions (tools/fetch-sfs.py)
#   maps/LDEM_80S_80M.IMG LOLA 80 m polar map (imbrium.mit.edu/DATA/LOLA_GDR/POLAR/IMG/)
#   maps/AVGVISIB_85S_060M_201608[_EARTH].IMG, AVGVISIB_75S_120M_201608[_EARTH].IMG  NASA sunlight and Earth-visibility
#                         shares, 60 m to about 85 S and 120 m to 75 S (imbrium.mit.edu/EXTRAS/ILLUMINATION/IMG/)
#   lroc/NAC_DTM_APOLLO11.TIF  LROC stereo terrain model of the Apollo 11 site, 2 m (pds.lroc.im-ldi.com)
#   USGS SLDEM2015 59 m and LOLA 118 m maps, read by HTTP range requests (rows cached in tools/.cache/rows/)
#
# Output, per site: <id>_block.bin.gz (44 km square for the main page), <id>_fine.bin.gz (5 m or 2 m, for the rover;
# only where such a map exists) and an entry in index.json with the skyline. Heights are stored as
# 1 + round((h - h0) / q) in uint16 (0 = no data), each row as differences from the previous pixel (mod 65536),
# low bytes then high bytes, gzipped.
#
# Run: python3 -m venv tools/.venv && tools/.venv/bin/pip install numpy tifffile imagecodecs
#      tools/.venv/bin/python tools/build-sites.py
# Written with Claude Code (an AI coding agent) at the team's direction. See README.md, "Use of AI".
import base64, glob, gzip, json, logging, math, os, re, struct, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np, tifffile

logging.disable(logging.WARNING)  # tifffile warns about the GDAL no-data tag of the 5 m maps
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE, OUT = os.path.join(ROOT, 'tools', '.cache'), os.path.join(ROOT, 'site', 'assets', 'sites')
os.makedirs(OUT, exist_ok=True); os.makedirs(os.path.join(CACHE, 'rows'), exist_ok=True)
R = 1737400.0
EYE = 2.0            # skyline seen from 2 m above the ground, a lander's or rover's camera height
BLOCK_KM = 44        # the main page draws a 40 km block; 2 km spare on each side
FINE_KM = 10         # rover driving square on the 5 m maps
SLOPE_MAX, FLAT_SHARE, FLAT_RADIUS_M = 8.0, 0.95, 50

# ---------- map grids ----------
class Grid:
    """Heights (m above the 1737.4 km sphere), NaN where there is no data.
    proj 'sps': polar stereographic about the south pole, longitude 0 up. x0, y0: centre of pixel (0, 0) in metres;
    x grows with the column, y falls with the row. proj 'eqc': x0, y0 are longitude and latitude (deg) of pixel
    (0, 0)'s centre, dx and dy degrees per pixel."""
    def __init__(s, h, proj, x0, y0, dx, dy=None, wrap=False, scale=None):
        s.h, s.proj, s.x0, s.y0, s.dx, s.dy, s.wrap = h, proj, x0, y0, dx, dy or dx, wrap
        s.scale = scale or (dx if proj == 'sps' else R * math.radians(dx))
    def ij(s, vx, vy, vz):
        if s.proj == 'sps':
            k = 2 * R / (1 - vy); return (-vz * k - s.x0) / s.dx, (s.y0 - vx * k) / s.dy
        lon, lat = np.degrees(np.arctan2(-vz, vx)), np.degrees(np.arcsin(np.clip(vy, -1, 1)))
        lon = (lon - s.x0 + 180) % 360 - 180 + s.x0 if not s.wrap else lon
        return (lon - s.x0) / s.dx, (s.y0 - lat) / s.dy
    def sample(s, vx, vy, vz):
        fi, fj = s.ij(vx, vy, vz); hh, ww = s.h.shape
        if s.wrap: fi = fi % ww
        ok = (fi >= 0) & (fj >= 0) & (fi <= ww - 1.001 if not s.wrap else True) & (fj <= hh - 1.001)
        fi, fj = np.where(ok, fi, 0), np.where(ok, fj, 0)
        i0, j0 = np.floor(fi).astype(np.int64), np.floor(fj).astype(np.int64); tx, ty = fi - i0, fj - j0
        i1 = (i0 + 1) % ww if s.wrap else i0 + 1
        h = s.h
        v = (h[j0, i0] * (1 - tx) + h[j0, i1] * tx) * (1 - ty) + (h[j0 + 1, i0] * (1 - tx) + h[j0 + 1, i1] * tx) * ty
        return np.where(ok, v, np.nan)

def chain(grids, vx, vy, vz):
    out = np.full(np.shape(vx), np.nan)
    for g in grids:
        m = np.isnan(out)
        if not m.any(): break
        out[m] = g.sample(vx[m], vy[m], vz[m])
    return out

def unit(lat, lon):
    a, b = math.radians(lat), math.radians(lon)
    return np.array([math.cos(a) * math.cos(b), math.sin(a), -math.cos(a) * math.sin(b)])
def stereo(lat, lon):
    rho = 2 * R * math.tan(math.radians(90 + lat) / 2); return rho * math.sin(math.radians(lon)), rho * math.cos(math.radians(lon))
def inv_stereo(x, y):
    return -90 + 2 * math.degrees(math.atan(math.hypot(x, y) / (2 * R))), math.degrees(math.atan2(x, y))

# ---------- data on disk ----------
def pds_polar(path, n, offset, scale, dtype='<i2', mult=0.5):
    a = np.memmap(path, dtype=dtype, mode='r', shape=(n, n))
    return a, Grid(None, 'sps', -offset * scale, offset * scale, scale)

lola80_raw, LOLA80 = pds_polar(os.path.join(CACHE, 'maps', 'LDEM_80S_80M.IMG'), 7600, 3799.5, 80)
LOLA80.h = lola80_raw.astype(np.float32) * 0.5
u = np.fromfile(os.path.join(ROOT, 'site', 'assets', 'south_pole_625m.u16'), '<u2').reshape(1024, 1024)
POLAR625 = Grid((u.astype(np.float32) - 20000) / 2, 'sps', -319687.5, 319687.5, 625)
u = np.fromfile(os.path.join(ROOT, 'site', 'assets', 'moon_height_8ppd.u16'), '<u2').reshape(1440, 2880)
GLOBAL8 = Grid((u.astype(np.float32) - 20000) / 2, 'eqc', -180 + 0.5 / 8, 90 - 0.5 / 8, 1 / 8, wrap=True)
sun_raw, SUN = pds_polar(os.path.join(CACHE, 'maps', 'AVGVISIB_85S_060M_201608.IMG'), 5058, 2528.5, 60)
earth_raw, EARTH = pds_polar(os.path.join(CACHE, 'maps', 'AVGVISIB_85S_060M_201608_EARTH.IMG'), 5058, 2528.5, 60)
SUN.h = sun_raw.astype(np.float32) * 0.00004; EARTH.h = earth_raw.astype(np.float32) * 0.00004
# the 60 m maps reach only about 85 S; the 120 m maps reach 75 S
sun120_raw, SUN120 = pds_polar(os.path.join(CACHE, 'maps', 'AVGVISIB_75S_120M_201608.IMG'), 7624, 3811.5, 120)
earth120_raw, EARTH120 = pds_polar(os.path.join(CACHE, 'maps', 'AVGVISIB_75S_120M_201608_EARTH.IMG'), 7624, 3811.5, 120)
SUN120.h = sun120_raw; EARTH120.h = earth120_raw  # DN, scaled on read

def nasa_at(maps, X, Y):
    """NASA's share at stereographic X, Y (m): the pixel holding the point, from the finest map that has it."""
    X, Y = np.asarray(X, float), np.asarray(Y, float); out = np.full(X.shape, np.nan)
    for g in maps:
        i, j = np.rint((X - g.x0) / g.dx).astype(np.int64), np.rint((g.y0 - Y) / g.dx).astype(np.int64)
        ok = np.isnan(out) & (i >= 0) & (j >= 0) & (i < g.h.shape[1]) & (j < g.h.shape[0])
        out[ok] = g.h[j[ok], i[ok]] * (0.00004 if g.h.dtype != np.float32 else 1)
    return out
SUNS, EARTHS = [SUN, SUN120], [EARTH, EARTH120]
def nasa_share(maps, lat, lon):
    x, y = stereo(lat, lon); return float(nasa_at(maps, [x], [y])[0])

# ---------- USGS whole-Moon maps by range request ----------
def http(url, a=None, b=None):
    h = {'Range': f'bytes={a}-{b}'} if a is not None else {}
    for k in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=120) as r: return r.read()
        except Exception:
            if k == 5: raise

USGS = {
    'sldem': ('https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/LolaKaguya_Topo/Lunar_LRO_LOLAKaguya_DEMmerge_60N60S_512ppd.tif', 512, 60),
    'lola118': ('https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif', 256, 90),
}
def usgs_crop(key, lat, lon, km):
    """Square crop (km wide) around lat, lon from a USGS BigTIFF that stores one uint16 row per strip, uncompressed."""
    url, ppd, top = USGS[key]
    head = http(url, 0, 1 << 20)
    off = struct.unpack('<Q', head[8:16])[0]; n = struct.unpack('<Q', head[off:off + 8])[0]; tags = {}
    for i in range(n):
        e = off + 8 + i * 20; tag = struct.unpack('<H', head[e:e + 2])[0]; tags[tag] = struct.unpack('<Q', head[e + 12:e + 20])[0]
    W, strip0 = tags[256], struct.unpack('<Q', head[tags[273]:tags[273] + 8])[0]
    half_rows = int(math.ceil(km * 500 / (R * math.radians(1 / ppd))))
    half_cols = int(math.ceil(half_rows / math.cos(math.radians(lat))))
    jc, ic = int((top - lat) * ppd), int((lon + 180) * ppd)
    j0, i0, nr, nc = jc - half_rows, ic - half_cols, 2 * half_rows + 1, 2 * half_cols + 1
    cache = os.path.join(CACHE, 'rows', f'{key}_{j0}_{i0}_{nr}_{nc}.i16')
    if not os.path.exists(cache):
        def row(j): return http(url, strip0 + (j0 + j) * W * 2 + i0 * 2, strip0 + (j0 + j) * W * 2 + (i0 + nc) * 2 - 1)
        with ThreadPoolExecutor(32) as ex: rows = list(ex.map(row, range(nr)))
        open(cache, 'wb').write(b''.join(rows))
    a = np.fromfile(cache, '<i2').reshape(nr, nc).astype(np.float32)
    a[a == -32768] = np.nan
    return Grid(a * 0.5, 'eqc', -180 + (i0 + 0.5) / ppd, top - (j0 + 0.5) / ppd, 1 / ppd)

# ---------- packing ----------
def pack(g, name, q=None):
    h = g.h; ok = np.isfinite(h); h0 = float(np.floor(np.nanmin(h)))
    span = float(np.nanmax(h)) - h0
    q = q or (0.05 if span < 3200 else 0.1 if span < 6500 else 0.25)
    dn = np.where(ok, 1 + np.round((np.where(ok, h, h0) - h0) / q), 0).astype(np.int64)
    d = (np.diff(dn, axis=1, prepend=0) & 0xFFFF).astype(np.uint16)
    planes = np.concatenate([(d & 0xFF).astype(np.uint8).ravel(), (d >> 8).astype(np.uint8).ravel()])
    fn = f'{name}.bin.gz'; open(os.path.join(OUT, fn), 'wb').write(gzip.compress(planes.tobytes(), 9, mtime=0))
    meta = {'file': fn, 'proj': g.proj, 'w': int(h.shape[1]), 'h': int(h.shape[0]), 'x0': g.x0, 'y0': g.y0, 'dx': g.dx, 'dy': g.dy,
            'scale': round(g.scale, 3), 'q': q, 'h0': h0}
    return meta, os.path.getsize(os.path.join(OUT, fn))

def crop_sps(g, cx, cy, km, bounds=None):
    """Square of km around stereographic (cx, cy), moved to stay inside the grid."""
    n = int(round(km * 1000 / g.dx)); H, W = g.h.shape
    ic, jc = int(round((cx - g.x0) / g.dx)), int(round((g.y0 - cy) / g.dy))
    i0 = min(max(0, ic - n // 2), max(0, W - n)); j0 = min(max(0, jc - n // 2), max(0, H - n))
    sub = np.array(g.h[j0:j0 + n, i0:i0 + n], dtype=np.float32)
    return Grid(sub, 'sps', g.x0 + i0 * g.dx, g.y0 - j0 * g.dy, g.dx)

# ---------- skyline ----------
def skyline(lat, lon, grids, n_az=1440, beyond_m=22000, reach_m=300000):
    up = unit(lat, lon); east = np.array([-math.sin(math.radians(lon)), 0, -math.cos(math.radians(lon))])
    north = np.cross(up, east); north /= np.linalg.norm(north)
    h0 = float(chain(grids, up[0:1], up[1:2], up[2:3])[0]); r0 = R + h0 + EYE
    az = np.radians(np.arange(n_az) * 360 / n_az)
    dirs = np.outer(np.sin(az), east) + np.outer(np.cos(az), north)
    d, x = [], 2.5
    while x < reach_m: d.append(x); x += max(2.5, min(0.005 * x, 40))
    d = np.array(d); best = np.full(n_az, -np.inf); far = np.full(n_az, -np.inf)
    for k in range(0, len(d), 256):
        g = d[k:k + 256] / R; cg, sg = np.cos(g)[:, None], np.sin(g)[:, None]
        p = up[None, None, :] * cg[:, :, None] + dirs[None, :, :] * sg[:, :, None]
        h = chain(grids, p[..., 0].ravel(), p[..., 1].ravel(), p[..., 2].ravel()).reshape(len(g), n_az)
        r = R + h; t = (r * cg - r0) / (r * sg); t = np.where(np.isnan(t), -np.inf, t)
        best = np.maximum(best, t.max(0))
        m = d[k:k + 256] >= beyond_m
        if m.any(): far = np.maximum(far, t[m].max(0))
    return np.degrees(np.arctan(best)), np.degrees(np.arctan(far)), h0

def b64(deg):
    return base64.b64encode(np.round(np.asarray(deg) * 100).clip(-32767, 32767).astype('<i2').tobytes()).decode()

# ---------- helpers for the 5 m maps ----------
def box_mean(a, r):
    """Mean over a (2r+1) square, edges padded by repeating the border."""
    p = np.pad(a, r + 1, mode='edge').astype(np.float64); c = p.cumsum(0).cumsum(1); k = 2 * r + 1
    s = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    return (s / (k * k))[:a.shape[0], :a.shape[1]]

def sfs_region(path):
    t = tifffile.TiffFile(path); pg = t.pages[0]
    tie = pg.tags['ModelTiepointTag'].value; sc = pg.tags['ModelPixelScaleTag'].value
    h = pg.asarray().astype(np.float32); h[~np.isfinite(h) | (h < -1e5)] = np.nan
    return Grid(h, 'sps', tie[3] + sc[0] / 2, tie[4] - sc[1] / 2, sc[0])

def pick_landing(G):
    """The sunniest 60 m NASA pixel inside the region with flat enough ground (see the header)."""
    H = box_mean(np.nan_to_num(G.h, nan=float(np.nanmean(G.h))), 1)   # 15 m baseline
    gy, gx = np.gradient(H, G.dx)
    flat = box_mean((np.degrees(np.arctan(np.hypot(gx, gy))) < SLOPE_MAX).astype(np.float32), FLAT_RADIUS_M // 5)
    hh, ww = G.h.shape; margin = 600
    xs = np.arange(G.x0 + margin, G.x0 + (ww - 1) * G.dx - margin, 60.0)
    ys = np.arange(G.y0 - margin, G.y0 - (hh - 1) * G.dx + margin, -60.0)
    X, Y = np.meshgrid(xs, ys)
    X, Y = SUN.x0 + np.rint((X - SUN.x0) / 60) * 60.0, SUN.y0 - np.rint((SUN.y0 - Y) / 60) * 60.0  # NASA 60 m pixel centres
    fi, fj = np.rint((X - G.x0) / G.dx).astype(int), np.rint((G.y0 - Y) / G.dx).astype(int)
    ok = (fi >= 0) & (fj >= 0) & (fi < ww) & (fj < hh)
    fi, fj = np.clip(fi, 0, ww - 1), np.clip(fj, 0, hh - 1)
    sun, earth = nasa_at(SUNS, X, Y), nasa_at(EARTHS, X, Y)
    good = ok & (flat[fj, fi] >= FLAT_SHARE) & np.isfinite(G.h[fj, fi]) & np.isfinite(sun)
    score = np.where(good, sun + 1e-3 * earth, -1)
    k = np.unravel_index(np.argmax(score), score.shape)
    return float(X[k]), float(Y[k]), float(sun[k]), float(earth[k]), float(flat[fj[k], fi[k]])

# ---------- the sites ----------
REGION_IDS = {  # NASA's region number and name -> our id and short name
    0: ('amundsen', 'Amundsen Rim', 'Amundsen rim'), 1: ('nobile2', 'Nobile Rim 2', 'Nobile rim 2'),
    2: ('haworth', 'Haworth', 'Haworth'), 3: ('faustini', 'Faustini Rim A', 'Faustini rim'),
    4: ('degerl2', 'de Gerlache Rim 2', 'de Gerlache 2'), 5: ('ridge-ext', 'Connecting Ridge Extension', 'Ridge ext.'),
    6: ('ridge', 'Connecting Ridge', 'Conn. ridge'), 7: ('nobile1', 'Nobile Rim 1', 'Nobile rim 1'),
    8: ('peak-shk', 'Peak near Shackleton', 'Peak nr Shackleton'), 9: ('degerl', 'de Gerlache Rim', 'de Gerlache'),
    10: ('leibnitz', 'Leibnitz Beta Plateau', 'Leibnitz beta'), 11: ('malap', 'Malapert Massif', 'Malapert'),
    12: ('kocher', 'de Gerlache-Kocher Massif', 'Kocher massif'),
}
PAST = [  # past landings, in landing date order: coordinates as published by LROC / NSSDC / JAXA, best map available for each
    {'id': 'a11', 'name': 'Tranquility Base (Apollo 11)', 'short': 'Apollo 11', 'lat': 0.674, 'lon': 23.473},
    {'id': 'a12', 'name': 'Ocean of Storms (Apollo 12)', 'short': 'Apollo 12', 'lat': -3.0124, 'lon': -23.4216},
    {'id': 'a14', 'name': 'Fra Mauro (Apollo 14)', 'short': 'Apollo 14', 'lat': -3.6453, 'lon': -17.4714},
    {'id': 'a15', 'name': 'Hadley Rille (Apollo 15)', 'short': 'Apollo 15', 'lat': 26.1322, 'lon': 3.6339},
    {'id': 'a16', 'name': 'Descartes (Apollo 16)', 'short': 'Apollo 16', 'lat': -8.9730, 'lon': 15.5002},
    {'id': 'a17', 'name': 'Taurus-Littrow (Apollo 17)', 'short': 'Apollo 17', 'lat': 20.1908, 'lon': 30.7717},
    {'id': 'ce4', 'name': 'Von K\u00e1rm\u00e1n (Chang\'e-4)', 'short': "Chang'e-4", 'lat': -45.4561, 'lon': 177.5885},
    {'id': 'ch3', 'name': 'Shiv Shakti (Chandrayaan-3)', 'short': 'Shiv Shakti', 'lat': -69.37, 'lon': 32.32},
    {'id': 'slim', 'name': 'Shioli (SLIM)', 'short': 'SLIM', 'lat': -13.3160, 'lon': 25.2510},
    {'id': 'ce6', 'name': "Chang'e-6, Apollo basin", 'short': "Chang'e-6", 'lat': -41.64, 'lon': -153.99},
    {'id': 'bg1', 'name': 'Mare Crisium (Blue Ghost 1)', 'short': 'Blue Ghost 1', 'lat': 18.5622, 'lon': 61.8103},
    {'id': 'mouton', 'name': 'Mons Mouton (IM-2)', 'short': 'Mons Mouton', 'lat': -84.80, 'lon': 29.2},
]
CITE = {
    'sfs': 'NASA 5 m shape-from-shading map, Artemis III region (Bertone et al. 2026, PGDA product 104)',
    'lola80': 'NASA LOLA laser altimeter map, 80 m per pixel (LRO-L-LOLA-4-GDR-V1.0)',
    'nac': 'LROC stereo terrain model, 2 m per pixel (NAC_DTM_APOLLO11, Henriksen et al. 2017)',
    'sldem': 'LOLA and Kaguya merged map SLDEM2015, 59 m per pixel (Barker et al. 2016)',
    'lola118': 'LOLA global map, 118 m per pixel',
}

def main():
    only = set(sys.argv[1:])
    index = {'note': 'Built by tools/build-sites.py. Do not edit by hand.', 'eye_m': EYE, 'sources': CITE, 'sites': {}}
    total = 0
    for path in sorted(glob.glob(os.path.join(CACHE, 'sfs', '*_ELEV.tif')), key=lambda p: int(re.search(r'A3CLR22_(\d+)_', p).group(1))):
        num = int(re.search(r'A3CLR22_(\d+)_', path).group(1)); sid, name, short = REGION_IDS[num]
        if only and sid not in only: continue
        G = sfs_region(path)
        x, y, sun, earth, flat = pick_landing(G)
        lat, lon = inv_stereo(x, y)
        fine = crop_sps(G, x, y, FINE_KM)
        block = crop_sps(LOLA80, x, y, BLOCK_KM)
        sky, far, h0 = skyline(lat, lon, [G, LOLA80, POLAR625])
        fm, fs = pack(fine, f'{sid}_fine'); bm, bs = pack(block, f'{sid}_block', q=0.5); total += fs + bs
        index['sites'][sid] = {'name': name, 'short': short, 'group': 'Artemis III candidate regions', 'lat': round(lat, 5), 'lon': round(lon, 5),
            'region': num, 'elev_m': round(h0, 1), 'nasa_sun': round(sun, 4), 'nasa_earth': round(earth, 4), 'flat_share': round(flat, 3),
            'fine': {**fm, 'source': 'sfs'}, 'block': {**bm, 'source': 'lola80'}, 'skyline': b64(sky), 'beyond': b64(far[::4])}
        print(f'{sid:10s} {lat:9.4f} {lon:9.4f}  NASA sun {sun:5.1%} earth {earth:5.1%}  flat {flat:4.0%}  fine {fs/1e6:4.1f} MB  block {bs/1e6:4.2f} MB', flush=True)
    for s in PAST:
        sid = s['id']
        if only and sid not in only: continue
        e = {**s, 'group': 'Past landings', 'fine': None}
        if sid == 'mouton':
            x, y = stereo(s['lat'], s['lon']); block, src = crop_sps(LOLA80, x, y, BLOCK_KM), 'lola80'
            grids = [LOLA80, POLAR625]; e['nasa_sun'] = round(nasa_share(SUNS, s['lat'], s['lon']), 4); e['nasa_earth'] = round(nasa_share(EARTHS, s['lat'], s['lon']), 4)
        elif sid == 'ch3':
            block, src = usgs_crop('lola118', s['lat'], s['lon'], BLOCK_KM), 'lola118'; grids = [block, GLOBAL8]
        else:
            block, src = usgs_crop('sldem', s['lat'], s['lon'], BLOCK_KM), 'sldem'; grids = [block, GLOBAL8]
        if sid == 'a11':
            t = tifffile.imread(os.path.join(CACHE, 'lroc', 'NAC_DTM_APOLLO11.TIF')).astype(np.float32); t[~np.isfinite(t) | (t < -1e5)] = np.nan
            lbl = open(os.path.join(CACHE, 'lroc', 'NAC_DTM_APOLLO11.LBL')).read()
            num = lambda k: float(re.search(k + r'\s*=\s*([-\d.]+)', lbl).group(1))
            west, east, lat_max, lat_min = num('WESTERNMOST_LONGITUDE'), num('EASTERNMOST_LONGITUDE'), num('MAXIMUM_LATITUDE'), num('MINIMUM_LATITUDE')
            dlon, dlat = (east - west) / t.shape[1], (lat_max - lat_min) / t.shape[0]
            full = Grid(t, 'eqc', west + dlon / 2, lat_max - dlat / 2, dlon, dlat)
            jc = int((full.y0 - s['lat']) / dlat); n = int(3000 / (R * math.radians(dlat)))   # 6 km of rows around the site
            j0 = max(0, jc - n); sub = t[j0:jc + n]
            fine = Grid(sub, 'eqc', full.x0, full.y0 - j0 * dlat, dlon, dlat)
            fm, fs = pack(fine, f'{sid}_fine'); total += fs; e['fine'] = {**fm, 'source': 'nac'}
            grids = [full] + grids
        sky, far, h0 = skyline(s['lat'], s['lon'], grids)
        bm, bs = pack(block, f'{sid}_block', q=0.5); total += bs
        e.update({'elev_m': round(h0, 1), 'block': {**bm, 'source': src}, 'skyline': b64(sky), 'beyond': b64(far[::4])})
        index['sites'][sid] = e
        print(f'{sid:10s} {s["lat"]:9.4f} {s["lon"]:9.4f}  {src}  fine {"yes" if e["fine"] else "no "}  block {bs/1e6:4.2f} MB', flush=True)
    ip = os.path.join(OUT, 'index.json')
    if only and os.path.exists(ip):  # a partial run keeps the other sites
        old = json.load(open(ip)); old['sites'].update(index['sites']); index['sites'] = old['sites']
    order = [v[0] for k, v in sorted(REGION_IDS.items())] + [p['id'] for p in PAST]
    index['sites'] = {k: index['sites'][k] for k in order if k in index['sites']}
    json.dump(index, open(ip, 'w'), indent=1)
    write_site_list(index)
    print(f'wrote {ip}, {total / 1e6:.1f} MB of maps this run')

def write_site_list(index):
    """Replace the site list in site/lib/lunar.js between its SITES:BEGIN and SITES:END markers."""
    p = os.path.join(ROOT, 'site', 'lib', 'lunar.js'); src = open(p).read()
    lines = [f"    {{ id: '{k}', name: {json.dumps(v['name'])}, short: {json.dumps(v['short'])}, lat: {v['lat']}, lon: {v['lon']}, group: {json.dumps(v['group'])} }},"
             for k, v in index['sites'].items()]
    if '// SITES:BEGIN' not in src: raise SystemExit('lunar.js has no SITES:BEGIN marker')
    new = re.sub(r'(// SITES:BEGIN[^\n]*\n).*?([ \t]*// SITES:END)', lambda m: m.group(1) + ''.join(l + '\n' for l in lines) + m.group(2), src, flags=re.S)
    open(p, 'w').write(new)

if __name__ == '__main__':
    if sys.argv[1:] == ['--list-only']: write_site_list(json.load(open(os.path.join(OUT, 'index.json')))); sys.exit()
    main()
