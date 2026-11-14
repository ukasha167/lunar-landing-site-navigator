# Verification checklist

The agent runs this after every change. The tester runs it in full on Saturday 17:00 and Sunday 12:00. Write PASS or FAIL next to each step, with the number or screenshot that proves it.

## 1. Numbers match NASA

- [ ] `node verify/accuracy.mjs` passes every row (Sun and Earth direction within 0.01 deg of JPL Horizons at all 10 sites; share of time up within 1 percentage point; rise and set times within 1 percent)

## 2. It loads

- [ ] Start the `site` preview. The Moon and two ground blocks appear within 5 seconds.
- [ ] Console has zero errors at 1440 px and at 1280 px wide.
- [ ] Idle for 5 seconds: no frames drawn (nothing changes, so nothing should render).
- [ ] Chrome, Safari and Firefox (tester only).
- [ ] The weakest laptop on the team still turns the Moon smoothly (tester only).

## 3. It does what the challenge asks

- [ ] Pick a site from a list of real sites
- [ ] Type in custom coordinates
- [ ] Two sites side by side
- [ ] Change the date and time
- [ ] Delay the launch and see which site stops working
- [ ] Sun and Earth shown against the real skyline
- [ ] Time left until sunset and until Earth sets, in plain words
- [ ] Sun height (power) and Earth visibility windows
- [ ] Every number on screen has a unit; no jargon

## 4. Terrain matches NASA's maps (validator)

- [ ] At Shackleton rim and de Gerlache rim, the skyline direction of the highest peak matches Quickmap or Moon Trek
- [ ] A crater that Quickmap shows in permanent shadow is dark in our app on every date

## 5. People understand it (tester)

Task for 5 people who have not seen it: "Which of these two sites is better for landing on 25 Oct 2027, and why?" No help.

- [ ] At least 4 of 5 answer correctly within 1 minute
- [ ] Notes on where each person hesitated are in the bug list

## 6. The submission works (everyone, Sunday 20:15)

- [ ] Live site, repo and demo open in a private window with no login
- [ ] Video 30 s or less, or deck 7 slides or fewer
- [ ] All English; nobody under 18 appears
