"""Build the original-plan report only from current verified runtime evidence.

Run: python tools/report.py. Requires reportlab and Pillow. Inputs are
report/evidence.json, artifacts/original-runtime-verification.json and five
1360x735 report/screenshots/*.png files. Optional actual identities belong in
report/authors.json; optional test results in artifacts/original-test-results.json.
This script never acquires data, invents acceptance evidence or packages a ZIP.
"""
import hashlib
import json
import math
from datetime import datetime, timezone, timedelta
from pathlib import Path
from xml.sax.saxutils import escape

from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'report'
EVIDENCE = OUT / 'evidence.json'
VERIFICATION = ROOT / 'artifacts/original-runtime-verification.json'
TEST_RESULTS = ROOT / 'artifacts/original-test-results.json'
DATA_AUDIT = ROOT / 'artifacts/original-data-audit.json'
BACKFILL_SUMMARY = ROOT / 'artifacts/original-backfill-summary.json'
REFERENCE = 'PLAN-v4.md \u00a78'
SCREENSHOTS = ('live.png', 'analysis.png', 'replay.png', 'decisions.png', 'quality.png')


def load(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def timestamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def stamp(value):
    if not value:
        return 'unavailable'
    return timestamp(value).astimezone(timezone(timedelta(hours=8))).strftime('%d %b %Y %H:%M:%S HKT')


def fmt(value, digits=4):
    if value is None:
        return 'unavailable'
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, float):
        if math.isfinite(value) and value != 0 and abs(value) < 10 ** (-digits):
            return f'{value:.3e}'
        return f'{value:.{digits}f}' if math.isfinite(value) else 'unavailable'
    return str(value)


def interval(model):
    return '[' + fmt(model.get('lo'), 6) + ', ' + fmt(model.get('hi'), 6) + ']'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


require(EVIDENCE.is_file(), 'Missing report/evidence.json; capture the current dashboard API first.')
require(VERIFICATION.is_file(), 'Missing artifacts/original-runtime-verification.json; run current runtime checks first.')
e, verification = load(EVIDENCE), load(VERIFICATION)
research, meta = e.get('research', {}), e.get('meta', {})
require(research.get('methods', {}).get('reference') == REFERENCE,
        'Stale or unsupported report evidence: original PLAN-v4 section 8 worker output is required.')
require(research.get('methods', {}).get('available') is True,
        'Original analytics worker was unavailable; do not build an implementation-complete report.')
require(verification.get('research', {}).get('methods', {}).get('reference') == REFERENCE,
        'Runtime verification is stale: it must verify the original analytics worker.')
require(bool(verification.get('checks')), 'Runtime verification contains no recorded checks.')
require(meta.get('generatedAt') and verification.get('checkedAt'), 'Evidence timestamps are required.')
oldest_capture = min(timestamp(meta['generatedAt']).timestamp(), timestamp(verification['checkedAt']).timestamp()) - 3600
for name in SCREENSHOTS:
    path = OUT / 'screenshots' / name
    require(path.is_file(), 'Missing current screenshot: ' + str(path))
    require(path.stat().st_mtime >= oldest_capture, 'Stale screenshot; recapture current page: ' + name)
    with PILImage.open(path) as picture:
        require(picture.size == (1360, 735), 'Screenshot must match original 1360x735 contract: ' + name)

impact = research.get('impact', {})
model = impact.get('model')
forecast = research.get('forecast', {})
forecasts = forecast.get('models', [])
source = research.get('source', {})
loop = e.get('loop', {})
test_results = load(TEST_RESULTS) if TEST_RESULTS.is_file() else None
data_audit = load(DATA_AUDIT) if DATA_AUDIT.is_file() else {}
backfill = load(BACKFILL_SUMMARY) if BACKFILL_SUMMARY.is_file() else {}
stored_dates = data_audit.get('knownClassificationRange', {}).get('storedHKTDates', 0)
backfill_verified = stored_dates >= 40 and backfill.get('result', {}).get('failed') == 0
styles = getSampleStyleSheet()
styles.add(ParagraphStyle('Body', fontName='Helvetica', fontSize=9.5, leading=13, spaceAfter=7, textColor=colors.HexColor('#25374a')))
styles.add(ParagraphStyle('SmallBody', parent=styles['Body'], fontSize=8, leading=10.5, spaceAfter=5))
styles['Title'].textColor = colors.HexColor('#173c60')
styles['Title'].fontSize, styles['Title'].leading = 25, 30
styles['Heading1'].textColor = colors.HexColor('#173c60')
styles['Heading1'].fontSize, styles['Heading1'].leading = 14, 18
styles['Heading1'].keepWithNext = True
styles['Heading2'].textColor = colors.HexColor('#286084')
story, markdown = [], ['# Rain, Roads and the Commute', '', 'COMP7503A - Multimedia Technologies - Group Programming Assignment', '']


