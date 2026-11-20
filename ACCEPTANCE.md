# Original-plan acceptance and evidence

`PLAN-v4.md` and `mockup/` define the intended methods, feedback loop, visual contract and success criteria. Node-RED, MongoDB and Docker remain explicit user/assignment requirements. Their deployment replaces the plan's older stack assumption; it does not relax its method or acceptance requirements.

Source is shared on `codex/align-original-local`; PR #2 remains closed and its old remote branch was removed. Current runtime/browser checks and the regenerated seven-page report were verified locally for the original methods. Reports, evidence, database snapshots and images are excluded from Git. The existing history export and submission ZIP remain older artifacts and must not be treated as this version. Full original-project acceptance remains incomplete for the time/data criteria below.

## Original success criteria

| PLAN-v4 requirement | Evidence required | Current acceptance state |
|---|---|---|
| At least 10 days unattended and at least 95% feed uptime | Continuous dated monitoring interval, source attempt/success denominators, gaps and measured uptime | Unproven. A running container and imported history cannot establish elapsed unattended operation. |
| At least 40 days traffic backfilled plus live accumulation | Successful provenance and actual traffic observations on at least 40 distinct HKT dates, failures and coverage | Verified: actual observations on all 40 HKT dates, 22 Sep-31 Oct 2026. The archive plan selects 2,400 traffic versions at original wet/dry cadence; resumed run completed with zero failures and no unknown daily classifications. See original-data-audit.json and original-backfill-summary.json. |
| Two quantified findings plus one honest negative result | Reproducible raw-data output with n, effect size, intervals and producing script | Verified in the current report: adjusted rain association, three-fold 30-minute forecast comparison, and non-significant Tsuen Wan association with sample size, interval and BH q. Unsupported CCF remains a data limitation, not the negative result. |
| Five pages at 1360x735 without page scroll, matching mockup | Five current screenshots and automated viewport/no-error/no-scroll results | Verified for all five application pages: 1360x735, no page scroll, six loaded actual JPEGs, original actor actions and unavailable states. See original-browser-verification.json. |
| At least 20 alerts, each with a decision and auto-computed outcome | Unique associated actual-source alerts; original actions; actual same-detector +30/+60-minute CI evidence | Unproven. No fabricated actor choices, observations or outcomes may fill this threshold. |
| One-command run and report with screenshots | Current Compose startup, persistence checks, report/evidence, five captures and verified ZIP | Compose services are healthy, actual runtime/API/replay checks pass, and report PDF/Markdown plus five screenshots were regenerated and visually inspected. A current ZIP/history export has not been produced; old ZIP is not this version. |

## Method and panel alignment

