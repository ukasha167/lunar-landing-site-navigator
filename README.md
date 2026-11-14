# Lunar Landing Site Navigator

NASA Space Apps Challenge 2026 entry. Pick two places near the Moon's south pole and a landing date, and see the Sun and Earth against the real skyline: when the power runs out and when the radio link drops.

Live site: _add the GitHub Pages link here_
Demo video: _add the link here_

## Run it locally

```bash
python3 -m http.server 5318 --directory site
```

Then open http://localhost:5318.

## Folders

| Folder | What is in it |
|---|---|
| `site/` | The app judges open. GitHub Pages publishes only this folder. |
| `site/lib/` | `moon3d.js` (terrain, shadows, rendering), `app3d.js` (clicks, places, time), `lunar.js` (Sun and Earth positions, site stats) |
| `site/assets/` | NASA LOLA elevation and LROC colour, resampled; NASA maps around the built-in sites (`sites/`); Earth texture |
| `site/data/` | Sun and Earth positions downloaded from JPL Horizons |
| `verify/` | `accuracy.mjs` compares our numbers with Horizons; `VERIFY.md` is the checklist run after every change |
| `submission/` | Drafts of every field in the Space Apps project form, the demo script and the slide outline |
| `team/` | Roles and the weekend schedule |
| `prototypes/` | The twenty design directions explored before the hackathon |
| `tools/` | Scripts that download or convert data |

## Data

- LOLA elevation, 16 pixels per degree, resampled to a 625 m grid around the south pole (NASA CGI Moon Kit)
- LROC colour mosaic (NASA CGI Moon Kit)
- Sun and Earth positions: JPL Horizons (DE441), every 6 hours for 2026 to 2030, in `site/data/ephemeris.json`. The exact query is in `site/data/README.md`.
- Built-in sites (`site/assets/sites/`, 40 MB, written by `tools/build-sites.py`). Every height on screen comes from one of these NASA maps; where none is finer, the ground is as smooth as the map:
  - The 13 Artemis III candidate regions (NASA's 2022 list): 5 m shape-from-shading maps made from LROC photos and LOLA laser heights (Bertone et al. 2026, The Planetary Science Journal, doi:10.3847/PSJ/ae5b70; data doi:10.5281/zenodo.17954508; NASA PGDA product 104). `tools/fetch-sfs.py` reads only the elevation file out of each region's zip (13 files, 241 MB). The rover uses a 10 km square of each.
  - Apollo 11: LROC stereo terrain model, 2 m per pixel (`NAC_DTM_APOLLO11`; Henriksen et al. 2017, doi:10.1016/j.icarus.2016.05.012).
  - Ground blocks (44 km square per site): LOLA 80 m polar map (`LDEM_80S_80M`, LRO-L-LOLA-4-GDR-V1.0; Smith et al. 2010, doi:10.1007/s11214-009-9512-y), LOLA and Kaguya SLDEM2015 59 m (Barker et al. 2016) for Chang'e-6 and Apollo 11, LOLA 118 m for Chandrayaan-3.
  - Landing point in each region: the sunniest 60 m spot in NASA's sunlight map (Mazarico et al. 2011, doi:10.1016/j.icarus.2010.10.030) whose ground within 50 m is at least 95% under 8° of slope on the 5 m map.
  - Each site's skyline is ray-cast from 2 m above the ground over the 5 m map, then the 80 m map, then the 625 m grid, out to 300 km, in 1,440 directions.
- Made up, and labelled in the rover view: rocks under 1.3 m and craters under 4 m across, which no map shows. Nothing else.
- The rover opens only where a NASA map with 5 m pixels or finer holds the place (the 13 regions and Apollo 11). Elsewhere its button is disabled and says why.

## How accurate is it

Run `node verify/accuracy.mjs`. It checks two things against JPL Horizons:

1. Where the Sun and Earth sit in the sky (elevation and azimuth) at all 17 sites in our list, on 12 dates from 2026 to 2030. Allowed error: 0.01°.
2. The numbers the app shows, over two lunar days at 4 polar sites: share of the time the Sun and Earth are up (allowed error: 1 percentage point) and every sunrise, sunset, Earthrise and Earthset (allowed error: 1 percent of the time until it, or 1 minute).

Run `node verify/sunlight-vs-nasa.mjs` to compare each south pole site's share of time in sunlight with NASA's own sunlight map. On 15 Nov 2026: 13 of 14 sites within 5 percentage points, largest gap 6.2 points (de Gerlache-Kocher Massif). NASA's map averages 18.6 years from the ground on 60 m pixels; the app averages 2026 to 2031 from 2 m up on 5 m pixels, so a few points of gap are expected.

Run `node verify/rover.mjs` to check, among other things, that every 5 m and 2 m map lines up with the coarser map around it (average offset 0.4 m or less at the 13 regions).

_Paste the latest result table here before submitting._

## Credits

Three.js (MIT), Lucide icons (ISC), fonts from Google Fonts (SIL Open Font License). Code written with Claude Code; the concept, design decisions and verification are the team's.
