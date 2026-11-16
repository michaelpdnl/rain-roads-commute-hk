# Rain, Roads and the Commute — Project Plan (v4)

**Status:** design frozen · static mockup built (§9.1) · backend not started
**Date:** 2026-11-16



## 1. Goal and success criteria

A web app that collects live Hong Kong traffic and rainfall data, derives a commute-congestion signal, quantifies how rain changes it, and places the dashboard in a **closed, measured feedback loop**: sensors → situational awareness → logged decision → re-measurement.

**Done means:**

1. Collector runs ≥10 days unattended, ≥95% feed uptime.
2. ≥40 days of traffic history backfilled, plus live accumulation.
3. Two quantified findings with numbers, plus one honest negative result.
4. Five pages, each fitting **exactly 1360×735 with zero page scroll** — proven by the mockup (§9.1).
5. Decision log with ≥20 alerts, each with a decision and an auto-computed outcome.
6. One-command run; report with screenshots.

---

## 2. Topic and use cases

**Title:** *Rain, Roads and the Commute.*

| Use case | Actor | Question | Output |
|---|---|---|---|
| **UC1 Commute Pulse** | Commuter; ops desk | How bad is my corridor now, and in 30 min? | Live CI, departure advice, alert |
| **UC2 Rain-Impact Curve** | Planner | How much speed is lost per mm/h, where, and with what lag? | Per-district sensitivity, cluster-robust CIs |
| **UC3 Decision Loop** | All three | Did the alert change a decision, and did it help? | Decision log, hit rate, outcome deltas |

---

## 3. Data (verified 2026-11-16)

| # | Feed | Endpoint | Cadence |
|---|---|---|---|
| 1 | TD detectors, all roads, **766 live** | `resource.data.one.gov.hk/td/traffic-detectors/rawSpeedVol-all.xml` | ~1 min (2×30 s periods) |
| 2 | Detector locations, **807 rows** + district | `static.data.gov.hk/td/traffic-data-strategic-major-roads/info/traffic_speed_volume_occ_info.csv` | static |
| 3 | HKO hourly rainfall, station-level | `data.weather.gov.hk/weatherAPI/opendata/hourlyRainfall.php?lang=en` | hourly |
| 4 | HKO daily rainfall, 1884→, 51 stations | `…/cis/csvfile/{STN}/ALL/daily_{STN}_RF_ALL.csv` | static |
| 5 | HKO district weather, 18 districts | `…/weather.php?dataType=rhrread&lang=en` | ~10 min |
| 6 | Archive backfill | `app.data.gov.hk/v1/historical-archive/get-file?url=…&time=YYYYMMDD-HHMM` | → **1 Oct 2026** |
| 7 | TD cameras, 1,013 × 320×240 | `tdcctv.data.one.gov.hk/<ID>.JPG` + CSV | ~2 min |

**Study set:** Yuen Long (131), Sha Tin (105), Tsuen Wan (90), Kwun Tong (62), Sham Shui Po (43), Yau Tsim Mong (25) ≈ 300 detectors. All data.gov.hk-listed; attribution in the footer.

---

## 4. Stack and dependencies

`requirements.txt` (pinned; cp314 wheels confirmed for all compiled packages):

```
fastapi==0.163.1      uvicorn==0.54.0     httpx==0.28.1
orjson==3.13.0        statsmodels==0.15.0 scipy==1.18.1
scikit-learn==1.9.1   pandas              numpy
pytest==9.2.0         pillow              lxml
```

Install with `python -m pip install -r requirements.txt` into the system interpreter (already has numpy, pandas, pillow, lxml).

- **Storage:** SQLite (`data/app.db`, WAL, ~2M rows).
- **API:** FastAPI + uvicorn.
- **Dashboard:** React 19 + Vite + TS, MapLibre GL, ECharts.
- **Layout testing:** puppeteer-core against installed Chrome (existing skill harness) — no extra Python browser install.

---

## 5. Architecture

```
TD XML (2 min) ─┐
HKO rain (1 h) ─┼─▶ collector (asyncio + httpx) ─▶ SQLite ─▶ derived tables
HKO weather ────┘        │                                      │
                         ├─ backfill (archive, checkpointed) ───┤
                         └─ alert engine ──▶ decisions          │
                                                                ▼
        React dashboard ◀── FastAPI /api/* ◀── query layer
```

