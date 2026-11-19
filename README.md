# Rain, Roads and the Commute

COMP7503: a Node-RED application combining real Hong Kong road measurements, HKO rainfall/weather and TD camera images. The dashboard reuses the teammate's layout, but obtains its measurements and statistics from MongoDB through Node-RED HTTP flows. The original static mockup remains in `mockup/`; it is not the running application.

## Review and run this branch

```powershell
git clone --branch codex/live-rain-roads https://github.com/michaelpdnl/rain-roads-commute-hk.git
cd rain-roads-commute-hk
```

Then follow the startup steps below. After this branch is merged, a normal clone of `main` uses the same commands. The working dashboard is already connected in `web/`; no additional manual integration with `mockup/` is needed. The teammate's existing prototype and plan are preserved in the repository.

The source repository contains the runnable application, tests and tools. The report draft, recorded measurements, captured images and Moodle ZIP are separate deliverables and are intentionally excluded from Git. A fresh checkout can build and collect new data without those files. Use the separately shared history snapshot if you want the same existing records as the original computer.

## Start on Windows

Install and start Docker Desktop with Linux containers. No separate Node.js, Node-RED or MongoDB installation is needed on the host.

Open PowerShell **in this project directory** and run:

```powershell
powershell -ExecutionPolicy Bypass -File tools/setup.ps1
docker compose up -d --build
```

Wait about 60–90 seconds for the first source requests, then open:

- Dashboard: <http://localhost:1881/>
- Node-RED editor: <http://localhost:1881/red/>

On Linux/macOS, copy `.env.example` to `.env` and replace both example values with independently generated hexadecimal strings before running the same `docker compose up -d --build` command. The PowerShell setup helper is only for generating those local values on Windows. Each host uses its own `.env`; do not copy or commit another host's credentials.

The classroom example at port 1880 is a separate project. This dashboard has five pages, a map, actual camera images and computed charts; do not use the classroom `/ui` page for this project.

```powershell
docker compose ps
docker compose logs --tail 40 node-red
docker compose stop
docker compose start
```

The collector runs while Docker and these containers are running, even if the browser is closed. Sleep, shutdown or network outages cause collection gaps. A public server is optional; Docker alone does not provide an always-on computer. Ports bind to this computer only, and MongoDB is not published to the host.

## Include the collected history

The separately shared assignment ZIP includes `history/`, an actual data snapshot and captured images. This folder is not part of the Git checkout. An image contains the program; volumes contain accumulated runtime data. Copy the shared `history/` folder into your checkout and restore it **after the first successful start**:

```powershell
docker cp history rain-roads-node-red:/tmp/submitted-history
docker exec rain-roads-node-red node /opt/commute/tools/data.cjs restore /tmp/submitted-history
docker compose restart node-red
```

Restore upserts by record ID and does not delete other records. Refresh the dashboard. The supplied history ends at the export time; the collector then adds current observations. It cannot recover periods when nobody collected data, except the specific road XML files available from the official archive.

To create your own history snapshot:

```powershell
docker exec rain-roads-node-red node /opt/commute/tools/data.cjs export /data/commute/export
docker cp rain-roads-node-red:/data/commute/export ./history-latest
```

Do not run `docker compose down -v` unless you intend to delete this project's stored history and flows. `stop`, `start`, `restart`, and `down` without `-v` preserve named volumes.

## Source catalog and polling

