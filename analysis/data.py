"""Raw observation normalization and detector/Hong Kong-hour reference speeds."""
from __future__ import annotations

import re
import gc
import json
import sys
import time
import numpy as np
import pandas as pd

MIN_REFERENCE_OBSERVATIONS = 12
RAIN_MAX_AGE_MINUTES = 70
HKT = 'Asia/Hong_Kong'
_STARTED = time.monotonic()


def progress(stage, **counts):
    """Safe worker diagnostics: stage/count/time/RSS only, never source rows or URI."""
    memory = {}
    if sys.platform.startswith('linux'):
        try:
            with open('/proc/self/status', encoding='ascii') as status:
                for line in status:
                    if line.startswith(('VmRSS:', 'VmHWM:')):
                        name, value, _ = line.split()
                        memory[name.rstrip(':') + 'KiB'] = int(value)
        except OSError:
            pass
    print(json.dumps(dict(analyticsStage=stage, seconds=round(time.monotonic() - _STARTED, 3),
                          **memory, **counts), ensure_ascii=True), file=sys.stderr, flush=True)


def release_memory():
    """Release model-result cycles and unused libc arenas between exact analyses."""
    gc.collect()
    if sys.platform.startswith('linux'):
        try:
            import ctypes
            ctypes.CDLL(None).malloc_trim(0)
        except (AttributeError, OSError):
            pass


def compact_source(table):
    """Normalize projected chunks before retaining them; values/rows are unchanged."""
    result = table.copy(deep=False)
    if 'ts' in result:
        if not isinstance(result.ts.dtype, pd.DatetimeTZDtype) or str(result.ts.dtype.tz) != 'UTC':
            result['ts'] = pd.to_datetime(result.ts, utc=True, errors='coerce', format='mixed')
    for name in ('id', 'd'):
        if name in result:
            if isinstance(result[name].dtype, pd.CategoricalDtype):
                result[name] = result[name].cat.rename_categories(str)
            else:
                # Only observed labels are kept; per-row repeated string objects are freed.
                result[name] = pd.Categorical(result[name])
                result[name] = result[name].cat.rename_categories(str)
    for name in ('speed', 'occupancy'):
        if name in result:
            result[name] = pd.to_numeric(result[name], errors='coerce').astype(np.float64, copy=False)
    return result


def traffic_table(rows):
    table = compact_source(rows if isinstance(rows, pd.DataFrame) else pd.DataFrame.from_records(rows))
    for name in ('id', 'd', 'ts', 'speed', 'occupancy'):
        if name not in table:
            table[name] = pd.Series(index=table.index, dtype='object')
    table['ts'] = pd.to_datetime(table['ts'], utc=True, errors='coerce', format='mixed')
    missing = table[['id', 'd', 'ts']].isna().any(axis=1)
    if missing.any():
        table = table.loc[~missing]
    for name in ('id', 'd'):
        if not isinstance(table[name].dtype, pd.CategoricalDtype):
            table[name] = pd.Categorical(table[name])
    for name in ('speed', 'occupancy'):
        values = pd.to_numeric(table[name], errors='coerce')
        if np.isinf(values).any():
            values = values.where(np.isfinite(values))
        table[name] = values
    for name in ('valid', 'hasVehicles'):
        if name not in table:
            table[name] = True
        if table[name].dtype != bool:
            table[name] = table[name].fillna(True).astype(bool)
    table['eligible'] = table.valid & table.hasVehicles & table.speed.ge(0) & table.speed.notna()
    local = table.ts.dt.tz_convert(HKT)
    table['hour'], table['weekday'] = local.dt.hour.astype(np.int8), local.dt.dayofweek.astype(np.int8)
    table['peak'] = (table.weekday < 5) & (table.hour.between(7, 9) | table.hour.between(17, 19))
    # A detector period is unique in the source/Mongo schema. Repeated exports do not increase n.
    duplicate = table.duplicated(['id', 'ts'], keep='last')
    if duplicate.any():
        table = table.loc[~duplicate]
    if not table.ts.is_monotonic_increasing:
        table = table.sort_values('ts', kind='stable')
    return table.reset_index(drop=True)


def baseline_profiles(table, through=None):
    # Measured stops belong to the detector/hour distribution. Only the
    # resulting reference must be positive to serve as a speed-ratio divisor.
    mask = table.eligible
    if through is not None:
        mask = mask & (table.ts <= through)
    eligible = table.loc[mask, ['id', 'hour', 'speed']]
    grouped = eligible.groupby(['id', 'hour'], sort=True, observed=True).speed
    values = grouped.quantile(.85)
    counts = grouped.count()
    return {f'{detector}|{int(hour)}': {'speed': float(speed), 'n': int(counts.loc[(detector, hour)])}
            for (detector, hour), speed in values.items()
            if counts.loc[(detector, hour)] >= MIN_REFERENCE_OBSERVATIONS and speed > 0}


