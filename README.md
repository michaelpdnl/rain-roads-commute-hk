# Rain, Roads and the Commute

COMP7503A traffic and rainfall dashboard. `PLAN-v4.md` defines the analytical methods and acceptance criteria; `mockup/` is the five-page visual reference. The running interface is in `web/`, served by Node-RED. Mockup measurements and simulated findings are not application evidence.

This version is shared on **`codex/align-original-local`**. Clone that complete branch to run it; merging into `main` is not a prerequisite. The original time/data acceptance criteria remain incomplete; see `ACCEPTANCE.md`. The previous pull request was withdrawn. Current report, screenshots, runtime evidence and database snapshots are local artifacts excluded from Git; cloning source does not transfer historical observations or camera files. A fresh installation starts collecting new data, and historical import/backfill is a separate operation described below. The earlier history snapshot and submission ZIP describe an older implementation and must not be submitted as this version. Do not clone the deleted `codex/complete-dashboard` branch.

## Start on Windows

Start Docker Desktop with Linux containers. Open PowerShell in this project directory:

```powershell
powershell -ExecutionPolicy Bypass -File tools/setup.ps1
docker compose up -d --build
```

Compose runs three internal services: Node-RED, MongoDB, and the Python analytics worker. Node-RED orchestrates collection, storage, maintenance and HTTP APIs; the worker performs the original statsmodels/sklearn analyses against raw MongoDB data. Only Node-RED publishes a host port. The worker and database stay on the private Compose network. Node-RED, MongoDB and Docker meet the assignment and the user's explicit deployment requirements; this overrides the original plan's older no-Docker/SQLite/FastAPI deployment assumption, without changing its statistical requirements.

