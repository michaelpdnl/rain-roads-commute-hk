"""Build the project report from a captured API response, not mockup statistics.
Run on the host: python tools/report.py
Requires reportlab; inputs: report/evidence.json and report/screenshots/*.png.
Optional report/authors.json: [{"name":"...", "studentId":"..."}, ...].
"""
import json
from pathlib import Path
from datetime import datetime, timezone, timedelta
from xml.sax.saxutils import escape
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Image, KeepTogether
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'report'
OUT.mkdir(exist_ok=True)
e = json.loads((OUT / 'evidence.json').read_text(encoding='utf-8'))
a, meta = e['analysis'], e['meta']
styles = getSampleStyleSheet()
styles.add(ParagraphStyle('Body', fontName='Helvetica', fontSize=10, leading=14, spaceAfter=8, textColor=colors.HexColor('#25374a')))
styles.add(ParagraphStyle('SmallBody', parent=styles['Body'], fontSize=8.5, leading=11, spaceAfter=6))
styles['Title'].textColor = colors.HexColor('#173c60')
styles['Title'].fontSize = 25
styles['Title'].leading = 30
styles['Heading1'].textColor = colors.HexColor('#173c60')
styles['Heading1'].fontSize = 15
styles['Heading1'].leading = 20
styles['Heading2'].textColor = colors.HexColor('#286084')
styles['Heading2'].fontSize = 11
styles['Heading2'].leading = 15
story = []
markdown = ['# Rain, Roads and the Commute', '', 'COMP7503A - Multimedia Technologies - Group Programming Assignment', '']

def h(text):
    story.append(Paragraph(escape(text), styles['Heading1']))
    markdown.extend(['', '## '+text, ''])

def p(text, small=False):
    story.append(Paragraph(escape(text), styles['SmallBody' if small else 'Body']))
    markdown.extend([text, ''])

def table(headers, rows, widths):
    content = [[Paragraph(escape(str(v)), styles['SmallBody']) for v in row] for row in [headers]+rows]
    t = Table(content, colWidths=[v*mm for v in widths], repeatRows=1, hAlign='LEFT')
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#e6eff6')),('VALIGN',(0,0),(-1,-1),'TOP'),('LINEBELOW',(0,0),(-1,0),.6,colors.HexColor('#8ea9bf')),('LINEBELOW',(0,1),(-1,-1),.3,colors.HexColor('#dce4ec')),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),3)]))
    story.extend([t,Spacer(1,7)])
    markdown.extend(['| '+' | '.join(headers)+' |', '| '+' | '.join(['---']*len(headers))+' |'])
    markdown.extend('| '+' | '.join(map(str,r))+' |' for r in rows)
    markdown.append('')

def stamp(v):
    if not v: return 'unavailable'
    return datetime.fromisoformat(v.replace('Z','+00:00')).astimezone(timezone(timedelta(hours=8))).strftime('%d %b %Y %H:%M:%S HKT')

def figure(file, caption, height=102):
    image = Image(str(OUT/'screenshots'/file), width=174*mm, height=height*mm, kind='proportional', hAlign='CENTER')
    story.extend([image, Spacer(1,3*mm), Paragraph(escape(caption),styles['SmallBody']),Spacer(1,3*mm)])
    markdown.extend([f'![{caption}](screenshots/{file})',''])

story.append(Paragraph('Rain, Roads<br/>and the Commute',styles['Title']))
p('COMP7503A - Multimedia Technologies\nGroup Programming Assignment, 2026-2027')
authors_file=OUT/'authors.json'
if authors_file.exists():
    for author in json.loads(authors_file.read_text(encoding='utf-8')):
        p(f"{author['name']} - {author['studentId']}")
p('A live Hong Kong dashboard for traffic and rainfall situational awareness. Implementation and measured results as of '+stamp(meta['generatedAt'])+'.')
h('1. Smart-city use cases')
p('Commuters and transport observers need to distinguish an actually slow road from a stale feed or an unavailable camera. The system combines numeric road measurements, district weather reports and real traffic imagery to support that judgement. It covers Kwun Tong, Yau Tsim Mong, Sha Tin, Yuen Long, Tsuen Wan and Sham Shui Po.')
p('The decision cycle is: open data produces measurements; combined views create situational awareness; a person considers a route, departure-time or mode choice; subsequent measured road conditions are observed again. The application records considered choices and later observations. It neither dispatches vehicles nor claims a choice caused a speed change.')
h('2. Data streams and multimedia')
table(['Stream / provider','Use and cadence'],[
 ['Traffic speed, lane volume, occupancy / TD','XML source approximately every minute; sampled every 2 minutes. Official location CSV refreshed daily.'],
 ['Rainfall in the past hour / HKO','Station JSON updated every 15 minutes, sampled every 15 minutes; raw station measurements are preserved.'],
 ['Current weather report / HKO','Hourly and when updated; sampled every 10 minutes. District rainfall maximum is joined to road periods; temperature provides context.'],
 ['Traffic snapshots / TD','Six actual JPEG views, one in each study district, captured every 2 minutes from catalogued camera locations.']
],[50,124])
p('All four datasets are catalogued in DATA.GOV.HK; the raw resources are served by the relevant departments. Imagery supplies visual evidence alongside numeric data. No generated image, simulated rain series or fabricated forecast is used. Source links are listed in section 7.',small=True)
story.append(PageBreak())

