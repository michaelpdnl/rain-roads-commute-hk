# Original PLAN-v4 §8 analytics

This internal worker retains Node-RED, MongoDB and Docker. It implements the original statistical methods rather than substituting simpler associations when their inputs are missing. It never downloads or synthesizes observations.

Run `python -m unittest discover -s analysis/tests -v` from the repository root. The tests use deterministic synthetic fixtures solely to verify estimators and failure states; fixture results never appear in the application.

## Inputs and reproducibility

`POST /compute` accepts either:

- `{rows:[{id,d,ts,speed,valid,hasVehicles,occupancy}], rain:[{d,ts,mm,publishedAt,fetchedAt,source,resolutionMinutes}], period:"all|peak|off"}` with raw source periods, or
- `{district:"all|Sha Tin|…", period:"all|peak|off", database:"rain_roads", days:90, asOf:"…Z"}`. This reads projected raw `traffic` and `district_rain` collections using `MONGO_URI`/`MONGO_DB`. `database`/`db` can select an isolated test DB. Reads are chunked, read-only, and bounded to at most 90 days. Missing database access returns HTTP 503; it does not turn into an empty-data success.

The response includes the actual query window, raw observation count/date range, `baselineProfiles` pairs keyed `detector|HKT-hour`, and `thresholdProfiles` keyed `district|HKT-hour`. P85 references use all eligible raw measured speeds, including valid measured stops, with at least 12 observations per detector/hour. The resulting P85 must be positive. CI is exactly `1-speed/P85`, including negative values above P85. District/hour P90 thresholds require 30 observed CIs. The main inference retains every eligible raw period, including speed ratios above 2. Duplicate detector/timestamp exports do not inflate n.

Reproduce a JSON export with:

```
python -m analysis.impact_model --input database-export.json --output result.json
```

Or reproduce directly from Mongo with a fixed snapshot upper bound:

```
python -m analysis.impact_model --mongo --district all --days 90 --as-of 2026-11-20T12:00:00Z --output result.json
```

The JSON CLI also works as `python analysis/impact_model.py …`. `--db` selects an isolated database. The output includes n, R², estimator CI, bootstrap CI/counts, method/script metadata and installed dependency versions. Changing the DB after the snapshot can still change results for that snapshot; preserve the export for an immutable analysis artifact.

## Inference

- Actual statsmodels OLS: `speed_ratio ~ rain + C(hour) + C(weekday)`, with HKT clock fields, detector-cluster sandwich covariance, finite-sample correction, and a t(G−1) 95% interval. Minimum quality gates are 60 periods, six detectors, 10 wet and 10 dry periods, and three distinct source rain windows of each type.
- All nuisance-control columns are considered before rain. Redundant nuisance columns may be removed only while preserving their complete span. A rain or rain×peak column contained in that span makes the original model unavailable. A singular fit never becomes a manufactured estimate through dropping the confounding control.
- Peak model is exactly `speed_ratio ~ rain * peak + C(hour)`. Peak means HKT weekdays 07:00–09:59 or 17:00–19:59. Both rain slopes must be identifiable. A redundant peak main effect can be absorbed by the hourly-control span.
- Actual statsmodels MixedLM uses the same fixed controls plus a random detector intercept, fitted by ML. Acceptance requires optimizer convergence, finite likelihood, finite usable inference covariance, positive residual variance and no invalid-Hessian warning. A zero random variance or boundary warning alone does not invalidate an otherwise usable fit. Rejected attempts include explicit diagnostics; another optimizer may fit the same MixedLM. If no attempt is usable, robustness remains unavailable.
- R² is undefined for constant speed-ratio responses and is returned as `null` with its reason, preserving strict finite JSON output.
- Benjamini–Hochberg q values adjust the estimable district slope family. Detector-only fits have one detector cluster, so the specified cluster covariance and detector-level FDR are explicitly unavailable. An alternate standard-error estimator is not introduced.
- Each estimable headline/main and district slope gets exactly 2,000 detector-block bootstrap draws. For draw multiplicities `w_g`, an expanded-row OLS refit has `X'X = Σ w_g X_g'X_g` and `X'y = Σ w_g X_g'y_g`. The worker uses this algebraically exact sufficient-statistic implementation to avoid allocating millions of repeated raw rows. Tests compare its draws against literal expanded-row statsmodels refits. This preserves the same samples and estimator. Successful/failed draw counts, reasons, seed and estimates are returned. A percentile CI is withheld when fewer than 95% of the 2,000 draws produce identifiable finite slopes.

## CCF and forecasting

CCF calls `statsmodels.tsa.stattools.ccf` in both directions over −30…+120 minutes. Positive lag means speed ratio follows rain. It requires explicit native rain resolution no coarser than 30 minutes, a grid that spans the requested endpoints, at least 30 overlapping observations at +120 minutes, a complete rainfall panel, a complete observed detector panel, and non-constant series. It does not interpolate, forward-fill rainfall, remove holes, or replace CCF with shifted Pearson correlations. Hourly HKO rainfall therefore leaves onset CCF unavailable. Finer-resolution source observations must actually exist before that result can become available.

Forecasts compare sklearn Ridge with persistence at 30, 60 and 120 minutes. Raw observations are grouped into 5-minute bins labeled at the right edge; the P85 membership remains each raw observation's actual HKT hour. The full clock includes unknown bins. `TimeSeriesSplit(n_splits=3, gap=horizonSlots)` runs on that clock before removing invalid pairs. Each fold fits hourly P85 references using only raw observations through its training-label cutoff, and fits `StandardScaler` using only its actual training pairs. The last training target precedes the first test origin. All three folds require ≥30 observed training and ≥10 test pairs, otherwise that horizon is unavailable. MAE and skill use all held-out predictions; zero persistence MAE leaves skill undefined.

Current CI, an optional observed 30-minute trend, occupancy, rainfall and HKT clock cycles supply features. Unknown occupancy/rain/trend have explicit missing indicators; their zero-valued feature placeholders are never represented as observed weather/traffic. Rain inputs require a source publication/fetch time no later than the origin. Future rainfall is never used. Network CI uses eligible observed detector periods with fold-specific references; changing detector coverage remains a limitation. `nTrain` sums training-pair counts across folds; `nTest` counts non-overlapping held-out pairs.

The same 30-minute routine runs separately per detector. `perDetectorOutlooks` contains detector-scope validated estimates or explicit unavailable states. Each exposes its own actual `sourceAt` and `originTs`. When that source timestamp differs from the model's bin-clock origin, the exact 30-minute detector alert prediction is withheld rather than relabeling a future bin edge as the source observation. A network forecast is never a detector-specific trigger. Rain reports expire after 70 minutes. Latest predictions fit only past observed input/target pairs after validation; no clipping changes the analytic CI definition.

`GET /health` stays responsive while the serialized compute route runs in FastAPI's thread pool. Docker binds port 8000 only inside the application network; the parent compose configuration must not publish it to the host. `OPENBLAS_NUM_THREADS=1` bounds dense linear-algebra threads. Processing the raw panel is memory-intensive; the database mode avoids a second large Node JSON copy. Main service caching/invalidation controls repeated computation.

API references: [statsmodels OLS](https://www.statsmodels.org/stable/generated/statsmodels.regression.linear_model.OLS.fit.html), [statsmodels CCF](https://www.statsmodels.org/stable/generated/statsmodels.tsa.stattools.ccf.html), [sklearn TimeSeriesSplit](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html).