Production: one process — FastAPI serves `dist/` and `/api` on `127.0.0.1:8000`. Development: Vite on `:5173` proxying `/api`.

---

## 6. Storage

```sql
detector( detector_id PK, road, direction, lat, lon, district, free_flow_speed )
traffic_obs( detector_id, ts, speed, occupancy, volume, valid, PK(detector_id, ts) )
rain_hourly( station_id, ts, mm, PK(station_id, ts) )
rain_daily( station_id, date, mm, PK(station_id, date) )
weather_district( district, ts, metric, value )
derived_state( detector_id, ts, ci, speed_ratio, rain_mm_h, rain_bin, lag_min )
alerts( id PK, ts, detector_id, district, rule, severity, message, expires_at )
decisions( id PK, alert_id, ts, actor, action, expected, outcome_at, outcome, verdict )
feed_health( ts, feed, ok, latency_ms, rows, error )
```

~216k rows/day live; raw retained 30 days.

---

## 7. Collection and backfill

Live: traffic every 2 min (asyncio task, `httpx` with retry), hourly rain on the hour, district weather every 10 min, one health row per attempt.

Backfill: 10-min cadence on rain days, 60-min on dry days (chosen from daily-rainfall history), 2 req/s with a resumed checkpoint table; raw discarded after normalise.

Camera images proxied with a 2-minute server cache; only curated event capture stored.

---

## 8. Analytics (statsmodels-based)

| Analysis | Method |
|---|---|
| Free-flow speed | 85th percentile per detector per hour-of-day |
| Congestion index | `CI = 1 − speed / free_flow` |
| Rain sensitivity | OLS `speed_ratio ~ rain + C(hour) + C(weekday)` per district, **cluster-robust SE by detector**; mixed-effects model as robustness check |
| Onset lag | `statsmodels.tsa.stattools.ccf` over −30…+120 min |
| Peak interaction | `speed_ratio ~ rain * peak + C(hour)` |
| Multiple comparisons | Benjamini–Hochberg across districts/detectors |
| 30-min outlook | Ridge / HistGradientBoosting vs **persistence baseline**; `TimeSeriesSplit`; skill = MAE improvement |
| Bootstrap CIs | 2,000 resamples for headline slopes |
| Camera proxy (optional) | PIL/numpy frame differencing, calibrated on 100 labelled frames |

**Hypotheses:** CI rises with rain; effect peaks after a lag; peak hours amplify; volume falls while occupancy rises under heavy rain.

Every reported number carries n, effect size, CI, and the script that produced it. If the camera proxy fails to correlate with detector occupancy, that is the negative result.

---

## 9. Dashboard — the 1360×735 contract

**Shell.** `html, body, #root { height: 100%; overflow: hidden; }`, base viewport 1360×735.

- **Top bar 48 px:** wordmark, five tabs (Live · Impact · Replay · Loop · Trust), feed-status chip, HKT clock.
- **Main:** `height: calc(100% - 48px); padding: 12px; display: grid; gap: 12px;`
- **Usable grid 1336×663**, 12 columns, 12 px gutters, two rows `minmax(0,1.15fr) minmax(0,0.85fr)` → ≈ 373 / 276 px.
- Pages with controls add a **36 px sub-toolbar**, rows become ≈ 353 / 262.
- Panels: 26 px title bar + body `min-height: 0; overflow: hidden`.
- Tables max 6–8 rows, "view all" drawer; the page never scrolls.
- Charts resize with their panel; Chart.js 4.4.1, no default legend; ticks 8–9 px.
- Type: titles 11 px uppercase; body 12 px; KPI 24–26 px; `tabular-nums`.

### Page layouts