h('3. Implementation and storage')
p('Docker Compose runs Node-RED and MongoDB on a private container network. The application image contains the program, dependencies, flow export and static dashboard. MongoDB records, deployed flows and captured images live in named persistent volumes. Only the local dashboard port 1881 is published. A public server is optional; collecting continuously still requires an awake, connected computer.')
p('Node-RED is the runtime orchestrator. The collection tab wires Inject timers to source URL functions, core HTTP Request nodes, and validation/storage functions. A shared JavaScript service is loaded through functionGlobalContext and supplies MongoDB access, parsers and analysis. Camera and location retrieval are called by Node-RED function nodes. The API tab provides the dashboard, replay, image, decision and health endpoints. There is no separate Python or FastAPI server.')
table(['Collection / files','Storage approach'],[
 ['traffic','Upsert by detector ID + source period time. Stores district, road, coordinates, weighted speed, occupancy, volume, validity and fetch time.'],
 ['district_rain, station_rain, weather','Retain original source times and rainfall values; raw weather reports are preserved. Repeated source timestamps update the same ID.'],
 ['camera_metadata, camera_frames, camera_status','Catalog coordinates and URL; JPEG file, retrieval time, source Last-Modified header and byte count. Files persist under /data/commute/cameras.'],
 ['feed_health, imports, decisions','Request/observation timestamps and failures; official-archive provenance; actual considered choices and later observed outcomes.']
],[52,122])
p('Indexes cover traffic observation time, district/time, camera/time, and pending decision targets. Duplicate polling does not multiply the same detector-period. Failed acquisition preserves prior data and updates quality status. A successful JPEG request does not establish that the picture contains no “No Service” notice.',small=True)
h('4. Analysis and correlation methods')
p('Lane measurements contribute only when marked valid with finite speed from 0 to 160 km/h and nonnegative volume. Detector speed is weighted by lane vehicle volume. Periods with no observed vehicles are excluded from speed analysis; stopped vehicles with nonzero volume remain valid. Occupancy averages use valid values from 0 to 100%. Missing values remain null and are never silently treated as zero rainfall.')
p('Road periods are linked to the latest rainfall window ending at or before the road time in the same district, with a maximum age of 30 minutes. This is district maximum rainfall, not rainfall measured at that exact detector. Unmatched road periods are excluded from rain analysis. Overlapping one-hour rain windows and repeated detectors are not independent samples.')
p('The dashboard computes means by district, weekday peak versus other-hour comparisons, and Pearson speed/occupancy correlation. Peak is defined as 07:00-10:00 and 17:00-20:00 HKT on weekdays. A descriptive rain/speed OLS line is shown only with at least 10 wet and 10 dry paired periods and nonconstant values. No confidence interval, causal attribution or forecast skill is claimed.')
p('Analysis and replay use the most recent 24,000 stored detector-periods for the chosen area, then apply the hour filter. Counts refer to that selected sample, not the whole archive. Scatter plots display at most about 1,200 selected points. Road mix, speed limits, weekday and hour confound direct comparisons.',small=True)
story.append(PageBreak())

h('5. Measured results and limits')
table(['Metric','Observed value'],[
 ['Stored traffic records',str(meta['records'])],
 ['Study detector locations',str(meta['locations'])],
 ['Analysed valid periods with vehicles',str(a['n'])],
 ['Analysis observation range',stamp(a['start'])+' to '+stamp(a['end'])],
 ['Mean measured speed',f"{a['meanSpeed']} km/h"],
 ['Pearson speed / occupancy correlation',str(a['speedOccupancy'])],
 ['Weekday peak / other-hour mean speed',f"{a['peakSpeed']} / {a['offPeakSpeed']} km/h"],
 ['Rain-paired periods; wet / dry',f"{a['paired']}; {a['wet']} wet / {a['dry']} dry"]
],[71,103])
for f in a['findings']:
    p(f"{f['title']}: {f['value']}. {f['detail']}")
