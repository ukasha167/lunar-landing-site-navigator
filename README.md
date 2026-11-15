# Lunar Landing Site Navigator

NASA Space Apps Challenge 2026 entry. Pick up to three landing sites and a date, and see the Sun and Earth against each site's real skyline: when the power runs out and when the radio link to Earth drops.

Live site: https://ukasha167.github.io/lunar-landing-site-navigator/
Demo video: linked on our Space Apps project page.

## What it does

- **Sites side by side.** Up to 3 at once: 25 built-in sites (the 13 Artemis III candidate regions and 12 past landings, from Apollo 11 to IM-2), any coordinates you type, or any point you click on the Moon.
- **Sun and Earth against the skyline.** Each site shows its terrain in 3D, lit at the true Sun angle. Small Sun and Earth icons point at each body; hover the view to read its height above level ground and the time until it sets. The sunrise button swaps the terrain for a sky chart: the skyline with the Sun's and Earth's paths over the next 30 days.
- **One timeline for all sites.** 30 days of Sun up, Earth in view and good to land. The brighter part of each bar is the time left before that body sets. Drag the bars, step the time, or press play (1 day per second).
- **Go or no-go.** Good to land means the Sun is above the skyline and Earth is in view, and both stay up for the whole mission. The planner picks 2, 7 or 14 days. The +6 h, +1 day and +3 days marks under each site show what a launch delay does.
- **Take the numbers away.** The download button saves the 30 days as a CSV table: Sun and Earth elevation, azimuth, skyline height and the verdict, every hour, for every site. The address bar always holds a link to the current view (sites, date, mission length) to send to a teammate.
- **Past landings on their real dates.** Dates run from 1 Jan 2023 to 2 Jan 2031, so recent landings can be replayed. Chandrayaan-3 on 23 Aug 2023, 12:33 UTC shows the Sun 8.6° high with 11.7 days of light left.
- **Drive a rover** at the 13 Artemis III regions and Apollo 11, on NASA's 5 m maps (2 m at Apollo 11).

## Run it locally

```bash
python3 -m http.server 5318 --directory site
```

Then open http://localhost:5318.

## Folders

| Folder | What is in it |
|---|---|
| `site/` | The app judges open. GitHub Pages publishes only this folder. |
| `site/lib/` | `moon3d.js` (terrain, shadows, rendering), `app3d.js` (clicks, places, time), `lunar.js` (Sun and Earth positions, site stats, the go/no-go rule), `sky-chart.js` (the sky chart), `rover*.js` (rover mode) |
| `site/assets/` | NASA LOLA elevation and LROC colour, resampled; NASA maps around the built-in sites (`sites/`); Earth texture |
| `site/data/` | Sun and Earth positions downloaded from JPL Horizons |
| `verify/` | Checks against JPL Horizons and NASA's maps; `VERIFY.md` is the checklist run after every change |
| `submission/` | Drafts of every field in the Space Apps project form, the demo script and the slide outline |
| `team/` | Roles and the weekend schedule |
| `tools/` | Scripts that download or convert data |

## Data

