# Dashboard mockup — Rain, Roads and the Commute

A static, five-page front end showing what the finished dashboard would look like at
**1360 × 735** with no page scrolling. There is no backend: the pages read a single
generated file, `data/data.js`.

## Run it

```powershell
cd multimediaProj\mockup
python -m http.server 8765 --bind 127.0.0.1
```

Open <http://127.0.0.1:8765/>. Deep links: `#live`, `#impact`, `#replay`, `#loop`, `#trust`.

Opening `index.html` directly with `file://` also works, because all data is embedded in
a script tag rather than fetched.

## The five pages

| Page | What it demonstrates |
|---|---|
| **Live** | Congestion map of 429 detectors, ranked corridors, district rainfall, camera wall, one alert with a plain-language recommendation and a 30-minute outlook. |
| **Impact** | The analytical finding: speed ratio vs rainfall with a fitted line, per-district sensitivity with confidence intervals, onset lag, peak interaction, and a model card. |
| **Replay** | A 5-minute-step replay of one rain event with a scrubber, playback speeds, event list, network timeline, and a camera strip. |
| **Loop** | The feedback loop: alerts → decisions → measured outcomes, forecast skill against a persistence baseline, and the decision log. |
| **Trust** | Feed freshness, detector validity heatmap, camera "No Service" rate, outlook calibration, and data provenance. |

## What is real and what is simulated

**Real**, pulled from Hong Kong government sources:

- Detector geometry — 807 locations across 18 districts, filtered to 429 detectors in six
  study districts (TD, `traffic_speed_volume_occ_info.csv`).
- The 08:23 rush-hour snapshot and the 03:00 free-flow baseline — TD detector XML retrieved
  through the data.gov.hk historical archive, used to compute a real congestion index.
- District polygons — HAD 18-district boundaries.
- Camera images — six live TD traffic camera frames (320×240), with their real IDs and
  coordinates.
- The 1,013-camera count and the 4.2% "No Service" figure in Trust are illustrative of the
  network, not a measured audit.

**Simulated**, plainly labelled by the `MOCKUP` chip:

- Rainfall series, the impact scatter and its fitted line, district sensitivities, lag
  curve, peak interaction, forecast skill, decision log, validity heatmap, calibration.
- The replay time dimension is a synthetic 5-minute profile anchored on the real snapshot.
- Two deliberately broken feeds are shown in Trust (daily rainfall stale to 30 Sep;
  camera frames unavailable) to demonstrate that the dashboard surfaces data quality.

## Rebuilding the data

```powershell
python build_mock_data.py
```

Expects these inputs in `C:\Users\micha\Desktop\dsh\.tmp\mock\`: `detectors.csv`,
`snap_20261113-0830.xml`, `snap_20261115-0300.xml`, `districts.json`, plus
`C:\Users\micha\Desktop\dsh\cameras.csv`. Output is `data/data.js` (~295 KB).

## Notes

- Layout is a fixed 1360 × 735 frame, scaled down with CSS `zoom` only when the window is
  smaller, so the composition never reflows.
- The `Peak only` / `Off-peak` buttons on Impact are placeholders; the mockup shows one
  fitted view.
- Charts are Chart.js 4.4.1 (vendored locally), map is hand-rendered SVG — no tile server,
  no API keys, works offline.