| Page | Row 1 | Row 2 |
|---|---|---|
| **Live** | Map `span 5` · Corridor ranking `span 7` | District rain strip `span 4` · Camera wall 3×2 `span 5` · Alert + advice `span 3` |
| **Impact** | Scatter + fit `span 6` · Sensitivity bars `span 6` | Lag curve `span 4` · Peak vs off-peak `span 4` · Stats/method card `span 4` |
| **Replay** | Animated CI map `span 8` · Event list `span 4` | Timeline scrubber `span 8` · Camera strip `span 4` (+36 px toolbar: date, 1×/10×/60×) |
| **Loop** | Alert→decision funnel `span 5` · Forecast skill `span 7` | Decision timeline table `span 12` |
| **Trust** | Feed freshness `span 5` · Validity/gap heatmap `span 7` | Camera "No Service" `span 4` · Calibration error `span 4` · Provenance `span 4` |

### Visual rules

Dark theme, CI ramp blue→amber→red, map fills its panel, camera tiles letterbox 4:3 at ~170×105, KPIs the largest text.

### Acceptance test

```ts
await page.setViewportSize({ width: 1360, height: 735 });
const scrolled = await page.evaluate(() =>
  document.documentElement.scrollHeight > window.innerHeight ||
  document.documentElement.scrollWidth  > window.innerWidth);
expect(scrolled).toBe(false);
```

Screenshot all five pages at exactly 1360×735 into `report/figures/`.

### 9.1 Mockup — built, and now the visual reference

A static, no-backend mockup implements this contract and has been reviewed and accepted as the layout baseline. **It is the visual specification for the build**: when the real app is wired, these five screens are the thing to match.

- **Location:** `multimediaProj/mockup/` — open `index.html` directly, or `python -m http.server 8765` in that folder and visit `http://127.0.0.1:8765/`.
- **Pages:** `#live`, `#impact`, `#replay`, `#loop`, `#trust`; full-size captures in `mockup/screens/`.
- **Contract verified:** all five pages render at exactly 1360×735 with `scrollWidth`/`scrollHeight` equal to the viewport. The acceptance test above already passes on the mockup; there are no page errors.
- **Real data in it:** 429 TD detector positions across the six study districts; a real 08:23 rush-hour snapshot and a 03:00 free-flow baseline pulled through the data.gov.hk archive, which produce the congestion index and the corridor ranking; HAD district polygons; six live traffic-camera frames.
- **Simulated and labelled:** rainfall, impact scatter and fitted line, district sensitivities, lag curve, peak interaction, forecast skill, decision log, validity heatmap, and the 5-minute replay profile. A `MOCKUP` chip sits in the top bar.
- **Deliberate flaws:** the daily-rainfall feed is shown stale to 30 Sep and 4.2% camera unavailability is displayed, not hidden — the Trust page is demonstrating that the dashboard surfaces data quality.

**Data contract.** The mockup reads one generated object (`mockup/data/data.js`, built by `build_mock_data.py`) with top-level keys `meta`, `districts`, `detectors`, `cameras`, `rain`, `replay`, `impact`, `loop`, `trust`. That shape is the starting point for the FastAPI responses; the goal is to swap `data.js` for `/api/*` without touching layout or component structure.

**What carried over into the plan.** The Live map is framed on the detector extent, not the administrative boundary (the boundary layer includes far-flung islands and shrinks the city to a sliver); the map is hand-rendered SVG rather than tiles; charts use Chart.js 4.4.1 vendored locally, so there is no key and no network dependency at runtime.

---

## 10. The feedback loop

```
SENSE    detectors + rainfall + district weather (2-min polling)
   ↓
AWARE    CI map; alert when CI > P90(district, hour) AND rain > 0,
         or when the 30-min outlook crosses threshold
   ↓
DECIDE   actor picks and timestamps an action:
         commuter → leave now / delay 20 min / switch to rail
         operator → acknowledge + dispatch (simulated)
         planner  → flag corridor for review
   ↓
RE-MEASURE after 30/60 min: realised CI vs baseline and vs forecast
         → improved / unchanged / worse
   ↓
LEARN    hit rate, false-alarm rate, lead time, outcome delta; refit weekly
```

**Honesty clause:** actors are stand-ins; the loop is instrumented, not institutionally adopted. Alerts, decisions and outcomes are computed from live data, and the report publishes loop performance including false alarms.

---

## 11. Repository and run

