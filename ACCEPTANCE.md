# Assignment and dashboard acceptance

The official PDF asks for DATA.GOV.HK streams, Node-RED, Docker, analysis/correlation, a dashboard, storage and a report. The Moodle ZIP contains the exported flow, Docker description and report. It does not require a public server or the original plan's 10 days / 40 days / 20 decisions.

## Original dashboard panels

| Page | Implemented with actual data | Evidence limits |
|---|---|---|
| Live | Empirical P85 congestion index; ranked roads; rain; timed JPEGs; observed alerts; network outlook | P85 is a sample reference, not an official congestion definition; outlook is not journey time |
| Impact | Speed-ratio/rain scatter; controlled district slopes and approximate detector-cluster intervals; lag associations; peak interactions; model card | Hourly archive rain cannot identify precise minute-level onset; sparse or rank-deficient selections are explicit; not causal |
| Replay | Actual source frames; CI/rain timeline; threshold/rain/gap events; frame-playback speeds; corresponding images | Gaps are not interpolated; no images exist from before capture began |
| Loop | Actual alert episodes, decisions, evaluated road outcomes and funnel; chronological model/persistence errors; commuter/operator/planner choice log | Counts can be zero; no invented choices, dispatch, queue length or causal benefit |
| Trust | Feed freshness; 7×24 validity heatmap; actual JPEG-attempt success; forecast MAE by horizon; provenance | Missing hours grey. Retrieval success does not classify image-content “No Service”; no validated labelled set supplied |

## Acquisition and reproducibility

- Runtime uses 38 exported Node-RED nodes and a private MongoDB service in persistent Docker volumes.
- Current traffic, rain, weather and six actual JPEGs are automatically acquired. Raw source observation time and fetch time are retained.
- October research import: 1,139 listed archive versions downloaded and imported, zero failures in the verified run. Hourly HKO RSS and sampled TD XML are from the existing official catalogs. Daily HKO rainfall only selects denser sampling dates.
- Regional rain absent from an RSS report remains unknown. No daily value is converted into hourly rainfall. Sampled archive snapshots are not continuous days of observations.
- Research quotas preserve both archived hourly snapshots (up to 120,000 detector bins) and current 5-minute live bins (up to 60,000), within 90 days. Raw MongoDB records remain stored.
- Forecast free-flow reference and feature scaling use only the pre-holdout training period. Training target times precede test input times. Observed target matching is bounded to five minutes after each horizon; no gap interpolation. Negative forecast skill is displayed.
- Legacy backup restore accepts absent new optional collections but rejects missing original core collections. Restore streams JSONL in bounded batches and upserts without clearing other records.

## Checks

- Actual MongoDB test suite: **23 passed, 0 failed, 0 skipped**. Test databases are randomly named `rain_roads_test_*` and are removed after checks.
- Tests cover encodings, valid lanes, time zones, missing values, archived rain ranges/midnight, exact archive selection, deduplication, old rainy records, P85, controlled clustered regression, redundant controls, lag direction, forecast time isolation/gaps, real alert episode deduplication, roles, pending outcomes, stale images and legacy backups.
- `tools/verify.cjs` verifies deployed flow equality, real statistics, six JPEGs, area filter, exact stored replay, invalid inputs, heatmap, loop counts, chronological forecast evaluation and current outlook timestamps.
- Five pages use the original 1360×735 composition, scaled to the available viewport. Browser captures and final evidence are supplied separately in `report/`, not committed to Git.

Before Moodle submission, both students must review the actual findings and fill their names/IDs in the report. Server deployment is a separate, not-yet-performed step.
