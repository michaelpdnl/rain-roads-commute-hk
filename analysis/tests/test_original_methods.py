"""Behavior checks for PLAN-v4 §8; synthetic observations are test fixtures only."""
import importlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd
import statsmodels.formula.api as smf


def impact_fixture():
    rng = np.random.default_rng(281)
    rows = []
    for detector in range(8):
        offset = rng.normal(0, .025)
        for day in range(14):
            for hour in (7, 8, 12, 17, 18, 23):
                ts = pd.Timestamp('2026-09-01', tz='Asia/Hong_Kong') + pd.Timedelta(days=day, hours=hour)
                rain = float((day * 7 + hour * 3) % 11) if (day + hour) % 3 else 0.
                peak = ts.dayofweek < 5 and hour in (7, 8, 9, 17, 18, 19)
                ratio = .91 + offset + hour * .001 + ts.dayofweek * .002 - .018 * rain + rng.normal(0, .004)
                rows.append(dict(id=str(detector), d='Sha Tin', ts=ts.isoformat(), rain=rain,
                                 rainTs=ts.isoformat(), ratio=ratio, peak=peak))
    return rows


def forecast_fixture():
    rows = []
    for i, ts in enumerate(pd.date_range('2026-09-01', periods=8 * 288, freq='5min', tz='UTC')):
        for detector in range(2):
            speed = 58 + detector * 3 + 9 * np.sin(i / 41) + 4 * np.cos(i / 17)
            rows.append(dict(id=str(detector), d='Sha Tin', ts=ts.isoformat(), speed=float(speed),
                             valid=True, hasVehicles=True, occupancy=25 + 10 * np.sin(i / 31)))
    return rows


