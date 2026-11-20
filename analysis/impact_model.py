"""PLAN-v4 §8 inference and JSON CLI; accepts raw DB-export JSON, never synthetic fallback.

Run: python -m analysis.impact_model --input database-export.json --output result.json
The exported rows/rain document is the sole data input, so n/R²/CI are reproducible.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import warnings

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    __package__ = 'analysis'

import numpy as np
import pandas as pd
import statsmodels.api as sm
from statsmodels.stats.multitest import multipletests
from statsmodels.tsa.stattools import ccf
from scipy.stats import t as student_t

from .data import (HKT, baseline_profiles, compact_source, enrich, iso, join_rain,
                   progress, rainfall_table, release_memory, traffic_table)

BOOTSTRAP_RESAMPLES = 2000
STUDY = ('Yuen Long', 'Sha Tin', 'Tsuen Wan', 'Kwun Tong', 'Sham Shui Po', 'Yau Tsim Mong')


def _model_table(rows):
    if isinstance(rows, pd.DataFrame) and rows.attrs.get('originalModelTable'):
        return rows
    needed = ['id', 'd', 'ts', 'ratio', 'rain', 'rainTs']
    data = rows[[name for name in needed if name in rows]].copy(deep=False) if isinstance(rows, pd.DataFrame) else pd.DataFrame.from_records(rows)
    data = compact_source(data)
    for name in ('ratio', 'rain', 'id', 'd', 'ts'):
        if name not in data:
            data[name] = pd.Series(index=data.index, dtype='object')
    for name in ('ratio', 'rain'):
        data[name] = pd.to_numeric(data[name], errors='coerce')
    data['ts'] = pd.to_datetime(data.ts, utc=True, errors='coerce', format='mixed')
    valid = (data[['ratio', 'rain', 'id', 'd', 'ts']].notna().all(axis=1)
             & np.isfinite(data.ratio) & np.isfinite(data.rain) & data.ratio.ge(0) & data.rain.ge(0))
    if not valid.all():
        data = data.loc[valid]
    local = data.ts.dt.tz_convert(HKT)
    data['hour'], data['weekday'] = local.dt.hour.astype(np.int8), local.dt.dayofweek.astype(np.int8)
    data['peak'] = ((data.weekday < 5) & (data.hour.between(7, 9) | data.hour.between(17, 19))).astype(np.int8)
    if 'rainTs' not in data:
        data['rainTs'] = data.ts
    data = data.reset_index(drop=True)
    data.attrs['originalModelTable'] = True
    return data


def _counts(data):
    wet, dry = data.rain > 0, data.rain == 0
    def windows(mask):
        return len(data.loc[mask, ['d', 'rainTs']].drop_duplicates())
    return dict(n=len(data), clusters=int(data.id.nunique()), wet=int(wet.sum()), dry=int(dry.sum()),
                wetWindows=windows(wet), dryWindows=windows(dry))


def _select_gram(gram, required):
    """Keep the full nuisance span first; never discard a control to identify rain."""
    diagonal = np.maximum(np.diag(gram), 0)
    scale = np.sqrt(diagonal)
    normalized = np.divide(gram, np.outer(scale, scale), out=np.zeros_like(gram), where=np.outer(scale, scale) > 0)
    chosen = []
    order = [i for i in range(len(gram)) if i not in required] + list(required)
    for index in order:
        candidate = chosen + [index]
        independent = diagonal[index] > 0 and np.linalg.eigvalsh(normalized[np.ix_(candidate, candidate)])[0] > 1e-10
        if independent:
            chosen.append(index)
        elif index in required:
            raise ValueError('Rain or rain×peak is not identifiable independently of the complete nuisance-control span.')
    return chosen


def _design(data, interaction=False):
    # Identical Patsy treatment coding, constructed directly into one N×p
    # buffer instead of retaining nuisance/full/selected dense copies.
    hours, weekdays = sorted(data.hour.unique()), sorted(data.weekday.unique())
    terms = ['Intercept', *[f'C(hour)[T.{int(hour)}]' for hour in hours[1:]]]
    terms += ['peak'] if interaction else [f'C(weekday)[T.{int(day)}]' for day in weekdays[1:]]
    nuisance_count = len(terms)
    terms.append('rain')
    if interaction:
        terms.append('rain:peak')
    matrix = np.empty((len(data), len(terms)), dtype=np.float64, order='F')
    matrix[:, 0] = 1.
    column = 1
    for hour in hours[1:]:
        matrix[:, column] = data.hour.to_numpy() == hour
        column += 1
    if interaction:
        matrix[:, column] = data.peak.to_numpy()
    else:
        for day in weekdays[1:]:
            matrix[:, column] = data.weekday.to_numpy() == day
            column += 1
    matrix[:, nuisance_count] = data.rain.to_numpy()
    if interaction:
        matrix[:, nuisance_count + 1] = data.rain.to_numpy() * data.peak.to_numpy()
    required = list(range(nuisance_count, len(terms)))
    chosen = _select_gram(matrix.T @ matrix, required)
    names = [terms[i] for i in chosen]
    if chosen != list(range(len(terms))):
        # Chosen indices are increasing; compact leftwards without another N×p allocation.
        for destination, source in enumerate(chosen):
            if destination != source:
                matrix[:, destination] = matrix[:, source]
        matrix = matrix[:, :len(chosen)]
    return matrix, names, [term for i, term in enumerate(terms) if i not in chosen]


def _eligible(data):
    counts = _counts(data)
    if (counts['n'] < 60 or counts['clusters'] < 6 or min(counts['wet'], counts['dry']) < 10
            or min(counts['wetWindows'], counts['dryWindows']) < 3):
        return counts, 'Need ≥60 valid raw periods, ≥6 detector clusters, ≥10 wet/dry periods and ≥3 distinct source windows of each type.'
    return counts, None


def fit_controlled(rows, interaction=False):
    data = _model_table(rows)
    counts, reason = _eligible(data)
    result = dict(available=False, **counts)
    if reason:
        return dict(result, reason=reason)
    try:
        matrix, terms, dropped = _design(data, interaction)
        if len(data) <= matrix.shape[1]:
            return dict(result, reason='No residual degrees of freedom for the original controlled model.')
        fitted = sm.OLS(data.ratio.to_numpy(float), matrix, hasconst=True).fit(
            cov_type='cluster', cov_kwds={'groups': data.id.to_numpy(), 'use_correction': True, 'df_correction': True}, use_t=True)
        index = terms.index('rain')
        interval = fitted.conf_int(alpha=.05)[index]
        if not np.all(np.isfinite([fitted.params[index], fitted.bse[index], *interval, fitted.pvalues[index]])):
            return dict(result, reason='The specified cluster covariance or interval is non-finite; no inferential fit reported.')
        # statsmodels' rsquared divides by centered_tss. It is undefined for a
        # constant response, rather than a JSON-safe infinite effect measure.
        tss = float(fitted.centered_tss)
        r_squared = 1 - float(fitted.ssr) / tss if tss > 0 and np.isfinite(tss) else None
        r_squared_reason = 'R² is undefined for a constant speed-ratio response.' if tss == 0 else None
        if r_squared is not None and not np.isfinite(r_squared):
            r_squared, r_squared_reason = None, 'R² is numerically undefined for this fitted response.'
        result.update(available=True, reason=None, slope=float(fitted.params[index]), se=float(fitted.bse[index]),
                      lo=float(interval[0]), hi=float(interval[1]), p=float(fitted.pvalues[index]),
                      r2=r_squared, r2Reason=r_squared_reason, terms=terms, coefficients=fitted.params.tolist(), droppedTerms=dropped,
                      formula='speed_ratio ~ rain * peak + C(hour)' if interaction else 'speed_ratio ~ rain + C(hour) + C(weekday)',
                      method='statsmodels OLS; detector-cluster covariance with finite-sample correction; t(G−1) 95% CI',
                      samplingUnit='eligible raw detector-period; no rain-window averaging', inferenceDf=counts['clusters'] - 1)
        if interaction:
            other = terms.index('rain:peak')
            covariance = np.asarray(fitted.cov_params())
            peak = fitted.params[index] + fitted.params[other]
            peak_se = np.sqrt(max(0., covariance[index, index] + covariance[other, other] + 2 * covariance[index, other]))
            critical = student_t.ppf(.975, counts['clusters'] - 1)
            result['interaction'] = dict(off=result['slope'], peak=float(peak), offLo=result['lo'], offHi=result['hi'],
                                         peakLo=float(peak - critical * peak_se), peakHi=float(peak + critical * peak_se),
                                         difference=float(fitted.params[other]), differenceP=float(fitted.pvalues[other]))
        return result
    except (ValueError, np.linalg.LinAlgError) as error:
        return dict(result, reason=str(error))


def cluster_bootstrap(rows, seed=7503):
    """Exactly 2,000 detector draws; sufficient-statistic refits equal literal block OLS.

    For draw counts w_g, the expanded-row normal equations are
    X_b'X_b = Σ_g w_g X_g'X_g and X_b'y_b = Σ_g w_g X_g'y_g.
    This changes allocation/runtime only, not resamples, observations, or estimator.
    """
    data = _model_table(rows)
    counts, reason = _eligible(data)
    output = dict(available=False, requested=BOOTSTRAP_RESAMPLES, attempted=0, converged=0, failed=0,
                  nSuccess=0, nFailed=0,
                  lo=None, hi=None, estimates=[], seed=seed, samplingUnit='detector blocks',
                  n=len(data), clusters=counts['clusters'],
                  method='Percentile 95% CI; exact OLS sufficient-statistic refit of 2000 detector-cluster resamples')
    if reason:
        return dict(output, reason=reason)
    try:
        matrix, terms, _ = _design(data)
    except (ValueError, np.linalg.LinAlgError) as error:
        return dict(output, reason=str(error))
    ids = sorted(data.id.unique())
    y = data.ratio.to_numpy(float)
    gram, cross = [], []
    group_positions = data.groupby('id', sort=True, observed=True).indices
    for detector in ids:
        positions = group_positions[detector]
        block = matrix[positions]
        gram.append(block.T @ block)
        cross.append(block.T @ y[positions])
    gram, cross = np.asarray(gram), np.asarray(cross)
    del matrix, y, block, group_positions
    release_memory()
    rain_index = terms.index('rain')
    rng, estimates, failures = np.random.default_rng(seed), [], {}
    for _ in range(BOOTSTRAP_RESAMPLES):
        draw = rng.choice(len(ids), size=len(ids), replace=True)
        weights = np.bincount(draw, minlength=len(ids))
        sampled_gram = np.einsum('g,gij->ij', weights, gram)
        sampled_cross = weights @ cross
        try:
            chosen = _select_gram(sampled_gram, [rain_index])
            beta = np.linalg.solve(sampled_gram[np.ix_(chosen, chosen)], sampled_cross[chosen])
            slope = float(beta[chosen.index(rain_index)])
            if not np.isfinite(slope):
                raise ValueError('non-finite slope')
            estimates.append(slope)
        except (ValueError, np.linalg.LinAlgError) as error:
            key = 'non-identifiable/singular resampled design' if 'identif' in str(error) or isinstance(error, np.linalg.LinAlgError) else str(error)
            failures[key] = failures.get(key, 0) + 1
    output.update(attempted=BOOTSTRAP_RESAMPLES, converged=len(estimates), failed=BOOTSTRAP_RESAMPLES - len(estimates),
                  nSuccess=len(estimates), nFailed=BOOTSTRAP_RESAMPLES - len(estimates),
                  estimates=estimates, failureReasons=failures, convergenceRate=len(estimates) / BOOTSTRAP_RESAMPLES)
    if len(estimates) >= 1900:
        lo, hi = np.quantile(estimates, [.025, .975])
        output.update(available=True, reason=None, lo=float(lo), hi=float(hi))
    else:
        output['reason'] = 'Fewer than 95% of the 2000 actual resamples had an identifiable finite slope; percentile CI withheld.'
    return output


def mixed_robustness(rows):
    data = _model_table(rows)
    counts, reason = _eligible(data)
    output = dict(available=False, converged=False, n=len(data), clusters=counts['clusters'],
                  method='statsmodels MixedLM; same fixed controls; random detector intercept; ML')
    if reason:
        return dict(output, reason=reason)
    try:
        matrix, terms, dropped = _design(data)
    except (ValueError, np.linalg.LinAlgError) as error:
        return dict(output, reason=str(error))
    diagnostics = []
    for optimizer in ('lbfgs', 'bfgs'):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter('always')
            try:
                fitted = sm.MixedLM(data.ratio.to_numpy(float), matrix, groups=data.id.to_numpy()).fit(
                    reml=False, method=optimizer, maxiter=300, disp=False)
                index = terms.index('rain')
                interval = np.asarray(fitted.conf_int())[index]
                likelihood = float(fitted.llf)
                covariance = np.asarray(fitted.cov_params(), dtype=float)
                covariance_finite = covariance.ndim == 2 and np.isfinite(covariance).all()
                minimum_eigenvalue = None
                covariance_usable = False
                if covariance_finite:
                    eigenvalues = np.linalg.eigvalsh((covariance + covariance.T) / 2)
                    minimum_eigenvalue = float(eigenvalues[0])
                    tolerance = 1e-10 * max(1., float(np.max(np.abs(eigenvalues))))
                    covariance_usable = bool(minimum_eigenvalue >= -tolerance
                                             and np.all(np.diag(covariance)[:len(terms)] > 0))
                fixed_finite = bool(np.isfinite(fitted.fe_params).all()
                                    and np.isfinite(fitted.bse_fe).all()
                                    and np.all(np.asarray(fitted.bse_fe) > 0)
                                    and np.isfinite(np.asarray(fitted.conf_int())[:len(terms)]).all()
                                    and np.isfinite(np.asarray(fitted.pvalues)[:len(terms)]).all())
                warning_text = list(dict.fromkeys(str(w.message) for w in caught))
                invalid_hessian = any('hessian' in message.lower() and
                                      ('not positive definite' in message.lower() or 'invalid' in message.lower())
                                      for message in warning_text)
                variance = float(np.asarray(fitted.cov_re)[0, 0])
                invalid_reasons = []
                if not fitted.converged:
                    invalid_reasons.append('Optimizer did not converge.')
                if not np.isfinite(likelihood):
                    invalid_reasons.append('Log likelihood is not finite.')
                if invalid_hessian:
                    invalid_reasons.append('Estimated Hessian is not valid for inference.')
                if not covariance_usable:
                    invalid_reasons.append('Inference covariance is non-finite or not positive semidefinite with positive fixed-effect variances.')
                if not fixed_finite:
                    invalid_reasons.append('Fixed-effect estimates or their inference are not finite and usable.')
                if not np.isfinite(fitted.scale) or fitted.scale <= 0:
                    invalid_reasons.append('Residual variance is not finite and positive.')
                if not np.isfinite(variance) or variance < 0:
                    invalid_reasons.append('Random-intercept variance is not finite and nonnegative.')
                accepted = not invalid_reasons
                diagnostics.append(dict(optimizer=optimizer, converged=bool(fitted.converged), accepted=accepted,
                                        logLikelihood=likelihood if np.isfinite(likelihood) else None,
                                        inferenceCovarianceUsable=covariance_usable and not invalid_hessian,
                                        minimumCovarianceEigenvalue=minimum_eigenvalue,
                                        invalidReasons=invalid_reasons, warnings=warning_text))
                if accepted:
                    return dict(output, available=True, converged=True, reason=None, optimizer=optimizer,
                                slope=float(fitted.fe_params[index]), se=float(fitted.bse_fe[index]),
                                lo=float(interval[0]), hi=float(interval[1]), p=float(fitted.pvalues[index]),
                                randomInterceptVariance=variance, logLikelihood=likelihood,
                                inferenceCovarianceUsable=True,
                                terms=terms, droppedTerms=dropped, diagnostics=diagnostics)
                del fitted
                release_memory()
            except (ValueError, np.linalg.LinAlgError, ArithmeticError) as error:
                diagnostics.append(dict(optimizer=optimizer, converged=False, accepted=False, error=str(error),
                                        invalidReasons=[str(error)],
                                        warnings=list(dict.fromkeys(str(w.message) for w in caught))))
    return dict(output, reason='MixedLM did not converge to a finite inferential fit; no substitute robustness statistic.', diagnostics=diagnostics)


def apply_fdr(models, family='districts'):
    eligible = [model for model in models if model and model.get('available', True) and model.get('p') is not None and np.isfinite(model['p'])]
    if not eligible:
        return
    reject, q, _, _ = multipletests([model['p'] for model in eligible], alpha=.05, method='fdr_bh')
    for model, adjusted, significant in zip(eligible, q, reject):
        model.update(q=float(adjusted), fdr=dict(method='Benjamini–Hochberg', family=family,
                                               tests=len(eligible), q=float(adjusted), reject=bool(significant)))


def ccf_curve(rows, rainfall):
    empty = [dict(minutes=i, r=None, n=0) for i in range(-30, 121)]
    output = dict(available=False, points=empty, method='statsmodels.tsa.stattools.ccf',
                  convention='Positive minutes: speed ratio follows rainfall; negative minutes: speed ratio leads rainfall.')
    rain = rainfall_table(rainfall)
    if rain.empty or rain.resolutionMinutes.isna().any() or (rain.resolutionMinutes > 30).any():
        return dict(output, reason='Original rainfall source resolution is hourly, unknown, or coarser than 30 minutes; −30…+120 minute CCF unavailable.')
    steps = rain.resolutionMinutes.unique()
    if len(steps) != 1 or steps[0] <= 0 or abs(30 / steps[0] - round(30 / steps[0])) > 1e-8:
        return dict(output, reason='Source resolution cannot support an evenly spaced −30…+120 minute CCF grid.')
    step = float(steps[0])
    data = pd.DataFrame.from_records(rows) if not isinstance(rows, pd.DataFrame) else rows.copy()
    if data.empty or 'ratio' not in data:
        return dict(output, reason='No observed speed-ratio series for CCF.')
    data['ts'] = pd.to_datetime(data.ts, utc=True, errors='coerce', format='mixed')
    data['ratio'] = pd.to_numeric(data.ratio, errors='coerce')
    data = data.dropna(subset=['ts', 'ratio'])
    if data.empty:
        return dict(output, reason='No observed speed-ratio series for CCF.')
    districts = sorted(data.d.unique())
    rain = rain[rain.d.isin(districts)]
    if set(rain.d) != set(districts):
        return dict(output, reason='Rainfall source gaps include an unobserved district; CCF unavailable.')
    start = max(data.ts.min(), rain.ts.min())
    end = min(data.ts.max(), rain.ts.max())
    clock = pd.date_range(start, end, freq=pd.Timedelta(minutes=step))
    required_lag = int(round(120 / step))
    if len(clock) < required_lag + 30:
        return dict(output, reason='Need a complete source-resolution series with ≥30 overlapping observations at +120 minutes.')
    rain_matrix = rain.pivot(index='ts', columns='d', values='mm').reindex(index=clock, columns=districts)
    # No rain interpolation/forward-fill and no removing gaps before calling ccf.
    if rain_matrix.isna().any().any():
        return dict(output, reason='Rainfall source gaps break the complete, evenly spaced CCF grid.')
    period_ns = int(pd.Timedelta(minutes=step).value)
    elapsed = data.ts.astype('int64') - start.value
    data['clock'] = pd.to_datetime(start.value + ((elapsed + period_ns - 1) // period_ns) * period_ns, utc=True)
    traffic_matrix = data.pivot_table(index='clock', columns='id', values='ratio', aggfunc='mean').reindex(clock)
    if traffic_matrix.empty or traffic_matrix.isna().any().any():
        return dict(output, reason='Traffic observation gaps break the complete, evenly spaced CCF grid; no interpolation performed.')
    speed, amounts = traffic_matrix.mean(axis=1).to_numpy(), rain_matrix.mean(axis=1).to_numpy()
    if np.std(speed) == 0 or np.std(amounts) == 0:
        return dict(output, reason='CCF undefined for a constant observed speed/rain series.')
    positive = ccf(speed, amounts, adjusted=True, fft=True, nlags=required_lag + 1)
    negative = ccf(amounts, speed, adjusted=True, fft=True, nlags=int(round(30 / step)) + 1)
    points = [dict(minutes=float(k * step), r=float(positive[k] if k >= 0 else negative[-k]), n=len(clock) - abs(k))
              for k in range(-int(round(30 / step)), required_lag + 1)]
    return dict(output, available=True, reason=None, points=points, resolutionMinutes=step, n=len(clock),
                fromTs=iso(clock[0]), throughTs=iso(clock[-1]), detectors=len(traffic_matrix.columns), districts=len(districts))


def compute(payload):
    from .forecast_model import forecast
    input_scope = dict(storage='provided raw JSON')
    if 'rows' not in payload:
        from .database import load_database
        payload, input_scope = load_database(payload)
    trace = input_scope['storage'] == 'MongoDB'
    def stage(name, **counts):
        release_memory()
        if trace:
            progress(name, **counts)
    period = payload.get('period', 'all')
    # A Mongo payload is owned by this computation. Release its original frame
    # references immediately; JSON callers retain their input contract unchanged.
    raw = traffic_table(payload.pop('rows') if trace else payload.get('rows', []))
    rain = rainfall_table(payload.pop('rain') if trace else payload.get('rain', []))
    stage('normalized', observations=len(raw), dataBytes=int(raw.memory_usage(deep=True).sum()))
    profiles = baseline_profiles(raw)
    stage('raw-hourly-p85', profiles=len(profiles))
    joined = join_rain(enrich(raw, profiles), rain)
    if period not in ('all', 'peak', 'off'):
        raise ValueError('period must be all, peak, or off')
    selected = joined if period == 'all' else joined[joined.peak == (period == 'peak')]
    threshold_input = joined.loc[joined.ci.notna(), ['d', 'hour', 'ci']]
    threshold_groups = threshold_input.groupby(['d', 'hour'], observed=True).ci
    threshold_counts = threshold_groups.count()
    thresholds = {f'{district}|{int(hour)}': float(value)
                  for (district, hour), value in threshold_groups.quantile(.9).items()
                  if threshold_counts.loc[(district, hour)] >= 30}
    sample = _model_table(selected)
    source_summary = dict(input_scope, observations=len(raw), valid=int(raw.eligible.sum()),
                          start=iso(raw.ts.min()) if len(raw) else None, end=iso(raw.ts.max()) if len(raw) else None,
                          dates=int(raw.ts.dt.tz_convert(HKT).dt.floor('D').nunique()),
                          ratioObservations=int(joined.ratio.notna().sum()), matchedRainObservations=len(sample))
    lag = ccf_curve(selected, rain)
    if not lag['available']:
        for point in lag['points']:
            point['reason'] = lag.get('reason')
    points = sample.iloc[::max(1, int(np.ceil(len(sample) / 1200)))][['rain', 'ratio']]
    point_records = [dict(x=float(amount), y=float(ratio)) for amount, ratio in points.itertuples(index=False, name=None)]
    del joined, selected, threshold_input, threshold_groups, threshold_counts, points
    stage('impact-input-ready', observations=len(sample), dataBytes=int(sample.memory_usage(deep=True).sum()))
    stage('pooled-ols-start', observations=len(sample))
    main = fit_controlled(sample)
    stage('pooled-ols-done', observations=len(sample), available=main['available'])
    if main['available']:
        stage('pooled-bootstrap-start', observations=len(sample))
        main['bootstrap'] = cluster_bootstrap(sample)
        stage('pooled-bootstrap-done', successes=main['bootstrap']['converged'])
        stage('pooled-mixedlm-start', observations=len(sample))
        main['mixed'] = mixed_robustness(sample)
        stage('pooled-mixedlm-done', available=main['mixed']['available'])
    districts = []
    for district in dict.fromkeys([*STUDY, *sample.d.unique()]):
        part = sample[sample.d == district]
        stage('district-ols-start', observations=len(part), district=district)
        model = fit_controlled(part)
        interaction = fit_controlled(part, interaction=True)
        stage('district-ols-done', observations=len(part), district=district, available=model['available'])
        if model['available']:
            stage('district-bootstrap-start', observations=len(part), district=district)
            model['bootstrap'] = cluster_bootstrap(part)
            stage('district-bootstrap-done', district=district, successes=model['bootstrap']['converged'])
            stage('district-mixedlm-start', observations=len(part), district=district)
            model['mixed'] = mixed_robustness(part)
            stage('district-mixedlm-done', district=district, available=model['mixed']['available'])
        districts.append(dict(d=district, model=model if model['available'] else None,
                              interaction=interaction.get('interaction'),
                              interactionModel=interaction if interaction['available'] else None,
                              reason=model.get('reason'), interactionReason=interaction.get('reason')))
    apply_fdr([entry['model'] for entry in districts])
    apply_fdr([entry['interactionModel'] for entry in districts], family='district peak-interaction rain slopes')
    impact = dict(model=main if main['available'] else None, districts=districts, lag=lag['points'],
                  lagAvailable=lag['available'], lagReason=lag.get('reason'), lagMethod=lag['method'], lagDetails={k: v for k, v in lag.items() if k != 'points'},
                  points=point_records,
                  n=len(sample), wet=int((sample.rain > 0).sum()), dry=int((sample.rain == 0).sum()),
                  message='Descriptive association, not causal. All eligible raw periods; HKT hour/weekday controls; detector-cluster t intervals.' if main['available'] else main['reason'],
                  resolution='Original rain reports are joined retrospectively to traffic at report time, maximum age 70 min. CCF is withheld unless native source resolution and continuity support it.',
                  detectorFdr=dict(available=False, reason='A detector-only model has one detector cluster; the specified detector-cluster covariance is undefined. No alternate SE method substituted.'))
    del sample, part
    stage('forecast-start', observations=len(raw))
    predictions = forecast(raw, rain)
    stage('forecast-done', models=len(predictions['models']))
    return dict(impact=impact, forecast=predictions,
                baselineProfiles=list(profiles.items()), thresholdProfiles=thresholds,
                source=source_summary,
                baseline=dict(method='Raw measured speed P85 including valid zero speeds by detector and HKT hour; ≥12 observations and positive P85 per profile',
                              profiles=len(profiles), detectors=len({key.rsplit('|', 1)[0] for key in profiles}), observations=len(raw)),
                methods=dict(available=True, reference='PLAN-v4.md §8', script='analysis/impact_model.py',
                             bootstrap='Exactly 2000 detector-block draws with exact OLS sufficient-statistic refits; percentile CI and actual success/failure counts.',
                             mixed='ML MixedLM detector random intercept; actual optimizer convergence and diagnostics.',
                             fdr='Benjamini–Hochberg across estimable district models.',
                             dependencies=dict(numpy=np.__version__, pandas=pd.__version__, statsmodels=sm.__version__ if hasattr(sm, '__version__') else __import__('statsmodels').__version__)),
                limitations=['Observational associations cannot establish causal rain effects.',
                             'Source gaps and unsupported rainfall resolution leave original CCF unavailable.',
                             'Detector-only clustered inference/FDR is undefined with one cluster.',
                             'P85 quality gate: ≥12 eligible raw speeds including measured zeros per detector/HKT hour and positive resulting P85; valid/hasVehicles flags respected. Ratios above 2 are retained.',
                             'Forecast test targets and references/scalers use only data permitted by each chronological training fold.'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--input', type=Path, help='JSON export containing raw rows and rain arrays')
    source.add_argument('--mongo', action='store_true', help='Read raw Mongo collections using MONGO_URI/MONGO_DB')
    parser.add_argument('--district', default='all')
    parser.add_argument('--db', help='Optional database selection for isolated integration datasets')
    parser.add_argument('--period', default='all', choices=['all', 'peak', 'off'])
    parser.add_argument('--as-of', help='Timezone-aware upper query bound for reproducible Mongo snapshot')
    parser.add_argument('--days', type=int, default=90)
    parser.add_argument('--output', type=Path, help='Result JSON file (otherwise stdout)')
    args = parser.parse_args()
    payload = json.loads(args.input.read_text(encoding='utf-8-sig')) if args.input else dict(
        district=args.district, db=args.db, period=args.period, asOf=args.as_of, days=args.days)
    result = compute(payload)
    # ASCII JSON is portable through Windows redirected stdout (often GBK).
    encoded = json.dumps(result, ensure_ascii=True, allow_nan=False)
    if args.output:
        args.output.write_text(encoded + '\n', encoding='utf-8')
    else:
        print(encoded)


if __name__ == '__main__':
    main()