def h(text):
    story.append(Paragraph(escape(text), styles['Heading1']))
    markdown.extend(['', '## ' + text, ''])


def p(text, small=False):
    story.append(Paragraph(escape(str(text)), styles['SmallBody' if small else 'Body']))
    markdown.extend([str(text), ''])


def table(headers, rows, widths):
    content = [[Paragraph(escape(str(v)), styles['SmallBody']) for v in row] for row in [headers] + rows]
    widget = Table(content, colWidths=[v * mm for v in widths], repeatRows=1, hAlign='LEFT')
    widget.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#e6eff6')),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LINEBELOW', (0, 0), (-1, 0), .6, colors.HexColor('#8ea9bf')),
        ('LINEBELOW', (0, 1), (-1, -1), .3, colors.HexColor('#dce4ec')),
        ('LEFTPADDING', (0, 0), (-1, -1), 6), ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    story.extend([widget, Spacer(1, 6)])
    markdown.extend(['| ' + ' | '.join(headers) + ' |', '| ' + ' | '.join(['---'] * len(headers)) + ' |'])
    markdown.extend('| ' + ' | '.join(str(v).replace('|', '\\|').replace('\n', ' ') for v in row) + ' |' for row in rows)
    markdown.append('')


def figure(name, caption):
    story.extend([Image(str(OUT / 'screenshots' / name), width=174 * mm, height=94 * mm, hAlign='CENTER'),
                  Spacer(1, 2 * mm), Paragraph(escape(caption), styles['SmallBody']), Spacer(1, 3 * mm)])
    markdown.extend([f'![{caption}](screenshots/{name})', ''])


story.append(Paragraph('Rain, Roads<br/>and the Commute', styles['Title']))
p('COMP7503A - Multimedia Technologies, Group Programming Assignment, 2026-2027')
authors_file = OUT / 'authors.json'
if authors_file.is_file():
    authors = load(authors_file)
    require(isinstance(authors, list), 'authors.json must be a list of real name/studentId objects.')
    for author in authors:
        require(author.get('name') and author.get('studentId'), 'Every supplied author needs a real name and studentId.')
        p(f"{author['name']} - {author['studentId']}")
else:
    p('Student names and IDs have not been supplied; authorship remains to be completed.', small=True)
p('Local implementation and measured results captured ' + stamp(meta['generatedAt']) + '. The original plan remains the method and acceptance reference. Pending time/data-dependent criteria are stated explicitly below.')

h('1. Smart-city use cases and original scope')
p('The six study districts are Yuen Long, Sha Tin, Tsuen Wan, Kwun Tong, Sham Shui Po and Yau Tsim Mong. Commuters and an operations observer inspect actual congestion and a validated 30-minute outlook; planners inspect controlled rainfall associations; simulated actors record decisions followed by actual CI remeasurement. Source observations, decisions and unavailable methods stay distinguishable.')
p('The decision cycle is sensors, situational awareness, associated alert, timestamped action and actual remeasurement. Actor actions are commuter leave now, delay 20 minutes or switch to rail; operator acknowledge or simulated dispatch; planner flag a corridor for review. No real dispatch or causal travel benefit is asserted.')

