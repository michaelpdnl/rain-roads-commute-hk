"""Build data.js for the static dashboard mockup.

Real:  detector geometry (TD CSV), rush-hour + free-flow snapshots (data.gov.hk
       archive), district boundaries (HAD), camera IDs/locations (TD CSV).
Mock:  rain, impact scatter, lag curve, loop log, trust metrics, replay profile.
"""
import csv, json, math, random
from pathlib import Path
from lxml import etree

SRC = Path(r"C:\Users\micha\Desktop\dsh\.tmp\mock")
OUT = Path(r"C:\Users\micha\Desktop\dsh\multimediaProj\mockup\data\data.js")

STUDY = ["Kwun Tong", "Yau Tsim Mong", "Sha Tin", "Yuen Long", "Tsuen Wan", "Sham Shui Po"]
SHORT = {"Kwun Tong": "Kwun Tong", "Yau Tsim Mong": "Yau Tsim Mong", "Sha Tin": "Sha Tin",
         "Yuen Long": "Yuen Long", "Tsuen Wan": "Tsuen Wan", "Sham Shui Po": "Sham Shui Po"}

# ---------- detector dimensions ----------
dims = {}
with open(SRC / "detectors.csv", encoding="utf-8-sig", newline="") as f:
    for r in csv.DictReader(f):
        try:
            lat, lon = float(r["Latitude"]), float(r["Longitude"])
        except (TypeError, ValueError):
            continue
        dims[r["AID_ID_Number"]] = {
            "id": r["AID_ID_Number"], "d": r["District"],
            "road": r["Road_EN"].replace("[" + r["AID_ID_Number"] + "]", "").strip().rstrip("-").strip(),
            "lat": lat, "lon": lon,
        }


def parse_snapshot(name):
    root = etree.parse(str(SRC / name)).getroot()
    out = {}
    for det in root.iter("detector"):
        did = det.findtext("detector_id")
        speeds, occs, vols = [], [], []
        for lane in det.iter("lane"):
            if (lane.findtext("valid") or "N") != "Y":
                continue
            try:
                s = float(lane.findtext("speed"))
            except (TypeError, ValueError):
                continue
            if s > 150 or s <= 0:
                continue
            speeds.append(s)
            occs.append(float(lane.findtext("occupancy") or 0))
            vols.append(float(lane.findtext("volume") or 0))
        if speeds:
            out[did] = {
                "speed": sum(speeds) / len(speeds),
                "occ": max(occs), "vol": sum(vols),
            }
    return out


peak = parse_snapshot("snap_20261113-0830.xml")
base = parse_snapshot("snap_20261115-0300.xml")

detectors = []
for did, d in dims.items():
    if d["d"] not in STUDY or did not in peak:
        continue
    ff = base.get(did, {}).get("speed", 50.0)
    ff = max(ff, 30.0)
    p = peak[did]
    ci = max(0.0, min(0.95, 1.0 - p["speed"] / ff))
    detectors.append({**d, "ff": round(ff, 1), "speed": round(p["speed"], 1),
                      "occ": round(p["occ"], 1), "vol": round(p["vol"], 1), "ci": round(ci, 3)})

detectors.sort(key=lambda x: -x["ci"])

# ---------- districts ----------
gj = json.loads((SRC / "districts.json").read_text(encoding="utf-8-sig"))
districts = []
for feat in gj["features"]:
    name = (feat["properties"].get("District") or "").strip()
    rings = []
    for ring in feat["geometry"]["coordinates"]:
        pts = [[round(x, 5), round(y, 5)] for x, y in ring[::2]]
        if len(pts) > 3:
            rings.append(pts)
    districts.append({"name": name, "short": SHORT.get(name.replace(" District", ""), name.replace(" District", "")),
                      "study": name.replace(" District", "") in STUDY, "rings": rings})

