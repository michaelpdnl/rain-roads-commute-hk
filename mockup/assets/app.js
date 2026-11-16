/* Dashboard mockup — static, no backend. Real geometry + one real snapshot;
   the time dimension and analytics are synthesised. */
const M = window.MOCK;
const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (v, d = 1) => Number(v).toFixed(d);

/* ── colour ─────────────────────────────────────────────── */
const RAMP = [[0, [47, 111, 159]], [0.45, [217, 164, 65]], [0.78, [212, 71, 47]], [1, [150, 30, 24]]];
function ciColor(v) {
  v = clamp(v, 0, 1);
  for (let i = 1; i < RAMP.length; i++) {
    if (v <= RAMP[i][0]) {
      const [a, ca] = RAMP[i - 1], [b, cb] = RAMP[i];
      const t = (v - a) / (b - a || 1);
      return `rgb(${ca.map((c, j) => Math.round(c + (cb[j] - c) * t)).join(',')})`;
    }
  }
  return 'rgb(150,30,24)';
}
const SHORT = { 'Kwun Tong': 'Kwun Tong', 'Yau Tsim Mong': 'Yau Tsim Mong', 'Sha Tin': 'Sha Tin', 'Yuen Long': 'Yuen Long', 'Tsuen Wan': 'Tsuen Wan', 'Sham Shui Po': 'Sham Shui Po' };

/* ── chart defaults ─────────────────────────────────────── */
Chart.defaults.color = '#7f8fa2';
Chart.defaults.font.family = 'Inter,"Segoe UI",system-ui,sans-serif';
Chart.defaults.font.size = 9;
Chart.defaults.plugins.legend.display = false;
Chart.defaults.plugins.tooltip.backgroundColor = '#141c25';
Chart.defaults.plugins.tooltip.borderColor = '#26323f';
Chart.defaults.plugins.tooltip.borderWidth = 1;
Chart.defaults.plugins.tooltip.titleFont = { size: 10 };
Chart.defaults.plugins.tooltip.bodyFont = { size: 10 };
Chart.defaults.plugins.tooltip.padding = 7;
Chart.defaults.elements.point.radius = 0;
const GRID = { color: '#18222c', drawTicks: false };
const AX = { grid: GRID, border: { display: false }, ticks: { color: '#6b7d90', font: { size: 8.5 }, padding: 3 } };
const charts = [];
const mk = (id, cfg) => { const c = new Chart(document.getElementById(id), cfg); charts.push(c); return c; };

/* ── map ────────────────────────────────────────────────── */
function buildMap(el) {
  // frame on the detector extent, not the administrative boundary (which
  // includes far-flung islands and would shrink the city to a sliver)
  let minLon = 1e9, maxLon = -1e9, minLat = 1e9, maxLat = -1e9;
  for (const d of M.detectors) {
    minLon = Math.min(minLon, d.lon); maxLon = Math.max(maxLon, d.lon);
    minLat = Math.min(minLat, d.lat); maxLat = Math.max(maxLat, d.lat);
  }
  const padLon = (maxLon - minLon) * 0.10, padLat = (maxLat - minLat) * 0.12;
  minLon -= padLon; maxLon += padLon; minLat -= padLat; maxLat += padLat;
  const W = 1000, k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const H = W * (maxLat - minLat) / ((maxLon - minLon) * k);
  const px = (lon) => (lon - minLon) / (maxLon - minLon) * W;
  const py = (lat) => (maxLat - lat) / (maxLat - minLat) * H;

  let s = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"><g>`;
  for (const d of M.districts) {
    for (const ring of d.rings) {
      s += `<path class="dist${d.study ? ' study' : ''}" d="M${ring.map(([x, y]) => px(x).toFixed(1) + ',' + py(y).toFixed(1)).join('L')}Z"/>`;
    }
  }
  s += `</g><g class="labels">`;
  for (const d of M.districts.filter((x) => x.study)) {
    const mine = M.detectors.filter((x) => SHORT[x.d] === (SHORT[d.short] || d.short));
    const src = mine.length ? mine : null;
    if (!src) continue;
    const cx = src.reduce((t, p) => t + p.lon, 0) / src.length;
    const cy = src.reduce((t, p) => t + p.lat, 0) / src.length;
    s += `<text class="dlabel" x="${px(cx).toFixed(0)}" y="${(py(cy) - 6).toFixed(0)}" text-anchor="middle">${SHORT[d.short] || d.short}</text>`;
  }
  s += `</g><g class="dots"></g></svg>`;
  el.innerHTML = s;

  const dotsG = el.querySelector('.dots');
  const dots = {};
  for (const det of M.detectors) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('class', 'det');
    c.setAttribute('cx', px(det.lon).toFixed(1));
    c.setAttribute('cy', py(det.lat).toFixed(1));
    c.setAttribute('r', 3.0);
    c.setAttribute('fill', ciColor(det.ci));
    c.setAttribute('opacity', 0.95);
    c.dataset.id = det.id;
    c.innerHTML = `<title>${det.road}\n${det.d} · CI ${fmt(det.ci, 2)} · ${fmt(det.speed, 0)} km/h</title>`;
    dotsG.appendChild(c);
    dots[det.id] = c;
  }

  const lg = document.createElement('div');
  lg.className = 'legend';
  lg.innerHTML = `<div>Congestion index</div><div class="bar"></div>
    <div class="ends"><span>0 calm</span><span>1 jammed</span></div>`;
  el.appendChild(lg);
  return { dots, svg: el.querySelector('svg') };
}