h('2. Sources and collection')
table(['Stream', 'Actual acquisition and use'], [
    ['TD road XML and locations', 'Speed, lane volume and occupancy; poll every 2 minutes, metadata daily; unique detector/source-time periods.'],
    ['HKO station and district rain', 'Station feed polled every 15 minutes; district report every 10 minutes. Retain original rain resolution and unknown districts.'],
    ['TD traffic cameras', 'Six district views captured every 2 minutes; metadata, retrieval times, JPEGs and failures retained.'],
    ['Official archive versions', 'Wet dates sampled every 10 minutes, dry dates every 60 minutes, at most 2 archive requests/s; checkpointed provenance.'],
    ['HKO daily rainfall', 'Daily date classification only. Trace is wet, unknown classification is skipped; daily totals never become hourly rain.'],
], [46, 128])
p('The original 40-date backfill range is 22 September through 31 October 2026. Successful dates, failures and actual source coverage must be verified from imports and traffic, not inferred from the requested range. Official hourly RSS archives provide actual rainfall reports where historical JSON is unavailable. Sampled files do not establish continuous coverage; pre-capture images are unavailable.', small=True)

h('3. Implementation and storage')
p('Docker Compose runs Node-RED, MongoDB and an internal Python analytics worker. Node-RED orchestrates timers, HTTP acquisition, parsing/upserts, APIs and maintenance. The worker reads raw MongoDB collections and runs the original statsmodels/sklearn methods. It has no published host port. MongoDB and captured files persist in named volumes; only localhost port 1881 is published.')
p('Failed worker access leaves the corresponding original methods unavailable with a reason. Acquisition errors preserve prior measurements and update source-health status.')
table(['Stored data', 'Identity and provenance'], [
    ['traffic', 'Detector ID plus source observation time; weighted valid-lane speed, occupancy/volume, district/location, validity and fetch time.'],
    ['district_rain / station_rain / weather', 'Reported source time, actual values and publication/fetch availability; raw reports retained.'],
    ['camera metadata / frames / checks', 'Catalog coordinates, file/retrieval time, response metadata and attempt success; files in persistent Node-RED volume.'],
    ['imports / health / alerts / decisions', 'Archive URLs/checkpoints, source failures, immutable alert snapshots, associated actions and +30/+60 CI evidence.'],
], [53, 121])

h('4. Original analysis and validation methods')
p('Valid lane speeds from 0 to 160 km/h are vehicle-volume weighted; no-vehicle periods are excluded, while valid observed stops remain measured zeros. Raw eligible detector/HKT-hour speeds define P85 with at least 12 observations and positive resulting P85. CI is exactly 1-speed/P85, without clamping. Negative CI above P85 and speed ratios above 2 remain eligible.')
p('Original inference uses all eligible raw periods within the selected 90-day study window, without the former 120,000/60,000 quotas or detector/hour averaging. District rain is the reported district maximum, joined retrospectively at or before the road time with maximum age 70 minutes. Unknown rainfall stays null. Source/fetch publication availability additionally constrains forecast inputs.')
p('The rain model is statsmodels OLS: speed_ratio ~ rain + C(hour) + C(weekday). It uses detector-cluster covariance with finite-sample correction and t(G-1) 95% intervals. Full nuisance-control spans are retained. Minimum period/cluster/wet/dry/source-window gates and identifiability checks can leave it unavailable. Peak interaction is speed_ratio ~ rain * peak + C(hour), using weekday 07:00-09:59 and 17:00-19:59 HKT.')
p('ML MixedLM adds a random detector intercept to the same fixed controls. Actual convergence, likelihood, covariance, Hessian warnings and optimizer attempts determine availability. Exactly 2,000 detector-block bootstrap refits are attempted for each estimable headline/district slope, with actual success/failure counts; algebraically exact sufficient statistics preserve the raw-row OLS estimator. A percentile interval requires at least 95% usable draws. Benjamini-Hochberg adjusts estimable district model families. A detector-only model has one cluster, so the specified detector-cluster inference/FDR is unavailable.')
p('Onset CCF is statsmodels.tsa.stattools.ccf over -30 to +120 minutes, requiring real fine-resolution rain and complete observed panels. Current hourly rain cannot support it. No shifted Pearson correlations, inferred onset, forward fill or interpolation replace the original CCF.')
p('Forecasts compare StandardScaler plus Ridge with persistence at 30, 60 and 120 minutes. Three TimeSeriesSplit folds operate on a full 5-minute clock with a horizon purge gap before invalid pairs are removed. Every fold fits P85 and scaling only from permitted training data; its final training label precedes its first test origin. All three folds need actual eligible train/test pairs. Unknown bins remain unknown. Negative skill remains visible. Separately validated per-detector 30-minute forecasts can trigger matching detector alerts; a network estimate or mismatched source/bin origin cannot.')
p('Reproduce original n, R-squared, estimator/2,000-bootstrap intervals and diagnostics with analysis/impact_model.py from a preserved raw JSON export or a Mongo snapshot bounded by --as-of. analysis/README.md documents commands, quality gates and dependency versions. Synthetic fixtures test code only and never appear as empirical findings.', small=True)

