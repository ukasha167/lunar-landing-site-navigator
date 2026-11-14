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
| `site/assets/` | NASA LOLA elevation and LROC colour, resampled; Earth texture |
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
- Ground detail under about 2 km is generated, not measured, and the app says so.

## How accurate is it

Run `node verify/accuracy.mjs`. It checks two things against JPL Horizons:

1. Where the Sun and Earth sit in the sky (elevation and azimuth) at all 10 sites in our list, on 12 dates from 2026 to 2030. Allowed error: 0.01°.
2. The numbers the app shows, over two lunar days at 4 polar sites: share of the time the Sun and Earth are up (allowed error: 1 percentage point) and every sunrise, sunset, Earthrise and Earthset (allowed error: 1 percent of the time until it, or 1 minute).

_Paste the latest result table here before submitting._

## Credits

Three.js (MIT), Lucide icons (ISC), fonts from Google Fonts (SIL Open Font License). Code written with Claude Code; the concept, design decisions and verification are the team's.