function paintMap(map, mult) {
  for (const det of M.detectors) {
    const v = clamp(det.ci * mult, 0, 1);
    const c = map.dots[det.id];
    c.setAttribute('fill', ciColor(v));
    c.setAttribute('r', (3.0 + v * 1.6).toFixed(2));
  }
}

/* ── live ───────────────────────────────────────────────── */
let liveMap;
function renderLive() {
  liveMap = buildMap($('#mapLive'));
  $('#liveN').textContent = M.detectors.length;

  const top = M.detectors.slice(0, 8);
  $('#rank').innerHTML = top.map((d, i) => `
    <div class="rrow">
      <span class="rk">${String(i + 1).padStart(2, '0')}</span>
      <span class="rname">${d.road || d.id}<em>${SHORT[d.d] || d.d} · ${fmt(d.speed, 0)} km/h</em></span>
      <span class="rbar"><i style="width:${(d.ci * 100).toFixed(0)}%;background:${ciColor(d.ci)}"></i></span>
      <span class="rval" style="color:${ciColor(d.ci)}">${fmt(d.ci, 2)}</span>
    </div>`).join('');

  const maxMm = Math.max(...M.rain.districts.map((d) => d.mm));
  $('#rainstrip').innerHTML = M.rain.districts.map((d) => `
    <div class="rcell" style="background:rgba(77,163,255,${(0.04 + 0.16 * d.mm / maxMm).toFixed(2)})">
      <span class="rn">${d.name}</span>
      <span class="rv">${fmt(d.mm, 1)}<span>mm</span></span>
    </div>`).join('') +
    `<div class="rcell other"><span class="rn">12 other districts<br>0.0 – 6.2 mm</span></div>`;

  $('#camwall').innerHTML = M.cameras.slice(0, 6).map((c) => `
    <div class="cam"><img src="${c.file}" alt="${c.id}">
      <span class="cl"><b>${c.id}</b><span>${fmt(c.lat, 3)}, ${fmt(c.lon, 3)}</span></span>
    </div>`).join('');

  mk('outlook', {
    type: 'line',
    data: {
      labels: ['now', '+6', '+12', '+18', '+24', '+30'],
      datasets: [
        { data: [0.71], borderColor: '#e0533f', borderWidth: 2, pointRadius: 2, pointBackgroundColor: '#e0533f' },
        { data: [0.71, 0.69, 0.66, 0.62, 0.58, 0.54], borderColor: '#4da3ff', borderWidth: 1.6, borderDash: [3, 3], pointRadius: 0, fill: true, backgroundColor: 'rgba(77,163,255,.08)' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: { x: { ...AX, ticks: { display: false } }, y: { ...AX, min: 0.5, max: 0.75, ticks: { display: false } } },
      plugins: { tooltip: { enabled: false } },
    },
  });
}

/* ── impact ─────────────────────────────────────────────── */
function renderImpact() {
  mk('cScatter', {
    type: 'scatter',
    data: {
      datasets: [
        { label: 'detector-hours', data: M.impact.points, backgroundColor: 'rgba(77,163,255,.38)', pointRadius: 2.4 },
        { label: 'fit', type: 'line', data: M.impact.fit, borderColor: '#e0a33e', borderWidth: 2, pointRadius: 0, borderDash: [4, 3] },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ...AX, min: 0, max: 24 },
        y: { ...AX, min: 0.15, max: 1.2 },
      },
    },
  });

  const sens = M.impact.sens.slice().sort((a, b) => a.slope - b.slope);
  mk('cSens', {
    type: 'bar',
    data: {
      labels: sens.map((s) => SHORT[s.d] || s.d),
      datasets: [{
        data: sens.map((s) => [s.lo, s.hi]),
        backgroundColor: sens.map((s) => ciColor(Math.abs(s.slope) / 0.028)),
        borderRadius: 2, barThickness: 11,
      }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ...AX, min: -0.032, max: 0, ticks: { stepSize: 0.01, callback: (v) => v.toFixed(3) } },
        y: { ...AX, grid: { display: false } },
      },
      plugins: { tooltip: { callbacks: { label: (c) => `95% CI ${c.raw[0].toFixed(4)} … ${c.raw[1].toFixed(4)}` } } },
    },
  });

  mk('cLag', {
    type: 'line',
    data: {
      labels: M.impact.lag.map((p) => p.lag),
      datasets: [{
        data: M.impact.lag.map((p) => p.eff),
        borderColor: '#4da3ff', borderWidth: 2, pointRadius: M.impact.lag.map((p) => p.lag === 10 ? 3.5 : 0),
        pointBackgroundColor: '#e0a33e', fill: true, backgroundColor: 'rgba(77,163,255,.10)',
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ...AX },
        y: { ...AX, ticks: { callback: (v) => v.toFixed(2) } },
      },
    },
  });

  mk('cPeak', {
    type: 'bar',
    data: {
      labels: M.impact.peak.map((p) => SHORT[p.d] || p.d),
      datasets: [
        { label: 'peak', data: M.impact.peak.map((p) => p.peak), backgroundColor: 'rgba(224,83,63,.75)', borderRadius: 2, barThickness: 10 },
        { label: 'off-peak', data: M.impact.peak.map((p) => p.off), backgroundColor: 'rgba(77,163,255,.55)', borderRadius: 2, barThickness: 10 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ...AX, grid: { display: false }, ticks: { color: '#6b7d90', font: { size: 7.5 }, maxRotation: 40 } },
        y: { ...AX, ticks: { callback: (v) => v.toFixed(2) } },
      },
      plugins: { legend: { display: true, labels: { boxWidth: 6, boxHeight: 6, font: { size: 8 } } } },
    },
  });
}

