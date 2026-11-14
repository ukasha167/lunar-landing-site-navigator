# Data from JPL Horizons

`ephemeris.json` holds the position of the Sun and of Earth relative to the Moon, every 6 hours from 1 Jan 2026 00:00 UTC to 5 Mar 2031 00:00 UTC (7,557 rows). `site/lib/lunar.js` reads it.

## What is in the file

- `sun`, `earth`: flat lists of x, y, z in km, three numbers per row. Each vector runs from the Moon's centre to the body.
- Frame: the Moon's mean-Earth frame (MOON_ME), the one LOLA maps use. x points to 0° N 0° E, y to 0° N 90° E, z to the north pole.
- `start`, `stepHours`, `count`: the time of row 0, the gap between rows, the number of rows.
- `query`: the exact Horizons request.

Between rows, `lunar.js` fits a cubic through the 4 nearest rows. Against a 1-hour table this adds at most 0.000005° to the Sun's direction and 0.000005° to Earth's.

## The exact query

Two requests to https://ssd.jpl.nasa.gov/api/horizons.api, one with `COMMAND='10'` (Sun) and one with `COMMAND='399'` (Earth):

```
format=json  OBJ_DATA='NO'  MAKE_EPHEM='YES'  EPHEM_TYPE='OBSERVER'
CENTER='coord@301'  COORD_TYPE='GEODETIC'  SITE_COORD='0,0,0'
START_TIME='2026-01-01 00:00'  STOP_TIME='2031-03-05 00:00'  STEP_SIZE='6 h'
QUANTITIES='4,20'  ANG_FORMAT='DEG'  CSV_FORMAT='YES'  RANGE_UNITS='KM'  EXTRA_PREC='YES'
```

That asks for the apparent azimuth, elevation and distance of each body seen from 0° N 0° E on the Moon (radius 1737.4 km), with times in UTC. Horizons uses DE441 and the MEAN_ME frame for this site. For each row we rebuild the vector from the Moon's centre:

```
x = 1737.4 + distance × sin(elevation)
y = distance × cos(elevation) × sin(azimuth)
z = distance × cos(elevation) × cos(azimuth)
```

Because the table starts from what Horizons reports at a point on the surface, it carries the same corrections Horizons applies to every Moon site (light travel time, aberration, bending of light by the Sun). `lunar.js` then computes the view from any other site, including Earth's parallax.

## Rebuild it

```bash
node tools/fetch-ephemeris.mjs
```

Optional arguments: start, stop, step in hours, output file. Then run `node verify/accuracy.mjs` to check the result against Horizons.