- LOLA elevation, 16 pixels per degree, resampled to a 625 m grid around the south pole (NASA CGI Moon Kit)
- LROC colour mosaic (NASA CGI Moon Kit)
- Sun and Earth positions: JPL Horizons (DE441), every 6 hours from 1 Jan 2023 to 5 Mar 2031, in `site/data/ephemeris.json`. The exact query is in `site/data/README.md`.
- Built-in sites (`site/assets/sites/`, 44 MB, written by `tools/build-sites.py`). Every height on screen comes from one of these NASA maps; where none is finer, the ground is as smooth as the map:
  - The 13 Artemis III candidate regions (NASA's 2022 list): 5 m shape-from-shading maps made from LROC photos and LOLA laser heights (Bertone et al. 2026, The Planetary Science Journal, doi:10.3847/PSJ/ae5b70; data doi:10.5281/zenodo.17954508; NASA PGDA product 104). `tools/fetch-sfs.py` reads only the elevation file out of each region's zip (13 files, 241 MB). The rover uses a 10 km square of each.
  - Apollo 11: LROC stereo terrain model, 2 m per pixel (`NAC_DTM_APOLLO11`; Henriksen et al. 2017, doi:10.1016/j.icarus.2016.05.012).
  - Ground blocks (44 km square per site): LOLA 80 m polar map (`LDEM_80S_80M`, LRO-L-LOLA-4-GDR-V1.0; Smith et al. 2010, doi:10.1007/s11214-009-9512-y) near the pole; LOLA and Kaguya SLDEM2015 59 m (Barker et al. 2016) for Apollo 11 to 17, Chang'e-4, SLIM, Chang'e-6 and Blue Ghost 1; LOLA 118 m for Chandrayaan-3.
  - Landing point in each Artemis III region: the sunniest 60 m spot in NASA's sunlight map (Mazarico et al. 2011, doi:10.1016/j.icarus.2010.10.030) whose ground within 50 m is at least 95% under 8° of slope on the 5 m map.
  - Past landings: lander positions published by LROC and NASA's NSSDC. Blue Ghost 1 uses the centre of LROC's landing region, good to about 0.005° (150 m).
  - Each site's skyline is ray-cast from 2 m above the ground over the 5 m map, then the 80 m map, then the 625 m grid, out to 300 km, in 1,440 directions.
- Made up, and labelled in the rover view: rocks under 1.3 m and craters under 4 m across, which no map shows. The rover's surface grain, wheel tracks and dust are drawing effects, not map data. Nothing else.
- The rover opens only where a NASA map with 5 m pixels or finer holds the place (the 13 regions and Apollo 11). Elsewhere its button is disabled and says why.

## How accurate is it

Results on 15 Nov 2026:

| Check | What it compares | Result |
|---|---|---|
| `node verify/accuracy.mjs` | Sun and Earth elevation and azimuth at all 25 sites on 15 dates from 2023 to 2030 against JPL Horizons (allowed error 0.01°); share of time up and every rise and set time over two lunar days at 4 polar sites (allowed error 1 point, or 1% of the time until it) | 802 of 802 PASS. Largest direction error 0.000031° |
| `node verify/sunlight-vs-nasa.mjs` | Each south pole site's share of time in sunlight against NASA's own sunlight map (allowed gap 5 points) | 13 of 14 PASS. de Gerlache-Kocher Massif is 6.2 points over |
| `node verify/rover.mjs` | Rover physics, and that every 5 m and 2 m map lines up with the coarser map around it | 34 of 34 PASS. Average offset 0.4 m or less |

Why Kocher is 6.2 points off: NASA's map gives one 60 m pixel at ground level; the app gives one 5 m point seen from 2 m up. On this massif, NASA's own neighbouring pixels range from 47% to 79% sunlit, and the app's 79.1% falls inside that range. Moving the point by 20 m changes the app's number by up to 6 points. No change to the eye height brings Kocher inside 5 points without pushing other sites out.

The sunlight check averages 2026 to 2031, the years it was set up with. Over the table's full 2023 to 2031, 12 of 14 sites stay within 5 points (Haworth moves to 5.2). NASA's map averages 18.6 years.

## Use of AI

The team came up with the idea: compare landing sites side by side against their real skyline, with a launch-delay check, and chose the design. Claude Code, an AI coding agent, wrote the code, the data scripts and the checks, and drew design sketches the team picked from. The team set the go/no-go rule and checked the results against JPL Horizons and NASA's sunlight map.

Every source file says so in its header.

## Licence

The code is under the MIT licence (`LICENSE`). The NASA data keep their own terms: the CGI Moon Kit, LOLA, LROC and JPL Horizons products are NASA public data; the 5 m maps come from NASA PGDA product 104 (Zenodo, doi:10.5281/zenodo.17954508).

## Credits

Three.js (MIT), Lucide icons (ISC), fonts from Google Fonts (SIL Open Font License), Earth texture from NASA's Blue Marble (the copy in the Three.js examples).