# ---------- cameras ----------
CAMS = [("K613F", "Kwun Tong"), ("K202F", "Yau Tsim Mong"), ("ST115F", "Sha Tin"),
        ("YL111F", "Yuen Long"), ("SM936F", "Tsuen Wan"), ("K305F", "Sham Shui Po")]
cam_meta = {}
with open(r"C:\Users\micha\Desktop\dsh\cameras.csv", encoding="utf-8-sig", newline="") as f:
    for r in csv.DictReader(f):
        r = {(k or "").lstrip("\ufeff"): v for k, v in r.items()}
        if r.get("key"):
            cam_meta[r["key"]] = r
cameras = []
for cid, dist in CAMS:
    m = cam_meta.get(cid, {})
    cameras.append({"id": cid, "district": dist, "file": f"assets/cam/{cid}.jpg",
                    "name": (m.get("description") or cid).replace(f"[{cid}]", "").strip(),
                    "lat": float(m.get("latitude") or 0), "lon": float(m.get("longitude") or 0)})

# ---------- synthesised analytics ----------
random.seed(20261113)
SENS = {"Yuen Long": (-0.0220, -0.0265, -0.0178), "Tsuen Wan": (-0.0181, -0.0224, -0.0139),
        "Kwun Tong": (-0.0206, -0.0251, -0.0162), "Sham Shui Po": (-0.0174, -0.0219, -0.0131),
        "Yau Tsim Mong": (-0.0142, -0.0188, -0.0097), "Sha Tin": (-0.0121, -0.0159, -0.0084)}

points = []
for name, (slope, lo, hi) in SENS.items():
    for _ in range(110):
        rain = min(24.0, abs(random.gauss(4.2, 4.6)))
        sr = 1.0 + slope * rain + random.gauss(0, 0.085) - 0.03 * (random.random() < 0.15)
        sr = max(0.18, min(1.18, sr))
        points.append([round(rain, 2), round(sr, 3)])

fit = [[0, 1.0], [24, round(1.0 - 0.0172 * 24, 3)]]

lag = [{"lag": L, "eff": round(-0.017 * math.exp(-((L - 12) ** 2) / (2 * 22 ** 2)) * 24, 3)}
       for L in range(-30, 91, 10)]

peak_groups = []
for name, (slope, lo, hi) in SENS.items():
    peak_groups.append({"d": name, "peak": round(slope * 1.35, 4), "off": round(slope * 0.62, 4)})

rain_districts = [
    {"name": "Kwun Tong", "mm": 11.4}, {"name": "Yau Tsim Mong", "mm": 8.2},
    {"name": "Sha Tin", "mm": 14.6}, {"name": "Yuen Long", "mm": 21.8},
    {"name": "Tsuen Wan", "mm": 12.1}, {"name": "Sham Shui Po", "mm": 9.5},
]

# replay: 60 five-minute steps, 05:00 -> 10:00, rain builds then eases
replay_profile, replay_rain = [], []
for i in range(60):
    t = i / 59
    r = max(0.0, 26 * math.exp(-((t - 0.46) ** 2) / (2 * 0.14 ** 2)))
    replay_rain.append(round(r, 1))
    replay_profile.append(round(0.42 + 0.72 * (r / 26) ** 0.65, 3))