class OriginalMethods(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.engine = importlib.import_module('analysis.impact_model')
            cls.forecast = importlib.import_module('analysis.forecast_model')
        except ModuleNotFoundError:
            cls.engine = cls.forecast = None

    def setUp(self):
        self.assertIsNotNone(self.engine, 'Original statsmodels analytics worker is not implemented')
        self.assertIsNotNone(self.forecast, 'Original TimeSeriesSplit forecast is not implemented')

    def test_ols_uses_all_periods_and_detector_cluster_t_interval(self):
        rows = impact_fixture()
        got = self.engine.fit_controlled(rows)
        data = pd.DataFrame(rows)
        dt = pd.to_datetime(data.ts, utc=True).dt.tz_convert('Asia/Hong_Kong')
        data['hour'], data['weekday'] = dt.dt.hour, dt.dt.dayofweek
        oracle = smf.ols('ratio ~ rain + C(hour) + C(weekday)', data).fit(
            cov_type='cluster', cov_kwds={'groups': data.id, 'use_correction': True}, use_t=True)
        self.assertTrue(got['available'])
        self.assertEqual(got['n'], 672)
        self.assertEqual(got['clusters'], 8)
        self.assertAlmostEqual(got['slope'], -.018, delta=.001)
        self.assertAlmostEqual(got['slope'], oracle.params['rain'], places=11)
        self.assertAlmostEqual(got['se'], oracle.bse['rain'], places=11)
        self.assertAlmostEqual(got['lo'], oracle.conf_int().loc['rain', 0], places=11)
        self.assertAlmostEqual(got['r2'], oracle.rsquared, places=11)

    def test_rain_confounded_with_hour_is_unavailable(self):
        rows = impact_fixture()
        for row in rows:
            hour = pd.Timestamp(row['ts']).hour
            row['rain'] = 0. if hour < 12 else 5.
        got = self.engine.fit_controlled(rows)
        self.assertFalse(got['available'])
        self.assertIn('identif', got['reason'].lower())
        self.assertNotIn('slope', got)

    def test_peak_interaction_keeps_hour_span_and_identifies_both_slopes(self):
        rows = impact_fixture()
        for row in rows:
            if row['peak']:
                row['ratio'] -= .022 * row['rain']
        got = self.engine.fit_controlled(rows, interaction=True)
        self.assertTrue(got['available'])
        self.assertAlmostEqual(got['interaction']['off'], -.018, delta=.001)
        self.assertAlmostEqual(got['interaction']['peak'], -.040, delta=.001)
        self.assertNotIn('weekday', ' '.join(got['terms']))
        self.assertTrue(any('hour' in term for term in got['terms']))

    def test_bootstrap_is_2000_actual_detector_block_resamples(self):
        rows = impact_fixture()
        got = self.engine.cluster_bootstrap(rows, seed=11)
        self.assertEqual(got['attempted'], 2000)
        self.assertEqual(got['converged'] + got['failed'], 2000)
        self.assertEqual(len(got['estimates']), got['converged'])
        self.assertGreaterEqual(got['converged'], 1900)
        self.assertLess(got['lo'], got['hi'])
        # Independently refit the first twelve literal, expanded detector draws.
        rng = np.random.default_rng(11)
        ids = sorted({row['id'] for row in rows})
        literal = []
        for _ in range(12):
            draw = rng.choice(ids, size=len(ids), replace=True)
            sample = pd.DataFrame([r for detector in draw for r in rows if r['id'] == detector])
            dates = pd.to_datetime(sample.ts, utc=True).dt.tz_convert('Asia/Hong_Kong')
            sample['hour'], sample['weekday'] = dates.dt.hour, dates.dt.dayofweek
            literal.append(smf.ols('ratio ~ rain + C(hour) + C(weekday)', sample).fit().params['rain'])
        np.testing.assert_allclose(got['estimates'][:12], literal, rtol=1e-9, atol=1e-10)

    def test_bootstrap_with_singular_draws_reports_failures_and_withholds_ci(self):
        rows = impact_fixture()
        for row in rows:
            row['rain'] = 0. if row['id'] == '0' else 5.
        got = self.engine.cluster_bootstrap(rows, seed=19)
        self.assertEqual(got['attempted'], 2000)
        self.assertGreater(got['failed'], 500)
        self.assertEqual(got['converged'] + got['failed'], 2000)
        self.assertFalse(got['available'])
        self.assertIsNone(got['lo'])

    def test_mixedlm_reports_actual_convergence_and_bh_controls_family(self):
        mixed = self.engine.mixed_robustness(impact_fixture())
        self.assertTrue(mixed['available'], mixed.get('reason'))
        self.assertTrue(mixed['converged'])
        self.assertAlmostEqual(mixed['slope'], -.018, delta=.001)
        models = [{'p': .01}, {'p': .04}, {'p': .03}, None]
        self.engine.apply_fdr(models, family='districts')
        np.testing.assert_allclose([m['q'] for m in models if m], [.03, .04, .04])

    def test_mixedlm_rejects_infinite_likelihood_or_invalid_hessian_before_acceptance(self):
        from unittest.mock import patch
        rows = impact_fixture()
        noise = np.random.default_rng(0).normal(0, .02, len(rows))
        for row, error in zip(rows, noise):
            row['ratio'] = .9 - .02 * row['rain'] + error
        # Optimizer boundary behaviour differs between BLAS/platform builds.
        # Inject the observed infinite-likelihood failure deterministically;
        # bfgs still fits the actual fixture and must pass the inference gates.
        original_fit = self.engine.sm.MixedLM.fit
        def boundary_fit(instance, *args, **kwargs):
            fitted = original_fit(instance, *args, **kwargs)
            if kwargs.get('method') == 'lbfgs':
                fitted.llf = np.inf
            return fitted
        with patch.object(self.engine.sm.MixedLM, 'fit', boundary_fit):
            got = self.engine.mixed_robustness(rows)
        if got['available']:
            self.assertTrue(np.isfinite(got.get('logLikelihood', np.inf)))
            self.assertTrue(got.get('inferenceCovarianceUsable', False))
            accepted = next(item for item in got['diagnostics'] if item['optimizer'] == got['optimizer'])
            self.assertFalse(any('hessian' in warning.lower() and 'not positive definite' in warning.lower()
                                 for warning in accepted['warnings']))
        else:
            self.assertIn('inferential', got['reason'])
        rejected = got['diagnostics'][0]
        self.assertFalse(rejected.get('accepted', True))
        self.assertTrue(rejected.get('invalidReasons'))
        json.dumps(got, allow_nan=False)

    def test_constant_response_has_undefined_r_squared_and_finite_json(self):
        rows = impact_fixture()
        for row in rows:
            row['ratio'] = 1.
        got = self.engine.fit_controlled(rows)
        self.assertTrue(got['available'], got.get('reason'))
        self.assertIsNone(got['r2'])
        self.assertIn('constant', got['r2Reason'].lower())
        json.dumps(got, allow_nan=False)

    def test_ccf_does_not_replace_hourly_source_with_shifted_pearson(self):
        rows = impact_fixture()
        rain = [dict(d=r['d'], ts=r['ts'], mm=r['rain'], resolution='hourly') for r in rows[::8]]
        got = self.engine.ccf_curve(rows, rain)
        self.assertFalse(got['available'])
        self.assertTrue(all(point['r'] is None for point in got['points']))
        self.assertIn('resolution', got['reason'].lower())

    def test_ccf_recovers_positive_response_lag_only_from_complete_source_grid(self):
        rng = np.random.default_rng(4)
        values = rng.uniform(0, 10, 100)
        dates = pd.date_range('2026-09-01', periods=100, freq='5min', tz='UTC')
        rows, rain = [], []
        for i, ts in enumerate(dates):
            rows.append(dict(id='a', d='Sha Tin', ts=ts.isoformat(), ratio=.9 - .03 * values[(i - 3) % 100]))
            rain.append(dict(d='Sha Tin', ts=ts.isoformat(), mm=float(values[i]), resolutionMinutes=5))
        got = self.engine.ccf_curve(rows, rain)
        self.assertTrue(got['available'], got.get('reason'))
        self.assertEqual(min(got['points'], key=lambda p: p['r'])['minutes'], 15)
        rain.pop(40)
        gap = self.engine.ccf_curve(rows, rain)
        self.assertFalse(gap['available'])
        self.assertIn('gap', gap['reason'].lower())

    def test_forecast_uses_multiple_purged_clock_folds_with_train_only_references(self):
        rows = forecast_fixture()
        got = self.forecast.forecast(rows, [])
        model = got['models'][0]
        self.assertTrue(model['available'], model['reason'])
        self.assertEqual(len(model['folds']), 3)
        self.assertGreater(model['nTest'], 30)
        for fold in model['folds']:
            self.assertLess(fold['trainTargetThrough'], fold['testFrom'])
            self.assertLessEqual(fold['referenceThrough'], fold['trainTargetThrough'])
            self.assertGreaterEqual(fold['gapSlots'], 6)
            self.assertGreater(fold['nTrain'], 30)
        # Changing only held-out raw speeds must not alter fold-zero P85/scaler.
        test_start = model['folds'][0]['testFrom']
        changed = [{**r, 'speed': r['speed'] * 10} if r['ts'] >= test_start else r for r in rows]
        again = self.forecast.forecast(changed, [])['models'][0]['folds'][0]
        self.assertEqual(model['folds'][0]['baselineProfiles'], again['baselineProfiles'])
        np.testing.assert_allclose(model['folds'][0]['scalerMean'], again['scalerMean'])
        self.assertEqual(got['spatialScope'], 'network')
        self.assertEqual({item['id'] for item in got['perDetectorOutlooks']}, {'0', '1'})
        self.assertTrue(all(item['available'] for item in got['perDetectorOutlooks']))
        self.assertTrue(all(item['minutes'] == 30 for item in got['perDetectorOutlooks']))

    def test_sparse_clock_never_fills_missing_input_target_pairs(self):
        rows = forecast_fixture()[::2]
        sparse = [r for i, r in enumerate(rows) if i % 36 == 0]
        got = self.forecast.forecast(sparse, [])
        self.assertGreater(got['clock']['unknownSlots'], got['clock']['observedSlots'])
        self.assertTrue(all(not model['available'] for model in got['models']))
        self.assertTrue(all(model['modelMAE'] is None for model in got['models']))

    def test_detector_outlook_origin_is_its_own_last_observation_clock(self):
        rows = forecast_fixture()
        cutoff = pd.Timestamp('2026-09-08', tz='UTC')
        rows = [r for r in rows if r['id'] != '1' or pd.Timestamp(r['ts']) < cutoff]
        got = self.forecast.forecast(rows, [])
        detector = next(item for item in got['perDetectorOutlooks'] if item['id'] == '1')
        self.assertTrue(detector['available'])
        self.assertEqual(pd.Timestamp(detector['originTs']) + pd.Timedelta(minutes=30), pd.Timestamp(detector['predictedAt']))
        self.assertLess(pd.Timestamp(detector['originTs']), pd.Timestamp(got['latestTs']))

    def test_detector_alert_outlook_requires_exact_source_origin_not_future_bin_edge(self):
        rows = forecast_fixture()
        for row in rows:
            row['ts'] = (pd.Timestamp(row['ts']) + pd.Timedelta(seconds=30)).isoformat()
        got = self.forecast.forecast(rows, [])
        for detector in got['perDetectorOutlooks']:
            self.assertFalse(detector['available'])
            self.assertIsNone(detector['prediction'])
            actual = max(pd.Timestamp(row['ts']) for row in rows if row['id'] == detector['id'])
            self.assertEqual(pd.Timestamp(detector['sourceAt']), actual)
            self.assertIn('source', detector['reason'].lower())

    def test_rain_report_is_unknown_after_seventy_minutes(self):
        raw = self.engine.traffic_table([
            dict(id='a', d='Sha Tin', ts='2026-09-01T01:10:00Z', speed=40),
            dict(id='a', d='Sha Tin', ts='2026-09-01T01:10:01Z', speed=40)])
        source = self.engine.rainfall_table([dict(d='Sha Tin', ts='2026-09-01T00:00:00Z', mm=3)])
        joined = self.engine.join_rain(raw, source)
        self.assertEqual(joined.rain.iloc[0], 3)
        self.assertTrue(pd.isna(joined.rain.iloc[1]))

    def test_empty_service_and_cli_have_explicit_unavailable_contract(self):
        from fastapi.testclient import TestClient
        from analysis.service import app
        with TestClient(app) as client:
            self.assertEqual(client.get('/health').status_code, 200)
            response = client.post('/compute', json={'rows': [], 'rain': [], 'period': 'all'})
            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertIsNone(data['impact']['model'])
            self.assertTrue(all(not m['available'] for m in data['forecast']['models']))
            self.assertTrue(data['limitations'])
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'input.json'
            path.write_text(json.dumps({'rows': [], 'rain': []}))
            result = subprocess.run([sys.executable, '-m', 'analysis.impact_model', '--input', str(path)],
                                    capture_output=True, text=True, check=True)
            self.assertIsNone(json.loads(result.stdout)['impact']['model'])

    def test_worker_returns_exact_raw_hour_profiles_and_ci_thresholds(self):
        rows = []
        for detector in range(3):
            for index in range(12):
                rows.append(dict(id=str(detector), d='Sha Tin', ts=f'2026-09-01T00:{index * 5:02}:00Z',
                                 speed=40 + index, valid=True, hasVehicles=True))
        got = self.engine.compute({'rows': rows, 'rain': []})
        profiles = dict(got['baselineProfiles'])
        self.assertAlmostEqual(profiles['0|8']['speed'], 49.35)
        self.assertEqual(profiles['0|8']['n'], 12)
        expected_ci = 1 - np.tile(np.arange(40, 52), 3) / 49.35
        self.assertAlmostEqual(got['thresholdProfiles']['Sha Tin|8'], np.quantile(expected_ci, .9))
        self.assertEqual(got['source']['observations'], 36)

    def test_raw_hour_p85_includes_eligible_measured_zero_speeds(self):
        rows = [dict(id='a', d='Sha Tin', ts=f'2026-09-01T00:{minute:02}:00Z',
                     speed=0, valid=True, hasVehicles=True) for minute in range(0, 60, 5)]
        rows.extend(dict(id='a', d='Sha Tin', ts=f'2026-09-02T00:{minute:02}:00Z',
                         speed=40 + minute, valid=True, hasVehicles=True) for minute in range(0, 60, 5))
        profiles = self.engine.baseline_profiles(self.engine.traffic_table(rows))
        self.assertEqual(profiles['a|8']['n'], 24)
        self.assertAlmostEqual(profiles['a|8']['speed'], 77.75)
        self.assertEqual(self.engine.baseline_profiles(self.engine.traffic_table(rows[:12])), {})

    def test_raw_panel_compaction_preserves_rows_and_uses_categorical_labels(self):
        rows = forecast_fixture()
        table = self.engine.traffic_table(rows)
        self.assertEqual(len(table), len(rows))
        self.assertIsInstance(table.id.dtype, pd.CategoricalDtype)
        self.assertIsInstance(table.d.dtype, pd.CategoricalDtype)
        self.assertLess(table.memory_usage(deep=True).sum(), len(rows) * 80)
        self.assertEqual(table.speed.tolist(), [row['speed'] for row in rows])
        enriched = self.engine.enrich(table, self.engine.baseline_profiles(table))
        np.testing.assert_allclose(enriched.ratio, enriched.speed / enriched.freeFlow)

    def test_database_request_without_connection_is_unavailable_not_empty_data(self):
        from fastapi.testclient import TestClient
        from analysis.service import app
        with patch.dict('os.environ', {'MONGO_URI': ''}):
            with TestClient(app) as client:
                response = client.post('/compute', json={'district': 'all', 'period': 'all'})
                self.assertEqual(response.status_code, 503)
                self.assertIn('Mongo', response.json()['detail'])


if __name__ == '__main__':
    unittest.main()