| Original requirement | Contract to verify | Data / inference limits |
|---|---|---|
| Detector/hour P85; exact CI | Raw eligible speeds including measured stops; at least 12 per detector/HKT hour; positive P85; `CI = 1-speed/P85` without clamping | No-vehicle periods excluded. Missing reference gives unavailable CI. |
| Raw inference | All eligible raw records in selected districts within 90 days; no 120k/60k quotas or detector/hour averaging | Sampled archives are observations, not continuous panels. |
| District rain sensitivity | statsmodels OLS `speed_ratio ~ rain + C(hour) + C(weekday)`; corrected detector-cluster t(G-1) intervals | Wet/dry, cluster and window gates; nuisance-control span retained; non-identifiable models unavailable. |
| Mixed-effects robustness | Actual ML MixedLM detector random intercept, diagnostics and optimizer outcomes | Convergence alone is insufficient; invalid likelihood/covariance/Hessian inference rejected with reasons. |
| Bootstrap | Exactly 2,000 detector-block refits per estimable headline/district slope; seed, success/failure counts and percentile CI | Exact sufficient-statistic refits preserve raw-row OLS. CI withheld below 95% usable draws. |
| Multiple comparisons | Benjamini-Hochberg on estimable district model families | Detector-only clustered inference/FDR undefined with one cluster; no alternate SE substituted. |
| Peak interaction | `speed_ratio ~ rain * peak + C(hour)` | Confounded terms unavailable; confounding controls are preserved. |
| CCF -30 to +120 minutes | Actual statsmodels CCF on supported complete native-time grid | Current hourly rainfall too coarse: unavailable. No shifted Pearson, interpolation or inferred rainfall. |
| Forecast vs persistence | Three TimeSeriesSplit folds on full 5-minute clock; horizon gap; fold-only P85/scaling; actual pairs; 30/60/120 minutes | Unknown bins remain gaps; insufficient folds unavailable; negative skill retained. |
| Detector outlook alerts | Separately validated detector 30-minute model, matching source timestamp and exact target | A network average is not substituted. |
| Original alerts | Positive rain and CI above district/hour P90, or validated detector 30-minute threshold crossing | Missing threshold/source/forecast can prevent an alert. |
| Feedback | Associated original actions, frozen baseline/forecast; actual same-detector +30/+60 CI; denominators and observed lead time | Simulated actors; actual source observations; pending/censored states explicit; no causal/dispatch benefit. |
| Replay | Exact source frames and same-frame CI; eligible prior capture only | No invented traffic frames or old images. |
| Trust No Service content rate | Validated labelled images and content detector | Pending data/validation. HTTP/JPEG download success does not satisfy it. |
| Optional camera congestion proxy | Original 100 labelled-frame calibration and correlation evaluation | Unclaimed without calibration evidence. |

## Acquisition and runtime verification

- Backfill uses original wet 10-minute / dry 60-minute cadence, checkpointing and at most two archive requests per second. Known trace dates are wet. Unknown daily classification is skipped. Daily totals never become hourly rain.
- HKO hourly RSS and TD XML archives retain source timestamps, requested/resolved URLs and download provenance. Unlisted district rain stays unknown. Live collection retains observation/fetch times and failures.
- MongoDB and camera files persist in named volumes. Export and restore a current snapshot into an isolated database with checked collection/image manifests before calling it a verified submission snapshot.
- Python fixture tests check estimators and unavailable states; Node tests check parsers, ingestion, alerts/feedback, APIs and persistence. Pure tests alone do not establish integration, runtime output, layout or uptime.
- Final current checks belong in `artifacts/original-runtime-verification.json`, test summaries in `artifacts/original-test-results.json`, and corresponding API data in `report/evidence.json`. Failed/skipped/unrun checks and unavailable methods remain explicit.
- Regenerate five screenshots, PDF/Markdown and report provenance from current evidence. Regenerate the ZIP only after report input/output hashes match. Existing report/snapshot/ZIP files remain older artifacts until then.

## Assignment submission

The teacher's PDF requires one ZIP with exported Node-RED flow, Docker Hub ID or Docker description file, and report; it also requires DATA.GOV.HK streams, analysis/correlation, dashboard and storage. It does not prescribe 10 days, 40 days or 20 decisions. Those are nevertheless the original project acceptance criteria and remain in force here. Cloud deployment and Docker Hub push are not necessary for the PDF's file requirement.

Both students must review the actual findings and provide real names/IDs. No identities or completion claims may be invented. The code branch is shared at the user's request; it does not itself include a database transfer or establish final submission acceptance.

## Current local verification

42 Node/Mongo/worker integration tests passed, zero skipped; 20 Python tests passed. All raw-history inference completed with about 930 MiB peak process RSS under a 2.5 GiB container limit. Runtime flow has 40 nodes and matches flows.json. Source lag is displayed honestly; Docker running does not guarantee provider data is current. Full-size five-page captures and the seven-page report are current. The original 10-day/95% uptime, 20 fully evaluated decisions, validated camera-content labels, and sufficiently fine/continuous CCF input remain unmet. Student names/IDs also remain to be supplied.