loop = {
    "funnel": [{"k": "Alerts raised", "v": 24}, {"k": "Decisions logged", "v": 19},
               {"k": "Outcomes measured", "v": 17}, {"k": "Improved", "v": 11}],
    "skill": {"persistence": 0.118, "model": 0.091,
              "days": [{"d": f"D{i+1}", "p": round(0.09 + random.uniform(0, 0.05), 3),
                        "m": round(0.07 + random.uniform(0, 0.04), 3)} for i in range(14)]},
    "decisions": [
        {"t": "08:14", "d": "Kwun Tong", "a": "Kwun Tong Rd E", "actor": "Commuter", "act": "Delay 20 min", "out": "CI 0.71 → 0.54", "v": "improved"},
        {"t": "08:22", "d": "Yuen Long", "a": "Castle Peak Rd", "actor": "Operator", "act": "Acknowledge + dispatch", "out": "CI 0.68 → 0.61", "v": "improved"},
        {"t": "08:31", "d": "Sha Tin", "a": "Tai Chung Kiu Rd", "actor": "Commuter", "act": "Switch to rail", "out": "wait 6.2 → 3.1 min", "v": "improved"},
        {"t": "08:44", "d": "Yau Tsim Mong", "a": "Salisbury Rd", "actor": "Planner", "act": "Flag for review", "out": "pending", "v": "pending"},
        {"t": "08:52", "d": "Tsuen Wan", "a": "Castle Peak Rd Tsuen", "actor": "Operator", "act": "Acknowledge", "out": "CI 0.59 → 0.63", "v": "worse"},
        {"t": "09:03", "d": "Sham Shui Po", "a": "Lai Chi Kok Rd", "actor": "Commuter", "act": "No change", "out": "CI 0.55 → 0.58", "v": "unchanged"},
        {"t": "09:17", "d": "Kwun Tong", "a": "Kwun Tong Rd W", "actor": "Operator", "act": "Dispatch relief", "out": "CI 0.66 → 0.57", "v": "improved"},
        {"t": "09:28", "d": "Sha Tin", "a": "Shing Mun River", "actor": "Planner", "act": "Flag for review", "out": "pending", "v": "pending"},
    ],
}

trust = {
    "feeds": [
        {"name": "Traffic detectors", "last": "08:23", "age": "42 s", "ok": True},
        {"name": "Hourly rainfall", "last": "08:00", "age": "23 min", "ok": True},
        {"name": "District weather", "last": "08:20", "age": "3 min", "ok": True},
        {"name": "Traffic cameras", "last": "08:23", "age": "1 min", "ok": True},
        {"name": "Daily rainfall archive", "last": "2026-09-30", "age": "47 d", "ok": False},
    ],
    "validity": [[round(min(1.0, 0.90 + random.uniform(-0.16, 0.08)), 2) for _ in range(24)] for _ in range(7)],
    "noservice": {"pct": 4.2, "byDistrict": [
        {"d": "Yuen Long", "v": 6.1}, {"d": "Sha Tin", "v": 3.8}, {"d": "Tsuen Wan", "v": 4.4},
        {"d": "Kwun Tong", "v": 2.9}, {"d": "Sham Shui Po", "v": 4.9}, {"d": "Yau Tsim Mong", "v": 2.2}]},
    "calibration": [{"h": "30 min", "v": 0.041}, {"h": "60 min", "v": 0.067}, {"h": "120 min", "v": 0.098}],
}

data = {
    "meta": {
        "snapshot": "2026-11-13T08:23:00+08:00",
        "freeflow": "2026-11-15T02:53:00+08:00",
        "n_detectors": len(detectors), "n_alerts": 12,
        "n_cameras": 1013, "n_network": 807,
        "rain_total": 21.8, "warning": "AMBER RAIN",
    },
    "districts": districts, "detectors": detectors, "cameras": cameras,
    "rain": {"districts": rain_districts, "profile": replay_rain},
    "replay": {"rain": replay_rain, "profile": replay_profile},
    "impact": {"points": points, "fit": fit,
               "sens": [{"d": k, "slope": v[0], "lo": v[1], "hi": v[2], "n": 214} for k, v in SENS.items()],
               "lag": lag, "peak": peak_groups,
               "stats": {"n": 1284, "r2": 0.41, "slope": -0.0172, "p": "<0.001", "units": "speed ratio per mm/h"}},
    "loop": loop, "trust": trust,
}

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text("window.MOCK=" + json.dumps(data, separators=(",", ":")) + ";", encoding="utf-8")
print("detectors:", len(detectors), "| districts:", len(districts), "| cameras:", len(cameras),
      "| points:", len(points), "| bytes:", OUT.stat().st_size)
print("ci range:", round(min(d["ci"] for d in detectors), 3), "-", round(max(d["ci"] for d in detectors), 3))