def profile_speeds(table, profiles):
    labels = table.id.array if isinstance(table.id.dtype, pd.CategoricalDtype) else pd.Categorical(table.id)
    lookup = np.full((len(labels.categories), 24), np.nan)
    positions = {str(label): index for index, label in enumerate(labels.categories)}
    for key, value in profiles.items():
        detector, hour = key.rsplit('|', 1)
        if detector in positions:
            lookup[positions[detector], int(hour)] = value['speed']
    if not len(table):
        return np.empty(0, dtype=float)
    reference = lookup[labels.codes, table.hour.to_numpy(dtype=np.intp, copy=False)]
    reference[labels.codes < 0] = np.nan
    return reference


def enrich(table, profiles):
    result = table.copy(deep=False)
    result['freeFlow'] = profile_speeds(result, profiles)
    result['ratio'] = (result.speed / result.freeFlow).where(result.eligible & result.freeFlow.gt(0))
    # PLAN-v4 defines CI exactly as 1-speed/P85; speeds above P85 produce negative CI.
    result['ci'] = 1 - result.ratio
    return result


def resolution_minutes(row):
    value = row.get('resolutionMinutes')
    if value is not None:
        try:
            number = float(value)
            return number if np.isfinite(number) and number > 0 else None
        except (ValueError, TypeError):
            return None
    value = row.get('resolution')
    if isinstance(value, dict):
        return resolution_minutes({'resolutionMinutes': value.get('minutes')})
    text = str(value or '').lower().strip()
    if text in ('hourly', 'hour', '1h', 'pt1h') or 'last hour' in str(row.get('kind', '')).lower():
        return 60.
    if text in ('minute', 'minutely', '1min', 'pt1m'):
        return 1.
    match = re.fullmatch(r'(?:pt)?([\d.]+)\s*(m|min|mins|minute|minutes|h|hour|hours|s|sec|seconds)', text)
    if match:
        return float(match[1]) * (60 if match[2] in ('h', 'hour', 'hours') else 1 / 60 if match[2] in ('s', 'sec', 'seconds') else 1)
    return None


def rainfall_table(rows):
    table = pd.DataFrame.from_records(rows) if not isinstance(rows, pd.DataFrame) else rows.copy()
    for name in ('d', 'ts', 'mm'):
        if name not in table:
            table[name] = pd.Series(index=table.index, dtype='object')
    table['ts'] = pd.to_datetime(table.ts, utc=True, errors='coerce', format='mixed')
    table['mm'] = pd.to_numeric(table.mm, errors='coerce')
    table = table.dropna(subset=['d', 'ts', 'mm'])
    table = table[np.isfinite(table.mm) & table.mm.ge(0)].copy()
    table['d'] = table.d.astype(str)
    # Missing publication time stays unknown for operational forecast inputs.
    published = pd.Series(pd.NaT, index=table.index, dtype='datetime64[ns, UTC]')
    for name in ('publishedAt', 'fetchedAt'):
        if name in table:
            parsed = pd.to_datetime(table[name], utc=True, errors='coerce', format='mixed')
            published = published.fillna(parsed)
    table['availableAt'] = published
    table['resolutionMinutes'] = [resolution_minutes(row) for row in table.to_dict('records')]
    return table.drop_duplicates(['d', 'ts'], keep='last').sort_values('ts').reset_index(drop=True)


def join_rain(table, rain):
    """Retrospective latest source report, at most 70 min old; missing districts stay unknown."""
    if table.empty:
        result = table.copy()
        result['rain'] = pd.Series(dtype=float)
        result['rainTs'] = pd.Series(dtype='datetime64[ns, UTC]')
        return result
    result = table.copy(deep=False)
    amounts = np.full(len(table), np.nan)
    source_times = np.full(len(table), np.datetime64('NaT'), dtype='datetime64[ns]')
    for district, positions in table.groupby('d', sort=False, observed=True).indices.items():
        source = rain[rain.d == district][['ts', 'mm']].rename(columns={'ts': 'rainTs', 'mm': 'rain'})
        if source.empty:
            continue
        # Join only timestamp/position columns, not another full raw district frame.
        left = pd.DataFrame({'ts': table.ts.iloc[positions].array, '_position': positions}).sort_values('ts')
        matched = pd.merge_asof(left, source.sort_values('rainTs'), left_on='ts', right_on='rainTs',
                                direction='backward', tolerance=pd.Timedelta(minutes=RAIN_MAX_AGE_MINUTES))
        target = matched._position.to_numpy()
        amounts[target] = matched.rain.to_numpy()
        source_times[target] = matched.rainTs.dt.tz_localize(None).to_numpy()
    result['rain'], result['rainTs'] = amounts, pd.to_datetime(source_times, utc=True)
    return result if result.ts.is_monotonic_increasing else result.sort_values('ts')


def iso(value):
    return value.isoformat().replace('+00:00', 'Z') if value is not None and not pd.isna(value) else None