| Data | Catalog | Source cadence / our timer | Use |
|---|---|---|---|
| TD speed, volume, occupancy + locations | [Strategic / major roads](https://data.gov.hk/en-data/dataset/hk-td-sm_4-traffic-data-strategic-major-roads) | XML approximately 1 minute / poll 2 minutes; metadata daily | Road map, ranking, speed/occupancy correlation, time comparisons |
| HKO station rainfall | [Rainfall in the past hour](https://data.gov.hk/en-data/dataset/hk-hko-rss-rainfall-in-the-past-hour) | 15 minutes / poll 15 minutes | Stored station measurements and source-quality context |
| HKO district weather / rainfall | [Current weather report](https://data.gov.hk/en-data/dataset/hk-hko-rss-current-weather-report) | Hourly and when updated / poll 10 minutes | District rainfall joined to road observations; temperature context |
| TD camera metadata + JPEGs | [Traffic snapshot images](https://data.gov.hk/en-data/dataset/hk-td-tis_2-traffic-snapshot-images) | Images approximately 2 minutes / capture 2 minutes | Six actual camera views, persistent image files and timed replay |
| Archived HKO hourly RSS + TD XML | Same current-weather and road catalogs above | Actual archive versions | Historical wet-weather pairs, baselines and research |
| HKO daily rainfall | [Daily rainfall](https://data.gov.hk/en-data/dataset/hk-hko-rss-daily-total-rainfall) | Monthly publication of daily totals | Select dates for denser archive sampling; never substituted for hourly rain |

Study districts: Kwun Tong, Yau Tsim Mong, Sha Tin, Yuen Long, Tsuen Wan and Sham Shui Po. Every department endpoint is linked from a DATA.GOV.HK catalog entry. Current catalog metadata determines actual detector and camera counts; no fixed old count is assumed.

Optional, verified road-history import (seven selected official files, not continuous days):

```powershell
docker exec rain-roads-node-red node /opt/commute/tools/backfill.cjs
```

The HKO JSON archives are unavailable for the checked endpoints, but the same catalog's English **RSS** has hourly historical versions. To acquire the verified October research period:

```powershell
docker exec rain-roads-node-red node /opt/commute/tools/backfill.cjs --research --start 20261001 --end 20261031
```

The importer lists actual archive timestamps, samples TD every half hour on dates with HKO daily rain and six slots on other dates, and imports hourly RSS versions. It limits archive downloads to two per second and skips successful imports on rerun. This takes several minutes and needs a network connection. The verified run imported 1,139 files with no failures. An unlisted RSS district remains **unknown**, not zero; daily totals do not supply hourly measurements. Archive source time and download provenance remain stored. Sampling is intentionally denser on wet dates and is not a random sample of all Hong Kong traffic.

## What each page does

1. **Live:** measured congestion index (`CI = clamp(1 - speed / historical P85, 0, 1)`), corridor ranking, rain, actual camera captures, observed alerts and a network CI outlook.
2. **Impact:** speed-ratio/rain scatter; district sensitivity with approximate 95% detector-cluster intervals; lagged associations; controlled rain×peak interaction; actual model terms, counts and limits. Unestimable selections are identified explicitly.
3. **Replay:** actual stored source timestamps, CI/rain timeline, observed rain/congestion/gap events, playback rates and exact road frames. Images appear only when a capture exists within the preceding three minutes. Missing history is never interpolated.
4. **Loop:** persisted alert episodes, actual decision/outcome funnel, chronological forecast errors against persistence, and a real choice log for commuter/operator/planner roles. Outcomes compare road speed at +30 minutes (within 10 minutes). Choices do not send dispatch instructions or establish causal travel benefits.
5. **Trust:** source timing/failures; a seven-day, 24-hour validity heatmap with unknown cells; measured JPEG retrieval availability; 30/60/120-minute forecast MAE; provenance and storage scope.

The global district filter applies to roads, analyses and camera selections. The six rainfall cards remain regional context. The dashboard refreshes every 30 seconds; collection timers run in Node-RED independently.

## Methods and storage

- Node-RED collection tab: timer → source URL → core HTTP Request node → JavaScript validation / transformation → MongoDB upsert. Camera downloads and metadata use the shared Node.js service called by Node-RED function nodes. The second tab implements dashboard, replay, image and decision HTTP APIs.
- `lib/core.cjs` contains tested parsing, joins and descriptive statistics. `lib/service.cjs` supplies MongoDB access and acquisition helpers, loaded through `functionGlobalContext` in `settings.js`. This is not a separate Python/FastAPI backend.
- Traffic documents use `(detector ID, source observation time)` as a unique ID. Only valid lanes with plausible speed/volume contribute. Speed is vehicle-volume weighted across valid lanes. Periods with no observed vehicles are excluded from speed analyses; stopped vehicles with nonzero volume remain valid.
- District rain is the **maximum reported within a district**, not a road-level sensor. The latest rain window ending no later than the road observation is joined by district only when at most 30 minutes old. Missing values are null, not zero. Rainfall windows overlap and repeated detector-periods are not independent samples.
- The research model uses one detector/rain-window/hour mean, controls for available hour and weekday categories, and computes detector-cluster sandwich standard errors with approximate normal 95% intervals. Redundant control columns are removed explicitly. It requires wet and dry windows and sufficient detector clusters; a constant-rain sample is not fitted. Detectors sharing a rain report and overlapping time windows still create dependence not fully captured by these intervals. This is descriptive, not causal; the p-value is not a validated operational guarantee.
- Free-flow reference is the detector's historical P85 from at least 12 nonzero valid observations. It is an empirical reference, not a speed limit or independently established uncongested speed. Road/season/date mix and unequal wet-date sampling can confound effects. Lag charts compare earlier hourly rain with later speed ratio; they cannot identify a precise minute of rainfall onset.
- Research selects up to 120,000 archived detector/hour snapshots and 60,000 recent live detector/5-minute means within 90 days. Each mean uses only actual captured observations, not a continuously observed hour. Separate quotas preserve both rainy archives and current road conditions. Raw records remain stored. Scatters are reduced to about 1,200 rendering points; computation uses the selected sample. Replay selects the actual source timestamp represented by each stored bin.
- Network forecasts use ridge regression on then-available CI, prior change, occupancy, rainfall availability and hour. The free-flow reference is fitted before the holdout cut; feature scaling is learned only from training pairs. Training target timestamps precede held-out input timestamps. Reported MAE compares predictions with measured +30/+60/+120-minute targets (up to five minutes late) and persistence. Negative skill is displayed honestly. Sparse intervals are not interpolated; results are limited research validation, not verified commuter guidance.
- MongoDB persists in `mongo_data`; flows and JPEGs persist in `node_data`. Records retain source observation time and fetched time. Official archive imports retain requested time and resolved URL. Image timestamps record retrieval time; JPEG success does not imply the image is free of “No Service” text.

The original demo's “No Service” **image-content** percentage has no validated labelled image set here, so it is not claimed as implemented. Trust reports actual HTTP/JPEG attempts instead. Historical pictures from before capture began cannot be recovered by inventing frames. Decision counts remain zero until people actually log choices; dispatching real vehicles and measured queue length are not supplied by these sources.

## Reproducibility and tests

The Dockerfile pins Node-RED and MongoDB base images by digest; `package-lock.json` pins the MongoDB driver and XML parser. `flows.json` is the exported runnable flow, generated by `tools/build-flows.cjs`.

With host Node.js, run `npm ci` and `npm test` for the pure tests. To include the real-MongoDB integration test without installing host dependencies:

```powershell
docker exec rain-roads-node-red mkdir -p /opt/commute/tests
docker cp tests/. rain-roads-node-red:/opt/commute/tests/
docker exec -e INTEGRATION=1 -w /opt/commute rain-roads-node-red node --test tests/core.test.cjs tests/history.test.cjs tests/analytics.test.cjs tests/service.test.cjs
```

The integration test uses a randomly named `rain_roads_test_*` database and deletes only that test database. Fixture records never enter the production dashboard. Tests cover CSV encodings, invalid lanes, timestamps, missing values, bounded non-future joins, constant rainfall, deduplication, failed-source preservation, decision validation and observed outcome evaluation.

## Submission files

The teacher's PDF asks for one ZIP containing the exported Node-RED flow, a Docker Hub ID **or Docker description file**, and a report. The prepared assignment ZIP supplies `flows.json`, `Dockerfile` + `compose.yaml` + reproducible source, `report/Project-Report.pdf`, and the optional history snapshot. The report/history are shared separately from Git. `tools/report.py` and `tools/package.ps1` require those local report inputs and history files; they are not needed to start the application. A Docker Hub push and cloud server are not required by the PDF. `ACCEPTANCE.md` maps the assignment to the implementation and records checks.

`PLAN-v4.md` and `mockup/` remain the teammate's original proposal and prototype. Their simulated measurements, forecast scores and invented decision log are not used. The five panel groups now use measured history and computed analyses, with remaining evidence limits stated above. The desktop composition is 1360×735 and scales to the available viewport.

Before Moodle submission, enter both students' names/IDs in the report source and regenerate the PDF, and review the project together. Credentials in `.env` are local and excluded from the ZIP.