h('5. Captured empirical results and unavailable methods')
table(['Metric', 'Current captured value'], [
    ['Stored traffic rows / location records', fmt(meta.get('records')) + ' / ' + fmt(meta.get('locations'))],
    ['Worker raw observation count', fmt(source.get('observations'))],
    ['Raw valid count / HKT dates', fmt(source.get('valid')) + ' / ' + fmt(source.get('dates'))],
    ['Actual analysis source range', stamp(source.get('start')) + ' to ' + stamp(source.get('end'))],
    ['Requested analysis query window', stamp(source.get('queryFrom')) + ' to ' + stamp(source.get('queryThrough'))],
    ['Matched raw rain periods; wet / dry', fmt(impact.get('n')) + '; ' + fmt(impact.get('wet')) + ' / ' + fmt(impact.get('dry'))],
    ['Hourly P85 profiles / detectors', fmt(research.get('baseline', {}).get('profiles')) + ' / ' + fmt(research.get('baseline', {}).get('detectors'))],
], [64, 110])
if model:
    p('Headline controlled slope: ' + fmt(model.get('slope'), 6) + ' speed-ratio units per mm; detector-cluster t 95% CI ' + interval(model) + '; p=' + fmt(model.get('p'), 6) + '; R-squared=' + fmt(model.get('r2')) + '. n=' + fmt(model.get('n')) + ', detector clusters=' + fmt(model.get('clusters')) + ', wet/dry source windows=' + fmt(model.get('wetWindows')) + '/' + fmt(model.get('dryWindows')) + '.')
    bootstrap = model.get('bootstrap', {})
    p('Headline bootstrap: requested=' + fmt(bootstrap.get('requested')) + ', attempted=' + fmt(bootstrap.get('attempted')) + ', usable=' + fmt(bootstrap.get('nSuccess')) + ', failed=' + fmt(bootstrap.get('nFailed')) + ', seed=' + fmt(bootstrap.get('seed')) + '. ' + ('Percentile 95% CI ' + interval(bootstrap) if bootstrap.get('available') else 'Unavailable: ' + str(bootstrap.get('reason', 'missing output'))) + '.', small=True)
    mixed = model.get('mixed', {})
    p('MixedLM robustness: ' + ('slope=' + fmt(mixed.get('slope'), 6) + ', 95% CI ' + interval(mixed) + ', optimizer=' + str(mixed.get('optimizer')) + ', convergence=' + fmt(mixed.get('converged')) if mixed.get('available') else 'unavailable: ' + str(mixed.get('reason', 'missing output'))) + '.', small=True)
    for attempt in mixed.get('diagnostics', []):
        p('MixedLM ' + str(attempt.get('optimizer')) + ': accepted=' + str(attempt.get('accepted')) + ', converged=' + str(attempt.get('converged')) + ', log likelihood=' + fmt(attempt.get('logLikelihood')) + '. ' + '; '.join(attempt.get('invalidReasons', [])) + ' Full warning and covariance diagnostics are retained in report/evidence.json.', small=True)
else:
    p('Original controlled headline model unavailable: ' + str(impact.get('message', 'No model output captured.')))
district_rows = []
for district in impact.get('districts', []):
    fitted = district.get('model')
    district_rows.append([district.get('d', ''), fmt(fitted.get('n')) if fitted else 'unavailable',
                          fmt(fitted.get('slope'), 6) if fitted else str(district.get('reason', 'unavailable')),
                          interval(fitted) if fitted else 'unavailable', fmt(fitted.get('q'), 6) if fitted else 'unavailable'])
if district_rows:
    table(['District', 'n', 'Slope / reason', '95% cluster CI', 'BH q'], district_rows, [27, 20, 61, 43, 23])
