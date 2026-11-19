'use strict';
const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(v,n=1)=>v==null||!Number.isFinite(Number(v))?'—':Number(v).toFixed(n);
const time=v=>v?new Date(v).toLocaleTimeString('en-GB',{timeZone:'Asia/Hong_Kong',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const date=v=>v?new Date(v).toLocaleString('en-GB',{timeZone:'Asia/Hong_Kong',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'—';
const color=v=>v==null?'#536170':v<30?'#e0533f':v<60?'#e0a33e':'#45b98a';
const charts=new Map();let data=null,period='all',busy=false,queued=false,replaySeq=0,playTimer=null;
Chart.defaults.color='#9bacbf';Chart.defaults.font.family='Segoe UI,system-ui,sans-serif';Chart.defaults.font.size=10;Chart.defaults.plugins.legend.display=false;
const axis=(label)=>({grid:{color:'#1b2835'},title:{display:!!label,text:label,color:'#adbed1'},ticks:{maxTicksLimit:7},border:{display:false}});
function chart(id,type,datasets,labels,axes={}){
  charts.get(id)?.destroy();const c=new Chart(document.getElementById(id),{type,data:{labels,datasets},options:{responsive:true,maintainAspectRatio:false,animation:false,normalized:true,plugins:{legend:{display:datasets.length>1}},scales:{x:axis(),y:axis(),...axes}}});charts.set(id,c);
}
async function api(url,options){const r=await fetch(url,options);let value;try{value=await r.json();}catch{throw new Error('Dashboard returned an unreadable response');}if(!r.ok)throw new Error(value.error||`HTTP ${r.status}`);return value;}
function map(el,rows){
  if(!rows.length){el.innerHTML='<div class="empty">No stored road observations for this frame.</div>';return;}
  const xs=rows.map(r=>r.lon),ys=rows.map(r=>r.lat),minX=Math.min(...xs)-.025,maxX=Math.max(...xs)+.025,minY=Math.min(...ys)-.02,maxY=Math.max(...ys)+.02,W=1000,H=650;
  const px=x=>(x-minX)/(maxX-minX)*W,py=y=>(maxY-y)/(maxY-minY)*H;
  let svg=`<svg role="img" aria-label="Road observations in Hong Kong" viewBox="0 0 ${W} ${H}"><defs><clipPath id="clip-${el.id}"><rect width="1000" height="650"/></clipPath></defs><g clip-path="url(#clip-${el.id})">`;
  for(const d of window.GEOMETRY||[])for(const ring of d.rings)svg+=`<path class="dist${d.study?' study':''}" d="M${ring.map(([x,y])=>`${px(x).toFixed(1)},${py(y).toFixed(1)}`).join('L')}Z"/>`;
  for(const r of rows){const speed=r.valid&&r.hasVehicles?r.speed:null;svg+=`<circle class="det" cx="${px(r.lon)}" cy="${py(r.lat)}" r="${speed!=null&&speed<30?5:3.2}" fill="${color(speed)}"><title>${esc(r.road)} · ${esc(r.d)}\n${num(speed)} km/h · ${date(r.ts)} HKT</title></circle>`;}
  svg+='</g></svg><div class="legend">Measured speed · km/h<div class="bar"></div><div class="ends"><span>&lt;30</span><span>30–60</span><span>≥60</span></div><div>Grey = invalid / no vehicles</div></div>';el.innerHTML=svg;
}
function cameraHtml(c,at){const src=c.file+(at?`?at=${encodeURIComponent(at)}`:`?v=${encodeURIComponent(c.lastSuccess||'')}`),stale=!at&&!c.fresh;return `<div class="cam${stale?' stale':''}" title="${esc(c.name||c.id)} · captured ${date(c.lastSuccess)} HKT"><img src="${esc(src)}" alt="${esc(c.d)} traffic camera ${esc(c.id)}"><div class="failed">No captured image<br>for this time</div><span class="capture-age">${stale?'STALE · ':''}captured ${time(c.lastSuccess)} HKT</span><span class="cl"><b>${esc(c.id)}</b><span>${esc(c.d)}</span></span></div>`;}
function imageErrors(el){el.querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>img.closest('.cam').classList.add('error'),{once:true}));}
function renderLive(){
  map($('#mapLive'),data.detectors);$('#liveN').textContent=`${data.trust.valid}/${data.trust.total} valid detectors`;
  const roads=data.detectors.filter(r=>r.valid&&r.hasVehicles).sort((a,b)=>a.speed-b.speed);
  $('#rank').innerHTML=roads.slice(0,8).map((r,i)=>`<div class="rrow"><span class="rk">${i+1}</span><span class="rname" title="${esc(r.road)}">${esc(r.road)}<em>${esc(r.d)} · ${esc(r.id)} · ${time(r.ts)}</em></span><span class="rbar"><i style="width:${Math.min(100,r.speed)}%;background:${color(r.speed)}"></i></span><span class="rval" style="color:${color(r.speed)}">${num(r.speed)}</span></div>`).join('')||'<div class="empty">No valid observed roads yet.</div>';
  $('#rainstrip').innerHTML=data.rain.districts.map(r=>`<div class="rcell"><span class="rn">${esc(r.d)}</span><span class="rv">${num(r.mm)}<span>mm</span></span><small>as of ${time(r.ts)}</small></div>`).join('');
  $('#camwall').innerHTML=data.cameras.map(c=>cameraHtml(c)).join('')||'<div class="empty">No camera metadata available yet.</div>';imageErrors($('#camwall'));
  const slow=roads.filter(r=>r.speed<20),w=data.weather,temps=w?.temperature?.data||[],hko=temps.find(x=>x.place==='Hong Kong Observatory');
  $('#awareness').innerHTML=`<div class="metric"><small>Road periods below 20 km/h</small><strong>${slow.length}</strong><small>Latest frame · descriptive rule</small></div><p class="note">${slow.length?`Inspect ${esc(slow[0].road)} and its local camera before considering another route.`:'No measured road in this selection is below the descriptive alert threshold.'}</p><p class="note">HKO temperature: <b>${num(hko?.value)} °C</b><br>Weather updated ${date(w?.ts)} HKT</p><p class="note">A camera is visual context, not a measured queue length. Road speed does not estimate a whole journey.</p>`;
  const chosen=$('#road').value;$('#road').innerHTML=roads.map(r=>`<option value="${esc(r.id)}">${esc(r.d)} · ${esc(r.road)} (${num(r.speed)} km/h)</option>`).join('');if(roads.some(r=>r.id===chosen))$('#road').value=chosen;
}
function renderAnalysis(){
  const a=data.analysis;$('#pairedN').textContent=`${a.paired} paired · ${a.wet} wet / ${a.dry} dry`;$('#corr').textContent=`Pearson r = ${num(a.speedOccupancy,3)}`;
  const rainSets=[{label:'Observed periods',data:a.points,backgroundColor:'#5aa6e566',pointRadius:2}];if(a.rainFit){const x=Math.max(...a.points.map(p=>p.x));rainSets.push({type:'line',label:'Descriptive fit',data:[{x:0,y:a.rainFit.intercept},{x,y:a.rainFit.intercept+a.rainFit.slope*x}],borderColor:'#e0a33e',pointRadius:0});}
  chart('cScatter','scatter',rainSets,undefined,{x:{...axis('District maximum rainfall in past hour (mm)'),min:0},y:axis('Measured speed (km/h)')});
  chart('cSens','bar',[{data:a.districts.map(r=>r.speed),backgroundColor:a.districts.map(r=>color(r.speed)),borderRadius:4}],a.districts.map(r=>r.d),{y:{...axis('Mean speed (km/h)'),beginAtZero:true}});
  chart('cLag','scatter',[{data:a.occupancyPoints,backgroundColor:'#65b5cd66',pointRadius:2}],undefined,{x:axis('Mean lane occupancy (%)'),y:axis('Speed (km/h)')});
  chart('cPeak','bar',[{data:[a.peakSpeed,a.offPeakSpeed],backgroundColor:['#e0a33e','#4da3ff'],borderRadius:5}],['Weekday peak','Other hours'],{y:{...axis('Mean speed (km/h)'),beginAtZero:true}});
  $('#findings').innerHTML=a.findings.slice(0,2).map(f=>`<div class="metric"><small>${esc(f.title)}</small><strong>${esc(f.value)}</strong><small>${esc(f.detail)}</small></div>`).join('')+`<p class="note">${esc(a.rainMessage)}</p><p class="note">Join: same district, latest rainfall observation at or before the road period, at most 30 minutes old. District rain is not rainfall at that exact road. Repeated periods are not independent.</p>`;
}
function renderReplay(){
  const old=$('#scrub').value,wasLast=Number(old)>=Number($('#scrub').max);$('#scrub').max=Math.max(0,data.frames.length-1);$('#scrub').value=wasLast?$('#scrub').max:Math.min(old,$('#scrub').max);
  chart('cTimeline','scatter',[{label:'Stored mean speed',data:data.frames.map(f=>({x:Date.parse(f.ts),y:f.speed})),backgroundColor:'#4da3ff',pointRadius:3,showLine:false}],undefined,{x:{...axis('Actual observation time (HKT)'),type:'linear',ticks:{maxTicksLimit:5,callback:v=>date(v)}},y:axis('Mean speed (km/h)')});
  showReplay();
}
async function showReplay(){
  const frame=data?.frames[Number($('#scrub').value)],seq=++replaySeq;if(!frame)return;
  $('#rTime').textContent=date(frame.ts);$('#rClock').textContent=`${date(frame.ts)} HKT`;
  const prev=data.frames[Number($('#scrub').value)-1],gap=prev?(Date.parse(frame.ts)-Date.parse(prev.ts))/60000:null;
  $('#events').innerHTML=`<div class="metric"><small>Selected real observation</small><strong>${num(frame.speed)} km/h</strong><small>${frame.n} detector-periods · ${frame.valid} valid</small></div><p class="note">${esc(date(frame.ts))} HKT</p><p class="note">${gap!=null?`Gap from previous stored frame: ${num(gap,1)} minutes.`:'First stored frame in the current selection.'}</p><p class="note">Only captured frames can be replayed. Data between captures and historical camera images not collected at the time are unavailable.</p>`;
  try{const result=await api(`/api/replay?at=${encodeURIComponent(frame.ts)}&district=${encodeURIComponent($('#district').value)}`);if(seq!==replaySeq)return;map($('#mapReplay'),result.detectors);$('#camstrip').innerHTML=result.cameras.length?result.cameras.map(c=>cameraHtml(c,frame.ts)).join(''):'<div class="empty">No camera capture within 3 minutes before this road observation.</div>';imageErrors($('#camstrip'));}catch(e){if(seq===replaySeq)$('#mapReplay').innerHTML=`<div class="empty">${esc(e.message)}</div>`;}
}
const actions={observe:'Continue observing',delay20:'Consider delaying 20 min','switch-rail':'Consider rail'};
function renderLoop(){
  $('#funnel').innerHTML=`<div class="step"><b>1. Observe</b>${data.meta.records.toLocaleString()} stored traffic records + weather and cameras</div><div class="step"><b>2. Understand</b>${data.alerts.length} low-speed observations in this selection; inspect rain and imagery</div><div class="step"><b>3. Decide</b>Record a commute option using the form</div><div class="step"><b>4. Observe again</b>Compare actual road speed after 30 minutes</div><p class="note">This supports situational awareness. It does not measure travel-time savings or validate a forecast.</p>`;
  $('#decisionN').textContent=`Latest ${data.decisions.length} records · ${data.decisions.filter(r=>r.verdict==='pending').length} pending`;
  $('#decisionTable').innerHTML=data.decisions.map(r=>`<tr><td>${date(r.ts)}</td><td>${esc(r.road)}<br><span class="note">${esc(r.d)}</span></td><td>${esc(actions[r.action]||r.action)}</td><td>${num(r.initialSpeed)} km/h</td><td>${r.verdict==='pending'?`Pending · target ${time(r.outcomeAt)}`:`${num(r.outcomeSpeed)} km/h · ${esc(r.verdict)} (${num(r.delta)} km/h)`}</td></tr>`).join('')||'<tr><td colspan="5">No decisions have been recorded. Save a real observation above to begin.</td></tr>';
}
function renderTrust(){
  $('#feeds').innerHTML=data.health.map(h=>`<div class="feed"><strong>${esc(h.name)}</strong><span class="state ${h.ok&&h.fresh?'':'bad'}">${h.ok?(h.fresh?'FRESH':'SOURCE LAG / STALE'):'REQUEST FAILED'}</span><p class="note">Observed ${date(h.observedAt)} HKT<br>Last success ${time(h.lastSuccess)}${h.error?`<br>${esc(h.error)}`:''}</p></div>`).join('');
  chart('cValidity','scatter',[{data:data.frames.map(f=>({x:Date.parse(f.ts),y:f.n?100*f.valid/f.n:null})),backgroundColor:'#45b98a',pointRadius:3}],undefined,{x:{...axis('Stored observation time (HKT)'),type:'linear',ticks:{maxTicksLimit:5,callback:v=>date(v)}},y:{...axis('Valid detector share (%)'),min:0,max:100}});
  $('#noservice').innerHTML=data.cameras.map(c=>`<p class="note"><b>${esc(c.id)} · ${esc(c.d)}</b><br><span class="state ${c.ok?'':'bad'}">${c.ok?'JPEG retrieved':'Request unavailable'}</span> · ${time(c.lastSuccess)}${c.error?`<br>${esc(c.error)}`:''}</p>`).join('')+'<p class="note">A valid JPEG may contain a “No Service” notice. Image content is not automatically classified.</p>';
  $('#storage').innerHTML=`<div class="metric"><small>Stored traffic records</small><strong>${data.meta.records.toLocaleString()}</strong><small>${data.meta.locations} study detector locations</small></div><p class="note">${data.meta.stationRecords.toLocaleString()} station rainfall records. MongoDB and captured images use persistent Docker volumes.</p><p class="note">${esc(data.meta.analysisScope)}. Uncollected periods remain gaps. Missing values remain missing; zero rainfall remains zero.</p><p class="note">Analysis window: ${date(data.analysis.start)} → ${date(data.analysis.end)} HKT.</p>`;
  $('#provenance').innerHTML=data.sources.map(s=>`<p class="note"><a href="${esc(s.catalog)}" target="_blank" rel="noopener">${esc(s.name)}</a></p>`).join('')+'<p class="note">Department resource domains are linked from the DATA.GOV.HK catalog. Boundary geometry is reused from the teammate’s layout for map context only.</p>';
}
async function refresh(){
  if(busy){queued=true;return;}busy=true;$('#refresh').disabled=true;
  try{
    data=await api(`/api/dashboard?district=${encodeURIComponent($('#district').value)}&period=${period}`);
    renderLive();renderAnalysis();renderReplay();renderLoop();renderTrust();
    $('#clock').textContent=time(data.meta.latestTs);$('#scope').textContent=`${data.meta.records.toLocaleString()} stored records · ${data.analysis.n.toLocaleString()} analysed · latest ${date(data.meta.latestTs)}`;
    const traffic=data.health.find(h=>h.kind==='traffic'),lag=traffic&&!traffic.fresh;
    $('#connection').textContent=lag?'SOURCE LAG':'CONNECTED';$('#connection').classList.toggle('warn',!!lag);
    $('#notice').textContent=lag?`The collector is connected, but the TD observation timestamp is ${date(traffic.observedAt)} HKT. Stored data remain visible; see Data quality.`:'';$('#notice').classList.toggle('show',!!lag);
    $('#lastRefresh').textContent=`Page checked ${time(data.meta.generatedAt)} HKT · refresh 30 s`;
    requestAnimationFrame(()=>charts.forEach(c=>c.resize()));
  }catch(e){$('#connection').textContent='UNAVAILABLE';$('#connection').classList.add('warn');$('#notice').textContent=`Cannot refresh: ${e.message}. Any displayed observations are from the last successful request.`;$('#notice').classList.add('show');}
  finally{busy=false;$('#refresh').disabled=false;if(queued){queued=false;refresh();}}
}
document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===`p-${b.dataset.page}`));requestAnimationFrame(()=>charts.forEach(c=>c.resize()));}));
$('#district').addEventListener('change',refresh);$('#refresh').addEventListener('click',refresh);
$('#impactSeg').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;period=b.dataset.d;$('#impactSeg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));refresh();});
$('#scrub').addEventListener('input',showReplay);
$('#playBtn').addEventListener('click',()=>{if(playTimer){clearInterval(playTimer);playTimer=null;$('#playBtn').textContent='Play';return;}$('#playBtn').textContent='Pause';playTimer=setInterval(()=>{const next=Number($('#scrub').value)+1;if(next>Number($('#scrub').max)){$('#playBtn').click();return;}$('#scrub').value=next;showReplay();},1500);});
$('#decisionForm').addEventListener('submit',async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{await api('/api/decisions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({detectorId:$('#road').value,action:$('#action').value})});$('#decisionStatus').textContent='Saved. The measured road speed will be checked at +30 minutes when a corresponding observation is available.';await refresh();}catch(e){$('#decisionStatus').textContent=e.message;}finally{button.disabled=false;}});
refresh();setInterval(refresh,30000);
