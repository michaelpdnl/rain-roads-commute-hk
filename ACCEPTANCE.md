# Assignment acceptance record

Checked against the actual `Programming Assignment.pdf` (4 pages) and the supplied Docker setup guide on 17 November 2026. This maps the delivered implementation to the teacher's requirements; extra features in the teammate's earlier plan are not treated as official requirements.

This source checkout contains the application, tests and reproducibility instructions. The paths under `report/` and `history/`, and the assignment ZIP described below, refer to separately shared submission artifacts. They are not required to build or run the application from Git and are intentionally not committed.

| Teacher requirement | Delivered implementation | Evidence |
|---|---|---|
| Streams acquired from DATA.GOV.HK | TD roads and images, HKO station rainfall and current weather; department resources linked from catalog entries | Running collection flow; source list in README and quality page |
| Programming in Node-RED | 36-node export: collection timers, HTTP requests, validation/storage function nodes and dashboard HTTP endpoints | `flows.json`; editor at `/red/`; export checked against deployed `/red/flows` |
| Docker programming environment and MongoDB | Pinned Node-RED app image + MongoDB image, private network, persistent volumes | `Dockerfile`, `compose.yaml`; both containers healthy |
| Analysis and correlation | Valid-lane weighted road speed, district/hour comparisons, Pearson speed/occupancy correlation, timestamped district-rain join and conditional rain/speed fit | Tests and actual API result in `report/evidence.json`; no invented wet-weather finding |
| Dashboards presenting smart-city insights | Live, Analysis, Replay, Decisions, Data quality, with actual imagery, timestamps and selection controls | Browser renders in `report/screenshots/` |
| Store data early | Automatic storage, seven selected official historical road files, supplied collected history | `history/manifest.json`, actual JSONL records and JPEGs; missing historical rain remains missing |
| Written use cases, implementation, storage and explanation of views | Six-page illustrated report, editable Markdown and generator | `report/Project-Report.pdf` / `.md`; `tools/report.py` |
| Exported flow + Docker Hub ID OR Docker description + report in one ZIP | Exported flow, Docker description and source, report and history in one package | ZIP produced by `tools/package.ps1` |
| Clear reproduction procedure | Startup, local URLs, stop/start, data restore, tests and limitations | `README.md`; `先看这里.md` |

## Verification actually performed

- Unit and real-MongoDB integration run: **7 tests passed, 0 failures, 0 skipped**. Real database tests use an isolated random test DB, removed afterwards. Assertions cover parsing/encoding, weighted valid lanes, HKT time, missing values, no future rain, constant-rain rejection, HTTP failures/redirects, duplicate upserts, preservation on source failure, valid decisions, observed outcomes, older pending decisions beyond the 30-record display limit, and stale-camera status.
- Container recreation: traffic record count was **12,074 before** and **12,939 after**; prior records were retained. The original classroom setup at port 1880 was preserved.
- Automatic collection check: non-archive source timestamps spanned **21:31:30 to 21:47:00 HKT (15.5 minutes)** with **7,794 records**, and **60 actual JPEG captures** had been stored at that check. This verifies repeated collection; it does not imply every intervening 30-second source period was captured.
- Backup/restore: a snapshot of **11,208 traffic records** plus metadata, weather, station rain, image metadata and files restored into a separate test database with matching per-collection counts; the temporary restore database was then removed. The package snapshot is subsequently refreshed and carries its own exact counts in `history/manifest.json`.
- Browser: all five tabs rendered, live cameras loaded, district selection worked, actual stored replay loaded, charts showed computed data and source lag remained visible. Only an initial missing favicon request occurred; an application icon was added and the final reload was clean.
- Independent code review: two findings were fixed with regression checks (stale image labelling and evaluation of pending decisions outside the latest-30 display window). Final review reported no remaining actionable issue in the reviewed implementation.

## Boundaries of the results

The official PDF has no fixed dataset count, minimum observation days, mandatory forecast, minimum report length, mandatory video/audio or public-cloud hosting requirement. This does not replace the need for a real analysis: measured results and sample limits are in the report. The initial collection is dry, so no reliable rain effect is asserted. More collection, including wet episodes, will strengthen that part of the analysis.

The optional public server discussed earlier would provide an always-running host; it is not required for local collection or this submission format. The app stops collecting when its host sleeps, shuts down, loses connectivity or stops Docker. The submitted history snapshot plus subsequent collection cannot fill an unobserved interval automatically.

No repository push, cloud deployment or Moodle submission has been made. Team members should review the final results and enter any desired report identification before submitting.