```
multimediaProj/
  PLAN-v4.md
  mockup/   index.html  assets/  data/  screens/  build_mock_data.py  README.md
  requirements.txt
  server/  app.py db.py collector.py backfill.py analytics.py alerts.py
  analysis/ impact_model.py loop_eval.py  (reproduces every reported number)
  web/     src/pages/{Live,Impact,Replay,Loop,Trust}.tsx
           src/components/ src/lib/api.ts src/styles/tokens.css
  data/    app.db (gitignored) fixtures/
  report/  report.md figures/
  run.ps1  README.md
```

The mockup stays in the repository after the build starts: it is the reference implementation of the layout and the data contract, and `mockup/screens/` is the before/after record for the report.

Dev: `uvicorn server.app:app --reload` + `pnpm dev`.
Prod: `pnpm build` then `run.ps1` → `127.0.0.1:8000`.

---

## 12. Schedule (from 16 Nov, ~2 weeks)

| Block | Days | Work | Done when |
|---|---|---|---|
| **M0** | **done** | **Static mockup of all five pages (§9.1)** | **1360×735, no scroll, reviewed** |
| A | 1–2 | Install deps, schema, collector, fixtures, **live collection starts** | rows landing |
| B | 3–4 | Backfill + rain-day selection + dimensions | ≥40 days loaded |
| C | 5–6 | Derived tables, API, shell + Live/Trust | pages fit 1360×735 |
| D | 7–8 | Analytics + Impact | two numbers in hand |
| E | 9–10 | Alerts, decisions, Loop, Replay | ≥20 decisions logged |
| F | 11–12 | Layout audit, screenshots, report | deliverables complete |

---

## 13. Testing and acceptance

- **pytest:** parsers vs fixtures; dedupe on `(detector_id, ts)`; rain-day selection; aggregation invariants.
- **Integration:** 15-min run → rows in every table, no duplicates.
- **Quality:** validity >90%; traffic freshness <5 min; hourly rain <70 min.
- **Analysis:** `analysis/impact_model.py` reproduces every reported number (n, R², CI) from the DB alone.
- **Layout:** automated no-scroll assertion at 1360×735 on all five pages plus screenshot set. Already passing on the mockup (§9.1) for all five pages, with no page errors.
- **Loop:** every alert has a decision or expiry; every decision has an outcome or `pending`.

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| Dry season, few rain events | Backfill rainy days from daily history; if <5, extend window and pivot UC2 to peak-hour congestion |
| 766 feed IDs vs 807 locations | Inner join; unmatched surfaced in Trust |
| Install conflicts on 3.14 | Pinned versions, cp314 wheels pre-verified |
| Archive throttling | 2 req/s, checkpointed resume |
| Layout overflow at 735 px | Fixed rows, `minmax(0,…)`, 6–8 row tables, automated assertion |
| Scope creep | Hard stop: five pages, three use cases |

---

## 15. Deliverables

1. Static mockup (done): `multimediaProj/mockup/`, five pages at 1360×735, screenshots in `mockup/screens/`.
2. Working app: collector + API + five-page dashboard at 1360×735.
3. `requirements.txt`, one-command run, README with provenance.
4. Report: use cases · data register · architecture · data model · analytics · dashboards · feedback loop · evaluation · limitations.
5. Screenshot set and loop-metrics table.

---

## 16. Assumptions

- Deadline assumed end of November; longer allows the camera-derived congestion study and HKO radar context.
- Study set is six districts / ~300 detectors; the full network stays queryable.
- No cloud hosting, no API keys, no Docker; packages installed to the system interpreter.
- The unrelated wine-app brief in the requirements document is ignored.

---

## 17. Open questions for refinement

1. **Deadline** — is end of November right? It sets whether Block F is two days or a week.
2. **District set** — six districts for contrast, or fewer for depth (e.g., three)?
3. **Map rendering** — the mockup uses hand-drawn SVG framed on the detector extent. Keep that, or add real basemap tiles in the build?
4. **Camera metric** — cameras are illustrative in the mockup; is the visual-congestion proxy still worth the time-boxed effort?
5. **Loop realism** — simulated actors only, or do you want a human-in-the-loop mode where you log your own decisions during the demo?
6. **Report length and format** — any constraint, or free-form markdown → PDF?
7. **Freeze point** — anything to change in the mockup before it becomes the frozen layout for the build?