interaction_rows = []
for district in impact.get('districts', []):
    fitted, effect = district.get('interactionModel'), district.get('interaction')
    interaction_rows.append([
        district.get('d', ''), fmt(fitted.get('n')) if fitted else 'unavailable',
        fmt(effect.get('off'), 6) if effect else str(district.get('interactionReason', 'unavailable')),
        fmt(effect.get('peak'), 6) if effect else 'unavailable',
        fmt(effect.get('difference'), 6) if effect else 'unavailable',
    ])
if interaction_rows:
    table(['Peak interaction', 'n', 'Off-peak slope / reason', 'Peak slope', 'Peak minus off'], interaction_rows, [30, 20, 63, 30, 31])
p('The interaction values use the original rain-by-peak model, not a comparison of unmatched means. Its full intervals, cluster count, raw coefficients and multiplicity diagnostics are in report/evidence.json; all reported values are produced by analysis/impact_model.py.', small=True)
p('Original onset CCF: ' + ('available; see captured lag points and method metadata.' if impact.get('lagAvailable') else 'unavailable: ' + str(impact.get('lagReason', 'No supported input panel.'))) + ' Unavailable CCF is a missing-data/method condition, not an observed null effect.')
table(['Horizon', 'Ridge / persistence MAE', 'Skill %', 'Train / test pairs', 'Usable folds'], [
    [str(item.get('minutes')) + ' min', fmt(item.get('modelMAE')) + ' / ' + fmt(item.get('baselineMAE')) if item.get('available') else 'unavailable',
     fmt(item.get('skill')) if item.get('available') else 'unavailable', fmt(item.get('nTrain')) + ' / ' + fmt(item.get('nTest')), fmt(item.get('successfulFolds', 0)) + ' / 3']
    for item in forecasts
], [24, 53, 24, 43, 30])
for item in forecasts:
    if not item.get('available'):
        p(str(item.get('minutes')) + '-minute original forecast unavailable: ' + str(item.get('reason')), small=True)
detector_outlooks = forecast.get('perDetectorOutlooks', [])
p('Detector outlooks: ' + str(sum(item.get('available') is True for item in detector_outlooks)) + ' available exact 30-minute predictions among ' + str(len(detector_outlooks)) + ' detector states. Unavailable states retain reasons; network values are not substituted.', small=True)
if model:
    p('Finding 1 - adjusted rain association: the pooled speed-ratio slope is ' + fmt(model.get('slope'), 6) + ' per mm, or ' + fmt(1000 * model['slope'], 3) + ' percentage points per 10 mm; 95% detector-cluster interval ' + interval(model) + ', n=' + fmt(model.get('n')) + '. This is a sampled observational association, not a causal rain effect. Script: analysis/impact_model.py.')
outlook30 = next((item for item in forecasts if item.get('minutes') == 30 and item.get('available')), None)
if outlook30:
    p('Finding 2 - predictive performance: the 30-minute Ridge forecast has MAE ' + fmt(outlook30.get('modelMAE'), 4) + ' versus persistence ' + fmt(outlook30.get('baselineMAE'), 4) + ', an improvement of ' + fmt(outlook30.get('skill'), 2) + '% over ' + fmt(outlook30.get('nTest')) + ' test pairs in three chronological folds. Overlapping horizons and changing coverage limit generalization. Script: analysis/forecast_model.py.')
negative = next((item for item in impact.get('districts', []) if item.get('model') and item['model'].get('q') is not None and item['model']['q'] >= .05 and item['model']['lo'] <= 0 <= item['model']['hi']), None)
if negative:
    fitted = negative['model']
    p('Honest negative - ' + negative['d'] + ': adjusted slope ' + fmt(fitted['slope'], 6) + ', 95% cluster interval ' + interval(fitted) + ', BH q=' + fmt(fitted['q'], 4) + ', n=' + fmt(fitted['n']) + '. The specified district model does not provide evidence of a rain association at the 5% level; this does not establish zero effect. It is one of the six prespecified districts, not an unavailable-method result. Script: analysis/impact_model.py.')
p('All associations are descriptive. Repeated observations, shared rain, changing detector coverage, seasonal differences and denser wet-date sampling limit inference. Unsupported CCF is a data limitation, not a measured negative result.')