p('Rainfall result: '+a['rainMessage'])
p('These are descriptive results from the measured sample. A negative occupancy/speed correlation is consistent with slower movement when vehicles occupy a detector for more time; it does not by itself identify the cause. The peak/other-hour difference is not a controlled experiment. The currently collected district rain values are dry, so the system cannot estimate a reliable wet-weather effect from this sample.')
p('Seven selected official TD historical XML files were imported for 13, 15, 16 and 17 November. These are individual snapshots, not continuous multi-day coverage. The corresponding HKO JSON archive requests returned HTTP 404 during verification. A recent road snapshot could be paired with the actually collected current weather report. No missing historical rain or camera frame is manufactured. Source dates, times and resolved archive URLs remain attached to imported traffic records.')
p('Live collection has a short initial duration. The source can lag the current clock, and polling every two minutes captures only the periods included in each response. Collection gaps and unpaired rain are visible. A longer collection including actual wet episodes is needed before making a stronger rainfall claim.')
h('6. Dashboard views')
p('The next pages show actual browser renders of the running application. The original teammate prototype supplied the visual layout and map context. Its hard-coded measurements, synthetic replay, forecast scores and invented decision history were replaced with stored observations and computed results.')
story.append(PageBreak())

h('6.1 Live and Analysis')
figure('live.png','Live: measured speed map, slowest observed roads, timed district rainfall and six real camera captures. Camera capture times and stale state are visible. A low-speed rule below 20 km/h is descriptive, not an official congestion category.')
figure('analysis.png','Analysis: district comparisons, source-timed rain/speed pairs, speed/occupancy association and weekday peak versus other hours. Insufficient rain variation is explicitly reported; the page supplies no invented regression coefficient.')
story.append(PageBreak())

h('6.2 Replay and Decisions')
figure('replay.png','Replay: select actual stored timestamps. Points use elapsed time and gaps are preserved; no synthetic intermediate traffic frames are created. Only a camera capture within the preceding three minutes is eligible for the selected road time.')
figure('decisions.png','Decisions: record a real considered commute option. At +30 minutes, the next valid road period within ten minutes is compared with the initial speed. No decision is fabricated to populate the log, and no causal travel-time saving is claimed.')
story.append(PageBreak())

h('6.3 Data quality and validation')
figure('quality.png','Data quality: observation timestamps, last successful fetch, source lag, stored detector validity, camera retrieval status and DATA.GOV.HK provenance. A stale source is distinguished from a failed HTTP request.')
p('Validation included seven passing tests with no skipped cases in the actual MongoDB run. Coverage included CSV encodings, valid-lane aggregation, HKT timestamps, missing values, bounded non-future rain joins, constant-rain rejection, HTTP redirects/failures, deduplication, failed-source preservation, decision outcomes beyond the latest-30 display limit, and stale-camera state.')
p('A runtime check recorded at least 15 minutes of source-time traffic observations from repeated automatic collection. Recreating the Node-RED container retained the existing MongoDB records and continued adding observations. An exported data snapshot restored successfully into a separate test database with matching record counts. Test fixtures were isolated from production and removed after testing.')
p('Browser checks covered all five tabs, area filtering, charts, actual image loading and stored replay. A final independent code review found two issues (old-camera labelling and older pending outcomes); both received failing regression cases, fixes and passing checks. Exact machine-readable evidence and the acceptance mapping are supplied alongside this report.',small=True)
h('7. Reproduction, sources and submission')
p('Start Docker Desktop. In the unzipped project directory, run powershell -ExecutionPolicy Bypass -File tools/setup.ps1, then docker compose up -d --build. Open http://localhost:1881/ after the initial source requests; the flow editor is http://localhost:1881/red/. Detailed commands, shutdown instructions, optional historical import and supplied-history restoration are in README.md.')
p('The single ZIP contains flows.json, Dockerfile, compose.yaml, pinned dependency files, runtime source, this report, verification evidence and an optional history snapshot. The PDF permits a Docker description file instead of a Docker Hub ID. No public-cloud URL is required by the assignment. The local .env credentials are not included.',small=True)
for source in e['sources']:
    # Deduplicate the detector-location catalog shared with traffic.
    if source['name']=='TD detector locations': continue
    p(source['name']+': '+source['catalog'],small=True)

def footer(canvas, doc):
    canvas.setStrokeColor(colors.HexColor('#d3dde8'));canvas.line(17*mm,15*mm,193*mm,15*mm)
    canvas.setFont('Helvetica',8);canvas.setFillColor(colors.HexColor('#687b90'))
    canvas.drawString(17*mm,10*mm,'COMP7503A | Rain, Roads and the Commute')
    canvas.drawRightString(193*mm,10*mm,str(doc.page))

doc=SimpleDocTemplate(str(OUT/'Project-Report.pdf'),pagesize=A4,rightMargin=18*mm,leftMargin=18*mm,topMargin=15*mm,bottomMargin=21*mm,title='Rain, Roads and the Commute',author='COMP7503 group project')
doc.build(story,onFirstPage=footer,onLaterPages=footer)
(OUT/'Project-Report.md').write_text('\n'.join(markdown),encoding='utf-8')
print('Built report/Project-Report.pdf and editable Project-Report.md')
