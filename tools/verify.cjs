'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const base=process.env.DASHBOARD_URL||'http://127.0.0.1:1881';
(async()=>{
 const json=async(route,options)=>{const r=await fetch(base+route,options);return {status:r.status,data:await r.json()};};
 const root=await fetch(base+'/');assert.equal(root.status,200);assert.match(await root.text(),/Rain, Roads/);
 const flow=await json('/red/flows');assert.equal(flow.status,200);const expected=JSON.parse(fs.readFileSync('flows.json','utf8'));assert.deepEqual(flow.data,expected);
 const {data:s,status}=await json('/api/dashboard');assert.equal(status,200);assert.ok(s.meta.records>0);assert.ok(s.analysis.n>0);assert.ok(s.detectors.length>0);assert.equal(s.cameras.length,6);
 assert.ok(s.research.baseline.detectors>0);assert.equal(s.research.heatmap.length,7);assert.equal(s.research.forecast.models.length,3);assert.ok(Number.isFinite(s.loop.alerts));
 assert.equal(s.research.methods.available,true,'Original worker must execute; an unavailable service is not a completed analysis');
 assert.match(s.research.methods.reference,/PLAN-v4/);assert.equal(s.cameraContent.available,false);
 assert.ok(Math.abs(Date.parse(s.research.forecast.latestTs)-Date.parse(s.meta.latestTs))<=300000,'Outlook source clock must use current selected observations');
 for(const m of s.research.forecast.models){
  if(!m.available){assert.ok(m.reason);continue;}
  assert.equal(m.folds.length,3);assert.equal(m.successfulFolds,3);assert.ok(m.modelMAE>=0&&m.baselineMAE>=0);
  for(const f of m.folds){assert.equal(f.available,true);assert.ok(f.trainTargetThrough<f.testFrom);assert.ok(f.referenceThrough<f.testFrom);assert.ok(f.nTrain>=30&&f.nTest>=10);}
 }
 if(s.research.impact.model){const b=s.research.impact.model.bootstrap;assert.equal(b.requested,2000);assert.equal(b.attempted,2000);assert.equal(b.converged+b.failed,2000);}
 if(!s.research.impact.lagAvailable){assert.ok(s.research.impact.lagReason);assert.ok(s.research.impact.lag.every(p=>p.r===null));}
 const images=[];for(const c of s.cameras){const r=await fetch(base+c.file),body=new Uint8Array(await r.arrayBuffer());assert.equal(r.status,200);assert.equal(body[0],255);assert.equal(body[1],216);images.push({id:c.id,bytes:body.length,capturedAt:r.headers.get('x-captured-at'),fresh:c.fresh});}
 const filtered=await json('/api/dashboard?district=Sha%20Tin');assert.equal(filtered.status,200);assert.ok(filtered.data.detectors.length>0);assert.ok(filtered.data.detectors.every(r=>r.d==='Sha Tin'));assert.ok(filtered.data.cameras.every(r=>r.d==='Sha Tin'));
 for(const i of [...new Set([0,Math.min(100,s.frames.length-1),s.frames.length-1])]){const selected=s.frames[i],replay=await json('/api/replay?at='+encodeURIComponent(selected.ts));assert.equal(replay.status,200);assert.equal(replay.data.detectors.length,selected.n);assert.ok(replay.data.detectors.every(r=>r.ts===selected.ts));assert.ok(selected.ci==null&&replay.data.ci==null||Math.abs(replay.data.ci-selected.ci)<1e-10,'Replay timeline and map must have identical exact-frame CI');}
 assert.equal((await json('/api/dashboard?district=unknown')).status,400);assert.equal((await json('/api/dashboard?period=unknown')).status,400);
 assert.equal((await json('/api/decisions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'invalid',detectorId:'invalid'})})).status,400);
 const result={checkedAt:new Date().toISOString(),base,checks:['root','deployed flow matches export','original Python worker executed','2000 actual bootstrap draws','three purged chronological folds or explicit unavailable reason','original CCF or explicit unavailable reason','No Service not substituted','six JPEGs','district filter','exact stored replay','invalid queries rejected','invalid decision rejected','hourly research baselines','seven-day heatmap','actual CI loop counts'],nodeRedNodes:flow.data.length,meta:s.meta,analysis:{n:s.analysis.n,paired:s.analysis.paired,wet:s.analysis.wet,dry:s.analysis.dry},research:{source:s.research.source,methods:s.research.methods,n:s.research.impact.n,wet:s.research.impact.wet,dry:s.research.impact.dry,model:s.research.impact.model,forecast:s.research.forecast.models.map(({evaluated,coefficients,...m})=>m)},loop:s.loop,images};
 console.log(JSON.stringify(result,null,2));
 if(process.env.VERIFICATION_OUTPUT)fs.writeFileSync(process.env.VERIFICATION_OUTPUT,JSON.stringify(result,null,2));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