h('6. Original feedback and remaining acceptance')
p('Observed alerts require positive rain and CI above district/HKT-hour P90, or a matching validated detector 30-minute crossing. Decisions are associated with a live alert and one original role action. +30/+60-minute outcomes use actual same-detector/road CI in target through target+10 minutes. Open windows are pending; missing closed windows are censored. Initial CI, persistence and available forecast snapshots are frozen. A decision is fully evaluated only with actual evidence at both horizons.')
table(['Loop metric', 'Captured value / denominator'], [
    ['Alerts / linked decisions / fully evaluated', fmt(loop.get('alerts')) + ' / ' + fmt(loop.get('decisions')) + ' / ' + fmt(loop.get('evaluated'))],
    ['Pending / missing decision outcomes', fmt(loop.get('pending')) + ' / ' + fmt(loop.get('missing'))],
    ['Labeled alerts / hits / false alarms', fmt(loop.get('labeledAlerts')) + ' / ' + fmt(loop.get('hits')) + ' / ' + fmt(loop.get('falseAlarms'))],
    ['Hit rate / false-alarm rate', fmt(loop.get('hitRate')) + ' / ' + fmt(loop.get('falseAlarmRate')) + '; denominator=' + fmt(loop.get('denominators', {}).get('hitRate'))],
    ['Observed mean advance lead time', fmt(loop.get('leadTimeMinutes')) + ' min; denominator=' + fmt(loop.get('denominators', {}).get('leadTimeMinutes'))],
], [76, 98])
for minutes in (30, 60):
    result = loop.get('outcomesByHorizon', {}).get(str(minutes), {})
    p(str(minutes) + '-minute actual CI outcomes: evaluated=' + fmt(result.get('evaluated')) + ', pending=' + fmt(result.get('pending')) + ', missing=' + fmt(result.get('missing')) + '; mean CI change=' + fmt(result.get('outcomeDelta')) + ', persistence delta=' + fmt(result.get('baselineDelta')) + ', available forecast delta=' + fmt(result.get('forecastDelta')) + '.', small=True)
p('Actor roles are simulated stand-ins; observations are actual. Realized CI changes are descriptive, not evidence a choice caused improvement. False alarms require eligible actual observations and no observed crossing; gaps are not reconstructed. Non-alert misses remain unmeasured. Weekly refitting and operation duration require their own runtime evidence.', small=True)
table(['Original acceptance criterion', 'Evidence status in this report'], [
    ['10 days unattended, at least 95% feed uptime', 'Not established by this snapshot. Requires a dated continuous attempt/success and gap record.'],
    ['At least 40 days backfilled plus live data', ('Verified 40 HKT dates, 22 Sep-31 Oct 2026; 2,400 selected traffic versions at wet 10-minute / dry 60-minute cadence, no unknown daily classifications and zero failed downloads. Check original-data-audit.json and original-backfill-summary.json.' if backfill_verified else 'Pending complete successful-date and cadence evidence.')],
    ['Two findings plus one honest negative', ('Captured above: adjusted rain association, chronological 30-minute forecast comparison, and a measured non-significant district association.' if model and outlook30 and negative else 'Pending the corresponding estimable results; unsupported methods do not count as measured negatives.')],
    ['At least 20 alerts each with decision and outcome', 'Use actual linked and fully evaluated counts above; pending/censored records do not count as observed outcomes.'],
    ['Camera image-content No Service percentage', 'Unavailable: ' + str(e.get('cameraContent', {}).get('reason', 'No validated labelled image set/detector.'))],
    ['Optional camera congestion proxy', 'No claim without original 100-frame labelled calibration and evaluation.'],
], [65, 109])

story.append(PageBreak())
h('7. Current dashboard screenshots')
figure('live.png', 'Live: original hourly P85/exact CI, observed district rain, timed cameras and original alert conditions. Forecast availability is explicit.')
figure('analysis.png', 'Impact: raw-data original estimators and their intervals/diagnostics. Unsupported CCF remains unavailable with a source-resolution reason.')
story.append(PageBreak())
figure('replay.png', 'Replay: exact stored traffic frames and CI. Unobserved intervals and unavailable historical images remain gaps.')
figure('decisions.png', 'Loop: associated simulated actor actions with actual source observations, +30/+60 CI outcomes and explicit pending/missing states.')
story.append(PageBreak())
figure('quality.png', 'Trust: actual source freshness/validity, original forecast calibration and provenance. JPEG success does not classify image-content No Service.')