/* ── replay ─────────────────────────────────────────────── */
let replayMap, replayIdx = 41, playing = false, timer = null, speed = 10, timelineChart;
const REF = 41;
const frameTime = (i) => { const m = 5 * 60 + i * 5; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

function renderReplay() {
  replayMap = buildMap($('#mapReplay'));
  const ev = [
    ['07:05', 'Rain begins', 'First wet hour on 4 of 6 districts'],
    ['07:42', 'CI crosses P90', 'Kwun Tong Rd E · 0.52'],
    ['08:03', 'Bunching detected', '3 bus routes, headway CV &gt; 0.6'],
    ['08:23', 'Peak alert', '12 detectors above threshold'],
    ['09:10', 'Rain eases', 'CI falling, lag ~12 min'],
    ['09:48', 'Recovery', 'Network CI back to 0.31'],
  ];
  $('#events').innerHTML = ev.map(([t, h, x]) => `<div class="ev"><span class="t">${t}</span><span class="x"><b>${h}</b>${x}</span></div>`).join('');

  $('#camstrip').innerHTML = M.cameras.slice(0, 4).map((c) => `
    <div class="cam"><img src="${c.file}" alt="${c.id}"><span class="cl"><b>${c.id}</b><span>${frameTime(replayIdx)}</span></span></div>`).join('');

  const meanCI = M.replay.profile.map((v) => M.detectors.reduce((t, d) => t + d.ci, 0) / M.detectors.length * v / M.replay.profile[REF]);
  timelineChart = mk('cTimeline', {
    data: {
      labels: M.replay.profile.map((_, i) => frameTime(i)),
      datasets: [
        { type: 'bar', data: M.replay.rain, backgroundColor: 'rgba(77,163,255,.28)', borderRadius: 1, yAxisID: 'y1', barPercentage: 0.9 },
        { type: 'line', data: meanCI, borderColor: '#e0533f', borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: 'y' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ...AX, ticks: { maxTicksLimit: 7, callback: (v, i) => frameTime(i) } },
        y: { ...AX, min: 0, max: 0.8, position: 'left' },
        y1: { ...AX, min: 0, max: 30, position: 'right', grid: { display: false } },
      },
    },
    plugins: [{
      id: 'cursor',
      afterDatasetsDraw(c) {
        const x = c.scales.x.getPixelForValue(replayIdx);
        const { top, bottom } = c.chartArea;
        c.ctx.save(); c.ctx.strokeStyle = 'rgba(224,163,62,.8)'; c.ctx.lineWidth = 1;
        c.ctx.beginPath(); c.ctx.moveTo(x, top); c.ctx.lineTo(x, bottom); c.ctx.stroke(); c.ctx.restore();
      },
    }],
  });

  paintReplay();
}

function paintReplay() {
  const mult = M.replay.profile[replayIdx] / M.replay.profile[REF];
  paintMap(replayMap, mult);
  const t = frameTime(replayIdx);
  $('#rTime').textContent = t; $('#rClock').textContent = t;
  $('#scrub').value = replayIdx;
  timelineChart.update('none');
}

function setPlaying(on) {
  playing = on;
  $('#playBtn').textContent = on ? '❚❚ Pause' : '▶ Play';
  clearInterval(timer);
  if (on) {
    timer = setInterval(() => {
      replayIdx = (replayIdx + 1) % 60;
      paintReplay();
    }, 900 / speed);
  }
}

/* ── loop ───────────────────────────────────────────────── */
function renderLoop() {
  const max = Math.max(...M.loop.funnel.map((f) => f.v));
  $('#funnel').innerHTML = M.loop.funnel.map((f, i) => `
    <div class="fstep">
      <div><div class="fl">${f.k}</div><div class="fbar l${i + 1}" style="width:${(f.v / max * 100).toFixed(0)}%"></div></div>
      <div class="fv">${f.v}</div>
    </div>`).join('');

  mk('cSkill', {
    type: 'line',
    data: {
      labels: M.loop.skill.days.map((d) => d.d),
      datasets: [
        { label: 'persistence', data: M.loop.skill.days.map((d) => d.p), borderColor: '#5a6979', borderWidth: 1.4, pointRadius: 0, borderDash: [3, 3] },
        { label: 'model', data: M.loop.skill.days.map((d) => d.m), borderColor: '#45b98a', borderWidth: 2, pointRadius: 0, fill: true, backgroundColor: 'rgba(69,185,138,.10)' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { ...AX, ticks: { maxTicksLimit: 7 } }, y: { ...AX, min: 0.04, max: 0.16 } },
      plugins: { legend: { display: true, labels: { boxWidth: 6, boxHeight: 6, font: { size: 8 } } } },
    },
  });

  $('#decisionTable').innerHTML = `<div class="thead"><span>time</span><span>alert</span><span>actor</span><span>action</span><span>outcome</span><span>verdict</span></div>` +
    M.loop.decisions.map((d) => `
      <div class="trow">
        <span class="tt">${d.t}</span>
        <span class="dd">${d.a}<em>${SHORT[d.d] || d.d}</em></span>
        <span>${d.actor}</span>
        <span>${d.act}</span>
        <span class="oo">${d.out}</span>
        <span class="verdict v-${d.v}">${d.v}</span>
      </div>`).join('');
}

/* ── trust ──────────────────────────────────────────────── */
function heatColor(v) {
  if (v >= 0.95) return '#2f7f6a';
  if (v >= 0.9) return '#3c7f5a';
  if (v >= 0.85) return '#7a7a35';
  return '#8a4a33';
}
function renderTrust() {
  $('#feeds').innerHTML = M.trust.feeds.map((f) => `
    <div class="feed">
      <span class="fdot ${f.ok ? 'ok' : 'bad'}"></span>
      <span class="fname">${f.name}<em>${f.ok ? 'nominal' : 'stale · excluded from model'}</em></span>
      <span class="flast">${f.last}</span>
      <span class="fage ${f.ok ? '' : 'bad'}">${f.age}</span>
    </div>`).join('');

  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let h = `<div></div>` + Array.from({ length: 24 }, (_, i) => `<div class="hhead">${i % 3 === 0 ? i : ''}</div>`).join('');
  M.trust.validity.forEach((row, r) => {
    h += `<div class="hlab">${days[r]}</div>` + row.map((v) => `<div class="hcell" style="background:${heatColor(v)}" title="${v}"></div>`).join('');
  });
  $('#heat').innerHTML = h;

  const ns = M.trust.noservice;
  $('#noservice').innerHTML = `<div class="hbars">` + ns.byDistrict.map((d) => `
    <div class="hbar"><span>${SHORT[d.d] || d.d}</span><span class="tr"><i style="width:${d.v / 8 * 100}%"></i></span><span class="vv">${fmt(d.v, 1)}%</span></div>`).join('') + `</div>`;
  $('#noservice').insertAdjacentHTML('afterbegin', `<div class="bigstat"><b>${fmt(ns.pct, 1)}%</b><span>frames unavailable · 1,013 cameras</span></div>`);

  mk('cCal', {
    type: 'bar',
    data: {
      labels: M.trust.calibration.map((c) => c.h),
      datasets: [{ data: M.trust.calibration.map((c) => c.v), backgroundColor: ['#45b98a', '#e0a33e', '#e0533f'], borderRadius: 2, barThickness: 22 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { ...AX, grid: { display: false } }, y: { ...AX, ticks: { callback: (v) => v.toFixed(2) } } },
      plugins: { tooltip: { callbacks: { label: (c) => `MAE ${c.raw.toFixed(3)}` } } },
    },
  });
}

/* ── router ─────────────────────────────────────────────── */
const RENDER = { live: renderLive, impact: renderImpact, replay: renderReplay, loop: renderLoop, trust: renderTrust };
const done = new Set();
function show(page) {
  if (!RENDER[page]) page = 'live';
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'p-' + page));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.page === page));
  if (location.hash.slice(1) !== page) history.replaceState(null, '', '#' + page);
  if (!done.has(page)) { done.add(page); RENDER[page](); }
  else { requestAnimationFrame(() => charts.forEach((c) => c.resize())); }
}
addEventListener('hashchange', () => show(location.hash.slice(1)));
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab'); if (b) show(b.dataset.page);
});

/* replay controls */
$('#scrub').addEventListener('input', (e) => { replayIdx = +e.target.value; paintReplay(); });
$('#playBtn').addEventListener('click', () => setPlaying(!playing));
$('#speedSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  speed = +b.dataset.s;
  document.querySelectorAll('#speedSeg button').forEach((x) => x.classList.toggle('on', x === b));
  if (playing) setPlaying(true);
});
$('#impactSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('#impactSeg button').forEach((x) => x.classList.toggle('on', x === b));
  // mockup: same data, different framing
});

/* fit to viewport without changing the 1360×735 layout */
function fit() {
  const s = Math.min(1, innerWidth / 1360, innerHeight / 735);
  $('#app').style.zoom = s;
}
addEventListener('resize', fit);
fit();
show(location.hash.slice(1) || 'live');
