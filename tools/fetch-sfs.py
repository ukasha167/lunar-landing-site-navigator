# Downloads NASA's 5 m shape-from-shading elevation maps of the 13 Artemis III candidate regions (2022 list).
#
# Source: Bertone et al. (2026), "Enhanced Topography Models for selected Lunar South Pole regions with
# Shape-from-Shading", The Planetary Science Journal, doi:10.3847/PSJ/ae5b70. Data: Zenodo record 17954508
# (doi:10.5281/zenodo.17954508), NASA PGDA product 104. Heights in metres above a 1737.4 km sphere, polar
# stereographic (+proj=stere +lon_0=0 +lat_0=-90 +R=1737400), 5 m per pixel.
#
# Each region is a 1 to 4.4 GB zip. Zenodo answers HTTP range requests, so this reads each zip's file list
# from its end and downloads only the elevation map (*_GLDELEV_005.tif, about 20 to 40 MB) and README.txt.
# Files land in tools/.cache/sfs/. A rerun skips files already there.
#
# Run: python3 tools/fetch-sfs.py        Needs only the Python standard library.
import json, os, struct, sys, urllib.request, zlib
from concurrent.futures import ThreadPoolExecutor

RECORD = 'https://zenodo.org/api/records/17954508'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache', 'sfs')
os.makedirs(OUT, exist_ok=True)

def get(url, a=None, b=None, tries=5):
    h = {'Range': f'bytes={a}-{b}'} if a is not None else {}
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=900) as r: return r.read()
        except Exception as e:  # Zenodo sometimes drops a long transfer: try again
            if k == tries - 1: raise
            print(f'retry {k + 1}: {url} {e}', flush=True)

def central_directory(url, size):
    tail = get(url, max(0, size - 400000), size - 1)
    base = size - len(tail)
    i = tail.rfind(b'PK\x05\x06'); cd_size, cd_off = struct.unpack('<II', tail[i + 12:i + 20])
    j = tail.rfind(b'PK\x06\x06')
    if j >= 0: cd_size, cd_off = struct.unpack('<QQ', tail[j + 40:j + 56])
    if cd_off < base: tail = get(url, cd_off, size - 1); base = cd_off
    p, out = cd_off - base, {}
    while tail[p:p + 4] == b'PK\x01\x02':
        meth, = struct.unpack('<H', tail[p + 10:p + 12]); csz, usz = struct.unpack('<II', tail[p + 20:p + 28])
        nl, el, cl = struct.unpack('<HHH', tail[p + 28:p + 34]); lho, = struct.unpack('<I', tail[p + 42:p + 46])
        name = tail[p + 46:p + 46 + nl].decode(); ext = tail[p + 46 + nl:p + 46 + nl + el]
        q, vals = 0, []
        while q < len(ext):
            hid, hl = struct.unpack('<HH', ext[q:q + 4])
            if hid == 1: vals = list(struct.unpack('<%dQ' % (hl // 8), ext[q + 4:q + 4 + hl]))
            q += 4 + hl
        if usz == 0xFFFFFFFF: usz = vals.pop(0)
        if csz == 0xFFFFFFFF: csz = vals.pop(0)
        if lho == 0xFFFFFFFF: lho = vals.pop(0)
        out[name] = (meth, csz, usz, lho)
        p += 46 + nl + el + cl
    return out

def extract(url, entry, dest):
    meth, csz, usz, off = entry
    h = get(url, off, off + 29); nl, el = struct.unpack('<HH', h[26:30]); start = off + 30 + nl + el
    data = get(url, start, start + csz - 1)
    if meth == 8: data = zlib.decompressobj(-15).decompress(data)
    assert len(data) == usz, (dest, len(data), usz)
    open(dest + '.part', 'wb').write(data); os.replace(dest + '.part', dest)

def region(f):
    url, key = f['links']['self'], f['key']
    if not key.endswith('.zip'): return
    rid = key[:-4]
    want = {k: v for k, v in central_directory(url, f['size']).items()
            if not k.startswith('__MACOSX') and (k.endswith('_GLDELEV_005.tif') or k.endswith('README.txt'))}
    for name, entry in want.items():
        dest = os.path.join(OUT, rid + ('_README.txt' if name.endswith('README.txt') else '_ELEV.tif'))
        if os.path.exists(dest): continue
        extract(url, entry, dest); print(f'{dest}  {entry[2] / 1e6:.1f} MB', flush=True)

files = json.loads(get(RECORD))['files']
with ThreadPoolExecutor(4) as ex: list(ex.map(region, files))
print('done', flush=True)