Open the dashboard at [http://localhost:1881/](http://localhost:1881/) and the Node-RED editor at [http://localhost:1881/red/](http://localhost:1881/red/). The classroom example on port 1880 is a separate project. Initial source collection and raw-data analysis take time; inspect service health and logs rather than treating an old cached report as a successful new run.

```powershell
docker compose ps
docker compose logs --tail 40 node-red analytics
docker compose stop
docker compose start
```

On Linux/macOS, copy `.env.example` to `.env` and replace both example values with independently generated hexadecimal strings before starting Compose. Each host uses its own credentials. The Windows helper generates these values; host installations of Node-RED, MongoDB and Python are not required for the container run.

The collector continues with the browser closed while the computer is awake, online and running its containers. Sleep, shutdown, network failure and source outages create gaps. Docker does not establish ten days of unattended operation by itself. `stop`, `start`, `restart`, and `down` without `-v` preserve named volumes. `docker compose down -v` deletes this project's stored volumes.

### Upgrade an existing container

The Node-RED data volume can retain an earlier deployed flow after an image rebuild. Back it up, install the current export, then restart:

```powershell
docker cp rain-roads-node-red:/data/flows.json ./flows-before-upgrade.json
docker compose up -d --build
docker cp flows.json rain-roads-node-red:/data/flows.json
docker compose restart node-red
```

Keep the flow backup locally if it contains manual changes. Final verification must compare the deployed flow with `flows.json`.

## Sources, collection and history

| Data | DATA.GOV.HK catalog | Source / collection cadence |
|---|---|---|
| TD speed, volume, occupancy and locations | [Strategic / major roads](https://data.gov.hk/en-data/dataset/hk-td-sm_4-traffic-data-strategic-major-roads) | Road XML approximately each minute; poll 2 minutes; metadata daily |
| HKO station rainfall | [Rainfall in the past hour](https://data.gov.hk/en-data/dataset/hk-hko-rss-rainfall-in-the-past-hour) | Poll 15 minutes; retain actual source resolution |
| HKO district weather / rainfall | [Current weather report](https://data.gov.hk/en-data/dataset/hk-hko-rss-current-weather-report) | Hourly and when updated; poll 10 minutes |
| TD camera metadata / JPEGs | [Traffic snapshot images](https://data.gov.hk/en-data/dataset/hk-td-tis_2-traffic-snapshot-images) | Capture six selected district views every 2 minutes |
| Archived TD XML / HKO hourly RSS | Same road and current-weather catalogs | Import actual listed archive versions with provenance |
| HKO daily rainfall | [Daily rainfall](https://data.gov.hk/en-data/dataset/hk-hko-rss-daily-total-rainfall) | Classify backfill dates only; never replace hourly observations |

Study districts are Yuen Long, Sha Tin, Tsuen Wan, Kwun Tong, Sham Shui Po and Yau Tsim Mong. Actual catalog coverage determines detector counts. Traffic stores unique detector/source-time periods, district rain stores reported district maxima, and camera timestamps describe retrieval. Polling does not observe every intervening source period.

The original backfill cadence is **10 minutes on known wet dates and 60 minutes on known dry dates**, with two archive downloads per second and resumable import records. Missing daily classification is unknown and skipped. Trace rainfall is wet. Daily totals only choose the sampling cadence; they do not become hourly rainfall. The current original-plan run requests 40 calendar dates, 22 September through 31 October 2026:

```powershell
docker exec rain-roads-node-red node /opt/commute/tools/backfill.cjs --research --start 20260922 --end 20261031
```

Check actual successful traffic imports on all 40 dates, failures, unknown classifications and source coverage. Requesting 40 dates is not evidence that 40 dates were loaded. Sampled imports do not establish continuous live coverage or ten days of uptime. Hourly historical weather comes from actual English RSS archive versions where the JSON archive endpoint is unavailable; an unlisted district remains unknown. Before-capture historical camera frames remain unavailable. Optional isolated snapshots imported without `--research` do not satisfy the 40-day criterion.

### Recover official history without a data package

After pulling `codex/align-original-local`, run `docker compose up -d --build` so the image includes the new scripts. No local database export is needed. The default window is the previous 30 days, ending at command start. First inspect available archive listings (no database connection, observation downloads or file writes):

```powershell
docker exec rain-roads-node-red node /opt/commute/tools/recover.cjs --days 30 --preview
```

To perform recovery on the machine/server running these containers:

```powershell
docker exec rain-roads-node-red node /opt/commute/tools/recover.cjs --days 30
```

This additional maximum-available command leaves the original `backfill.cjs --research` sampling rule unchanged. It imports **every listed traffic and weather RSS version**, splitting truncated archive listings. It does not require daily rain classifications before recovering traffic. A month can involve tens of thousands of downloads, many GB and hours of work; preview prints request counts and a minimum request-time estimate, not duration/storage guarantees. Requests are limited to two starts per second with transient-error retries. Do not run multiple recovery processes concurrently. Live collection can continue.

| Source | Recovery behavior |
|---|---|
| Traffic XML | All listed versions; study-district observations retain source timestamps; detector/time duplicates are removed. |
| Current-weather RSS | Actual reports, observation-clock temperature/humidity and explicitly reported hourly district rain. Missing fields remain missing. RSS does not recreate all fields of the live weather JSON. |
| HKO regional rainfall pages | Tries each nominal hourly page; uses its actual stated observation window (often ending at `:45`), retaining reported regions/ranges. An unbounded “currently no rainfall” statement is retained as text, without invented hourly zeros. |
| HKO daily rainfall | Fetches each requested year's published CSV, preserving daily/trace/unknown values and reporting unpublished dates. Annual files refresh on rerun; daily values are not converted to hourly rain. |
| Station rain JSON / weather JSON / six selected camera JPEGs | Probes official archive listings. The tested sources returned 404; no historical records/photos were recovered from them. Future available versions are attempted and validated, not guaranteed. |

Imports are checkpointed for their **exact time window**; failures retry on rerun and existing observations are preserved. Copy the printed `resumeArguments` with frozen `--from`/`--to` timestamps to resume the same run. A new `--days` invocation has a newly sliding window. Example syntax (replace timestamps with printed values):

```powershell
docker exec rain-roads-node-red node /opt/commute/tools/recover.cjs --from 2026-10-21T04:00:00.000Z --to 2026-11-20T04:00:00.000Z
```

Alternatively use `--start YYYYMMDD --end YYYYMMDD` for inclusive Hong Kong dates. Reports persist under `/data/commute/recovery/`: listed/candidate files, imported files, inserted records, checkpoint skips, dates with observations, dates without recovered observations, unavailable archives and errors are separate. Successful requests do not prove complete time coverage. Exit 2 indicates incomplete discovery, failed files, or no listed traffic; unavailable optional archives are reported separately. Preview does not validate observation-file content; `--report` is ignored in preview to preserve no-write behavior.

Unarchived or deleted versions/photos cannot be reconstructed. Unknown publication times stay unknown and do not become earlier forecast availability times. Current metadata matches historical detector IDs; removed/renamed IDs may not match. Recovery cannot establish continuous uptime or supply missing fine-resolution rainfall for the original CCF method. Git contains code/instructions, not recovered records or credentials.

Small real-source local verification creates/drops a separate `rain_roads_test_recovery_*` database and downloads only five sample files plus metadata/archive checks:

```powershell
docker exec rain-roads-node-red node /opt/commute/tools/verify-recovery.cjs --real
```

The November 20 test imported/read back 868 traffic observations, one weather record with station temperatures/humidity, seven regional rain observations, 39 daily totals and three raw reports; rerunning inserted zero duplicates. These are sample counts, not a 30-day recovery. Temporary data/files were deleted.

### Export or restore a history snapshot

Runtime records and camera files are separate from Git. A snapshot is dated evidence, not automatically the latest state. To export:

```powershell
docker exec rain-roads-node-red node /opt/commute/tools/data.cjs export /data/commute/export
docker cp rain-roads-node-red:/data/commute/export ./history-latest
```

To restore a separately supplied `history/` folder after a successful first start:

```powershell
docker cp history rain-roads-node-red:/tmp/submitted-history
docker exec rain-roads-node-red node /opt/commute/tools/data.cjs restore /tmp/submitted-history
docker compose restart node-red
```

Restore upserts by record ID and preserves other records. Regenerate the snapshot manifest and restore verification after the current backfill before calling it a current submission. Earlier counts and restore checks do not verify this version.

## Original analytical methods

`analysis/README.md` documents input fields, exact estimators, quality gates and reproduction commands. The Python worker reports unavailable methods with reasons; missing inputs do not authorize replacement statistics.

- **Free flow and CI:** P85 uses eligible raw measured speed, including valid measured stops, separately for each detector and HKT hour. Each profile needs at least 12 actual observations and a positive P85. `CI = 1 - speed / P85` is not clamped: speeds above P85 yield negative CI. Zero-volume/no-vehicle periods do not become measured stops.
- **Scope and joins:** original inference reads all eligible raw periods in the selected study districts within 90 days. There are no 120,000/60,000 archive/live quotas and no detector/hour averaging for OLS. Duplicate detector/time rows do not inflate n. District rain joins retrospectively at or before the road source time, at most 70 minutes old; unknown rain stays null. Forecast rain additionally needs publication/fetch availability by its origin.
- **Rain sensitivity:** actual statsmodels OLS fits `speed_ratio ~ rain + C(hour) + C(weekday)`, with detector-cluster covariance, finite-sample correction and t(G-1) 95% intervals. Full nuisance-control spans are preserved. Insufficient wet/dry windows, too few clusters or confounding leave the model unavailable.
- **Robustness and multiplicity:** actual ML MixedLM fits the same controls plus a detector random intercept and reports optimizer, convergence, covariance and warning diagnostics. Each estimable headline/district slope receives exactly 2,000 detector-block bootstrap draws with actual successful/failed counts. Benjamini-Hochberg adjusts the estimable district family. Detector-only clustered inference/FDR is unavailable with a single cluster; another SE estimator is not substituted.
- **Peak interaction:** `speed_ratio ~ rain * peak + C(hour)`, with HKT weekday peaks 07:00-09:59 and 17:00-19:59. Both original rain slopes require independent variation.
- **Onset lag:** `statsmodels.tsa.stattools.ccf` over -30 to +120 minutes requires real sufficiently fine rainfall observations and complete source panels. Current hourly rain cannot support it. The CCF panel remains unavailable; shifted Pearson correlations, interpolated rain and invented onset times are not alternatives.
- **Forecasts:** Ridge versus persistence uses `TimeSeriesSplit(n_splits=3)` on a complete 5-minute clock with horizon purge gaps, unknown bins retained, and actual input/target pairs only. Every fold fits hourly P85 and `StandardScaler` from allowed training data. Horizons are 30/60/120 minutes; each needs three usable folds. Separately validated detector-specific 30-minute forecasts are the only forecast triggers for detector alerts. A source/bin-origin mismatch withholds an exact 30-minute detector prediction. No network forecast is relabeled as a detector forecast.

Scatter points may be reduced for rendering; this does not reduce the inference input. Effects are observational and can remain confounded by shared weather, repeated periods, season and uneven archive sampling. Negative forecast skill and failed robustness fits remain visible.

## Five pages and the measured feedback loop

The visual target is the original five-page 1360x735 mockup with zero page scroll. New captures and automated viewport checks are required for the current runtime.

| Page | Original behavior / evidence |
|---|---|
| Live | Hourly-P85 CI, ranking, actual rain/camera captures; district/hour P90 rain alerts and eligible detector 30-minute threshold-crossing alerts |
| Impact | Raw rain/speed-ratio pairs, original controlled district slopes/intervals, MixedLM/bootstrap/FDR diagnostics, peak interaction, and unavailable CCF with its source-resolution reason |
| Replay | Actual timestamps, exact-frame CI, events/playback; gaps remain gaps; only a qualifying prior camera capture appears |
| Loop | Associated alert/decision episodes; original role actions; actual CI remeasurement at +30 and +60 minutes; baseline/forecast deltas, hit/false-alarm denominators and observed lead time |
| Trust | Freshness, validity/gaps, forecast calibration, provenance, and explicitly unavailable camera image-content No Service metric |

Alert rule: observed `CI > P90(district, HKT hour)` with positive observed rain, or a matching validated detector 30-minute forecast crossing that threshold. An alert expires or is linked to a timestamped decision. Original actions are commuter leave-now/delay20/switch-rail, operator acknowledge/dispatch-simulated, and planner flag-review. Actors are simulated stand-ins; source observations are actual. No physical dispatch or causal travel improvement is asserted.

Decision outcomes compare same-detector/road CI at +30 and +60 minutes, using actual source observations in target through target+10-minute windows. Missing closed windows are censored; open windows remain pending. Initial CI, persistence baseline and an available detector forecast are frozen; missing forecasts remain null. A decision is evaluated only with actual evidence at both horizons. False alarms need eligible actual observations; unobserved intervals cannot establish no congestion. Weekly model-refit scheduling also requires runtime evidence.

The original Trust **image-content No Service** rate needs validated labels and a validated detector. It remains pending; HTTP/JPEG download success is separate source health and does not complete that panel. The optional camera congestion proxy cannot be claimed without its 100 labelled-frame calibration.

## Verification and original acceptance

No older test total, screenshot, archive-file count or report proves the current runtime. `ACCEPTANCE.md` records the original requirements and evidence still needed. The original **10 days unattended / 95% feed uptime**, **40 dates backfilled**, **two quantified findings plus an honest negative result**, and **20 alert-associated decisions with actual outcomes** remain required. Missing elapsed time or source data is pending acceptance, not an implemented substitute.

With host Node.js, `npm ci` then `npm test` runs the Node pure tests. The analytics image supplies pinned Python dependencies:

```powershell
docker exec -w /app rain-roads-analytics python -m unittest discover -s analysis/tests -v
```

See `analysis/README.md` for the JSON/Mongo CLI reproducing original n, R-squared, estimator/2,000-bootstrap intervals and diagnostics. Real-Mongo integration and runtime/browser checks must use current built services and save fresh results. Fixtures are isolated test inputs; fixture output never becomes a dashboard finding. Final machine evidence is `artifacts/original-runtime-verification.json`; `report/evidence.json` is the corresponding API response. Test summaries are in `artifacts/original-test-results.json` when generated.

## Report and submission

The assignment PDF requires DATA.GOV.HK streams, Node-RED programming, Docker/MongoDB storage, analysis/correlation, a dashboard and a report explaining use cases and implementation. Moodle receives one ZIP containing the flow, a Docker Hub ID **or Docker description file**, and report. Cloud hosting is not required; the original plan's additional acceptance criteria above still apply.

After verification, capture all five current pages in `report/screenshots/` and replace `report/evidence.json`. `tools/report.py` rejects the earlier analysis shape and requires current runtime evidence; it builds PDF, editable Markdown and a provenance manifest. Supply real student names/IDs in optional `report/authors.json`; absent identities stay unfilled. No names or decisions are invented.

`tools/package.ps1` includes both application Docker descriptions, `analysis/`, pinned Python/Node dependencies, flows, runtime source, original plan/mockup, current report/evidence and a supplied history snapshot. It checks report input/output hashes before packaging. The existing ZIP remains older until this succeeds with final current evidence. Local `.env` credentials are excluded. Report/history/verification artifacts are shared separately from Git; the complete system and recovery code are delivered on `codex/align-original-local`.

Current checks: 42 Node/Mongo/worker tests and 20 Python tests passed; all five pages were checked at 1360x735 without page scrolling. Full-history calculation retains every eligible raw observation; the worker is limited to 2.5 GiB with no container swap to protect the host. Initial full-history computation takes several minutes; subsequent dashboard requests use cached research results. See report/Project-Report.pdf and artifacts/original-runtime-verification.json for the captured results, not a claim of ten days of unattended operation.
