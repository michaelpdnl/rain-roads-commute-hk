"""Ridge/persistence on an unfilled regular clock with purged TimeSeriesSplit."""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .data import HKT, RAIN_MAX_AGE_MINUTES, baseline_profiles, iso, profile_speeds, rainfall_table, traffic_table

CLOCK_MINUTES = 5
N_SPLITS = 3
MIN_TRAIN, MIN_TEST = 30, 10


def _binned(table):
    """Aggregate observed periods after keeping the raw-hour baseline membership.

    A bin is timestamped at its right edge, so an observation can never arrive
    after the feature timestamp. Empty bins are not synthesized as observations.
    Raw observations, rather than these means, always supply P85 references.
    """
    good = table.loc[table.eligible, ['ts', 'id', 'd', 'hour', 'speed', 'occupancy']]
    good['clock'] = good.ts.dt.ceil(f'{CLOCK_MINUTES}min')
    good = good.drop(columns='ts')
    return good.groupby(['clock', 'id', 'd', 'hour'], observed=True, sort=True).agg(
        speed=('speed', 'mean'), n=('speed', 'size'), occupancy=('occupancy', 'mean')).reset_index()


def _clock(table):
    if table.empty:
        return pd.DatetimeIndex([], tz='UTC')
    return pd.date_range(table.ts.min().ceil(f'{CLOCK_MINUTES}min'), table.ts.max().ceil(f'{CLOCK_MINUTES}min'),
                         freq=f'{CLOCK_MINUTES}min')


def _available_rain(clock, rain, districts):
    amounts = []
    for district in districts:
        source = rain[(rain.d == district) & rain.availableAt.notna()].copy()
        if source.empty:
            amounts.append(pd.Series(np.nan, index=clock))
            continue
        # No observation/publication from after a forecast origin can enter x.
        source['effective'] = source[['ts', 'availableAt']].max(axis=1)
        source = source.sort_values(['effective', 'ts']).drop_duplicates('effective', keep='last')
        joined = pd.merge_asof(pd.DataFrame({'clock': clock}), source[['effective', 'ts', 'mm']],
                                left_on='clock', right_on='effective', direction='backward')
        valid = (joined.clock - joined.ts <= pd.Timedelta(minutes=RAIN_MAX_AGE_MINUTES)) & (joined.ts <= joined.clock)
        amounts.append(pd.Series(joined.mm.where(valid).to_numpy(), index=clock))
    if not amounts:
        return np.full(len(clock), np.nan)
    values = pd.concat(amounts, axis=1)
    # Unknown district rainfall is not silently replaced by zero.
    return values.mean(axis=1).where(values.notna().all(axis=1)).to_numpy(float)


def _frames(bins, clock, profiles, rain_values):
    result = pd.DataFrame(index=clock)
    if bins.empty:
        result['ci'], result['occupancy'] = np.nan, np.nan
    else:
        reference = profile_speeds(bins, profiles)
        values = pd.DataFrame({'clock': bins.clock.array, 'occupancy': bins.occupancy.to_numpy(),
                               'ci_weighted': (1 - bins.speed.to_numpy() / reference) * bins.n.to_numpy(),
                               'known_n': np.where(np.isfinite(reference), bins.n.to_numpy(), 0)})
        grouped = values.groupby('clock', sort=True, observed=True)
        result['ci'] = (grouped.ci_weighted.sum(min_count=1) / grouped.known_n.sum()).reindex(clock)
        # Observed occupancy is optional and accompanied by a missing indicator.
        result['occupancy'] = grouped.occupancy.mean().reindex(clock)
    result['rain'] = rain_values
    return result