h('8. Verification, reproduction and submission')
p('Runtime checks captured ' + stamp(verification['checkedAt']) + ': ' + '; '.join(map(str, verification.get('checks', []))) + '.', small=True)
if test_results is not None:
    p('Recorded test summary (artifact values): ' + json.dumps(test_results, ensure_ascii=True, sort_keys=True), small=True)
else:
    p('No current original-test-results.json was supplied. This report does not reuse old test totals or assert unrecorded integration success.', small=True)
p('Machine evidence: artifacts/original-runtime-verification.json and report/evidence.json. A snapshot export/restore is verified only when its current manifests and isolated restore checks are supplied. Previous counts, old restore logs and older ZIPs do not verify this build.', small=True)
p('Start Docker Desktop, run powershell -ExecutionPolicy Bypass -File tools/setup.ps1, then docker compose up -d --build. Dashboard: http://localhost:1881/; editor: http://localhost:1881/red/. README.md explains flow upgrades, snapshots, source methods and tests. An awake connected host is required for continuous collection.', small=True)
p('The assignment PDF requires one ZIP with exported Node-RED flow, a Docker Hub ID or Docker description file, and project report. The package includes Node-RED and analytics Dockerfiles, compose.yaml, analysis/, pinned dependencies and source; local .env credentials are excluded. No cloud server is required. The original additional 10-day/40-day/20-decision acceptance criteria remain in force. This local work is unpublished.', small=True)
seen = set()
for item in e.get('sources', []):
    catalog = item.get('catalog')
    if catalog and catalog not in seen:
        seen.add(catalog)
        p(str(item.get('name', 'Source')) + ': ' + catalog, small=True)


def footer(canvas, document):
    canvas.setStrokeColor(colors.HexColor('#d3dde8'))
    canvas.line(17 * mm, 15 * mm, 193 * mm, 15 * mm)
    canvas.setFont('Helvetica', 8)
    canvas.setFillColor(colors.HexColor('#687b90'))
    canvas.drawString(17 * mm, 10 * mm, 'COMP7503A | Rain, Roads and the Commute')
    canvas.drawRightString(193 * mm, 10 * mm, str(document.page))


document = SimpleDocTemplate(str(OUT / 'Project-Report.pdf'), pagesize=A4,
                            rightMargin=18 * mm, leftMargin=18 * mm, topMargin=15 * mm, bottomMargin=21 * mm,
                            title='Rain, Roads and the Commute', author='COMP7503 group project')
document.build(story, onFirstPage=footer, onLaterPages=footer)
(OUT / 'Project-Report.md').write_text('\n'.join(markdown), encoding='utf-8')
inputs = [EVIDENCE, VERIFICATION, Path(__file__).resolve(), ROOT / 'PLAN-v4.md',
          *[OUT / 'screenshots' / name for name in SCREENSHOTS]]
inputs.extend(path for path in (TEST_RESULTS, authors_file) if path.is_file())
inputs.extend(path for path in (DATA_AUDIT, BACKFILL_SUMMARY, ROOT / 'artifacts/original-browser-verification.json') if path.is_file())
# Bind the current runtime source too; an old report cannot validate changed code.
inputs.extend(ROOT / name for name in ('README.md','ACCEPTANCE.md','compose.yaml','Dockerfile','Dockerfile.analytics','requirements-analytics.txt','flows.json','settings.js','package.json','package-lock.json'))
for directory, pattern in (('lib','*.cjs'),('analysis','*.py'),('web','*'),('tools','*')):
    inputs.extend(path for path in (ROOT / directory).rglob(pattern) if path.is_file() and '__pycache__' not in path.parts)
outputs = [OUT / 'Project-Report.pdf', OUT / 'Project-Report.md']
manifest = dict(generatedAt=datetime.now(timezone.utc).isoformat(), reference=REFERENCE,
                evidenceGeneratedAt=meta['generatedAt'], runtimeCheckedAt=verification['checkedAt'],
                inputs={path.relative_to(ROOT).as_posix(): digest(path) for path in inputs},
                outputs={path.relative_to(ROOT).as_posix(): digest(path) for path in outputs})
(OUT / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print('Built current report PDF/Markdown and build-manifest.json; render and inspect every PDF page before submission.')
