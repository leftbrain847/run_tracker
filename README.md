# Run Tracker

Plan a running loop from your location or zip: set a duration and pace, tick trail/road, hills/flat and "end downhill", and get scored loops on a map. Pick one, export it as GPX for your watch, or run it with live GPS tracking in the browser.

## How it works
- Loops come from openrouteservice round trips (one start point, target length, several random seeds). Each loop is scored both ways round, so "end downhill" can flip a loop's direction.
- Scoring: distance error, unpaved share (ORS surface codes), climb per mile, elevation lost over the last 20%. Every tunable is in `CONFIG` in `src/core.mjs`.
- Tracking needs the screen on (iOS pauses web pages when the phone is locked). Gaps from a locked phone are filled from the planned route (dashed) when both ends are on the route; off-route gaps are drawn but don't count toward distance.
- Each visitor pastes their own free openrouteservice key; it stays in their browser.

## Run
```
npm run build        # writes dist/index.html (one self-contained page)
# open dist/index.html, or serve it: npx serve dist
```

## Test
```
npm test
```

## Deployed
- Live: https://leftbrain847.github.io/run_tracker/
- Day snapshot: `2026-11-26 - Run Tracker` (frozen; never edited)

## Ship a sprint day
Set `project` in `sprint.config.json`, then freeze the day's page:
```
npm run build
node scripts/snapshot.mjs dist/index.html            # public: sprint.config.json has "public": true
```
Commit `snapshots/` to `main` (via PR). The index's nightly refresh logs the day automatically; public pages still have to pass its UAT and secret scan.