def _features(frames):
    ci = frames.ci.to_numpy(float)
    old = frames.ci.shift(30 // CLOCK_MINUTES).to_numpy(float)
    trend_known = np.isfinite(ci) & np.isfinite(old)
    trend = np.where(trend_known, ci - old, 0.)
    occupancy, rain = frames.occupancy.to_numpy(float), frames.rain.to_numpy(float)
    local = frames.index.tz_convert(HKT)
    hour = local.hour + local.minute / 60
    weekday = local.dayofweek
    return np.column_stack([ci, trend, trend_known.astype(float),
                            np.nan_to_num(occupancy, nan=0.) / 100, np.isfinite(occupancy).astype(float),
                            np.nan_to_num(rain, nan=0.), np.isfinite(rain).astype(float),
                            np.sin(hour * np.pi / 12), np.cos(hour * np.pi / 12),
                            np.sin(weekday * 2 * np.pi / 7), np.cos(weekday * 2 * np.pi / 7)])


def _pairs(frames, features, origins, lag):
    origin = np.asarray(origins, dtype=int)
    targets = origin + lag
    valid = np.isfinite(features[origin]).all(axis=1) & np.isfinite(frames.ci.to_numpy()[targets])
    origin, targets = origin[valid], targets[valid]
    return features[origin], frames.ci.to_numpy(float)[targets], frames.ci.to_numpy(float)[origin], origin, targets


def _pipeline():
    return make_pipeline(StandardScaler(), Ridge(alpha=1.))


def _models(table, rain, horizons=(30, 60, 120), compact=False):
    clock = _clock(table)
    bins = _binned(table)
    district_names = sorted(table.d.unique())
    rain_values = _available_rain(clock, rain, district_names)
    profile_cache, frame_cache = {}, {}

    def inputs(cutoff):
        if cutoff not in profile_cache:
            profile_cache[cutoff] = baseline_profiles(table, through=cutoff)
        if cutoff not in frame_cache:
            frame_cache.clear()  # Only the current fold's clock values are needed.
            frame_cache[cutoff] = _frames(bins, clock, profile_cache[cutoff], rain_values)
        frames = frame_cache[cutoff]
        return profile_cache[cutoff], frames, _features(frames)

    models = []
    for minutes in horizons:
        lag = minutes // CLOCK_MINUTES
        model = dict(minutes=minutes, available=False, reason='Need three purged chronological folds with ≥30 observed training pairs and ≥10 observed later test pairs each.',
                     nTrain=0, nTest=0, modelMAE=None, baselineMAE=None, skill=None, prediction=None,
                     predictedAt=None, evaluated=[], folds=[], method='sklearn StandardScaler + Ridge(alpha=1) vs persistence; TimeSeriesSplit(n_splits=3, gap=horizon slots)')
        origins = np.arange(max(0, len(clock) - lag))
        if len(origins) <= N_SPLITS + lag + 1:
            models.append(model)
            continue
        split = TimeSeriesSplit(n_splits=N_SPLITS, gap=lag)
        evaluated, successful = [], 0
        try:
            folds = list(split.split(origins))
        except ValueError as error:
            model['reason'] = str(error)
            models.append(model)
            continue
        for number, (train, test) in enumerate(folds, 1):
            cutoff = clock[train[-1] + lag]
            profiles, frames, features = inputs(cutoff)
            x_train, y_train, _, train_origin, train_target = _pairs(frames, features, train, lag)
            x_test, y_test, persistence, test_origin, test_target = _pairs(frames, features, test, lag)
            fold = dict(fold=number, available=False, nTrain=len(y_train), nTest=len(y_test), gapSlots=lag,
                        trainFrom=iso(clock[train[0]]), trainOriginThrough=iso(clock[train[-1]]),
                        trainTargetThrough=iso(cutoff), testFrom=iso(clock[test[0]]), testThrough=iso(clock[test[-1]]),
                        referenceThrough=iso(cutoff), referenceObservations=sum(p['n'] for p in profiles.values()),
                        baselineProfiles=profiles if not compact else None)
            model['nTrain'] += len(y_train)
            model['nTest'] += len(y_test)
            if len(y_train) < MIN_TRAIN or len(y_test) < MIN_TEST:
                fold['reason'] = 'Insufficient observed input/target pairs or raw detector/HKT-hour P85 references; unknown slots were kept.'
            elif clock[train_target[-1]] >= clock[test[0]]:
                # A strict guard against accidental changes to the purge/split implementation.
                fold['reason'] = 'Training label overlaps the test-origin interval.'
            else:
                fitted = _pipeline().fit(x_train, y_train)
                predicted = fitted.predict(x_test)
                fold.update(available=True, reason=None, modelMAE=float(mean_absolute_error(y_test, predicted)),
                            baselineMAE=float(mean_absolute_error(y_test, persistence)),
                            scalerMean=fitted['standardscaler'].mean_.tolist(), scalerScale=fitted['standardscaler'].scale_.tolist())
                evaluated.extend(dict(ts=iso(clock[target]), origin=iso(clock[origin]), actual=float(actual),
                                      predicted=float(prediction), baseline=float(baseline), fold=number)
                                 for target, origin, actual, prediction, baseline in zip(test_target, test_origin, y_test, predicted, persistence))
                successful += 1
            model['folds'].append(fold)
        model['successfulFolds'] = successful
        if successful == N_SPLITS:
            mae = float(np.mean([abs(point['predicted'] - point['actual']) for point in evaluated]))
            baseline_mae = float(np.mean([abs(point['baseline'] - point['actual']) for point in evaluated]))
            model.update(available=True, reason=None, modelMAE=mae, baselineMAE=baseline_mae,
                         skill=(baseline_mae - mae) / baseline_mae * 100 if baseline_mae > 0 else None,
                         evaluated=[] if compact else evaluated)
            profiles, frames, features = inputs(clock[-1])
            x, y, _, _, _ = _pairs(frames, features, origins, lag)
            if len(y) >= MIN_TRAIN and np.isfinite(features[-1]).all():
                latest_fit = _pipeline().fit(x, y)
                model.update(prediction=float(latest_fit.predict(features[-1:])[0]),
                             predictedAt=iso(clock[-1] + pd.Timedelta(minutes=minutes)),
                             trainedThrough=iso(clock[-1]), predictionReferenceThrough=iso(clock[-1]))
            else:
                model['predictionReason'] = 'Validated model exists, but latest origin lacks observed CI/reference inputs.'
        models.append(model)
    full_profiles = baseline_profiles(table)
    display_frames = _frames(bins, clock, full_profiles, rain_values)
    observed = int(display_frames.ci.notna().sum())
    metadata = dict(minutes=CLOCK_MINUTES, slots=len(clock), observedSlots=observed, unknownSlots=len(clock) - observed,
                    interpolation=False, label='Right edge of each observed 5-minute bin; full unfilled clock for splitting.')
    return models, metadata, display_frames


def forecast(rows, rainfall):
    table = rows if isinstance(rows, pd.DataFrame) and 'eligible' in rows else traffic_table(rows)
    rain = rainfall if isinstance(rainfall, pd.DataFrame) and 'availableAt' in rainfall else rainfall_table(rainfall)
    models, clock, display = _models(table, rain)
    detector_outlooks = []
    # Reuse the same estimator, raw hourly references, purged folds, and eligibility
    # gates at detector scope. Network means never trigger detector-specific rules.
    for detector, part in table.groupby('id', sort=True, observed=True):
        validated, _, detector_display = _models(part, rain[rain.d.isin(part.d.unique())], horizons=(30,), compact=True)
        model = validated[0]
        source_at = part.ts.max()
        clock_origin = detector_display.index[-1] if len(detector_display) else None
        exact_source_origin = clock_origin is not None and source_at == clock_origin
        available = bool(model['available'] and model['prediction'] is not None and exact_source_origin)
        reason = model['reason'] or model.get('predictionReason')
        if model['available'] and model['prediction'] is not None and not exact_source_origin:
            reason = 'Latest actual source timestamp differs from the model clock origin; exact 30-minute detector alert outlook withheld.'
        detector_outlooks.append(dict(id=detector, d=part.d.iloc[-1], minutes=30,
                                       available=available, validatedModelAvailable=model['available'],
                                       reason=reason, prediction=model['prediction'] if available else None,
                                       predictedAt=model['predictedAt'] if available else None, originTs=iso(source_at),
                                       sourceAt=iso(source_at), clockOrigin=iso(clock_origin),
                                       spatialScope='detector', nTrain=model['nTrain'], nTest=model['nTest'],
                                       successfulFolds=model.get('successfulFolds', 0), modelMAE=model['modelMAE'],
                                       baselineMAE=model['baselineMAE'], skill=model['skill']))
    return dict(models=models, clock=clock, spatialScope='network', perDetectorOutlooks=detector_outlooks,
                latestTs=iso(display.index[-1]) if len(display) else None,
                recent=[dict(ts=iso(ts), ci=float(row.ci) if np.isfinite(row.ci) else None)
                        for ts, row in display.iloc[-60:].iterrows()],
                outlook=[dict(ts=model['predictedAt'], ci=model['prediction'], minutes=model['minutes'])
                         for model in models if model['available'] and model['prediction'] is not None],
                scope='Observed network mean CI for main models; separately validated 30-minute detector models for detector alert rules.',
                method='Three TimeSeriesSplit folds on a full 5-minute clock, horizon purge gap, fold-only raw detector/HKT-hour P85 and StandardScaler; Ridge vs persistence.',
                limitations=['No interpolation of missing traffic or future rainfall.',
                             'Optional missing occupancy/rain use explicit missing indicators, not imputed observations.',
                             'Network mean uses available detector periods with eligible fold-specific hourly references.',
                             'Skill is out-of-fold MAE improvement; zero persistence MAE leaves skill undefined.'])
