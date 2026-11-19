'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const base=process.env.DASHBOARD_URL||'http://127.0.0.1:1881';
(async()=>{
 const json=async(route,options)=>{const r=await fetch(base+route,options);return {status:r.status,data:await r.json()};};
 const root=await fetch(base+'/');assert.equal(root.status,200);assert.match(await root.text(),/Rain, Roads/);
 const flow=await json('/red/flows');assert.equal(flow.status,200);const expected=JSON.parse(fs.readFileSync('flows.json','utf8'));assert.deepEqual(flow.data,expected);
 const {data:s,status}=await json('/api/dashboard');assert.equal(status,200);assert.ok(s.meta.records>0);assert.ok(s.analysis.n>0);assert.ok(s.detectors.length>0);assert.equal(s.cameras.length,6);
 const images=[];for(const c of s.cameras){const r=await fetch(base+c.file),body=new Uint8Array(await r.arrayBuffer());assert.equal(r.status,200);assert.equal(body[0],255);assert.equal(body[1],216);images.push({id:c.id,bytes:body.length,capturedAt:r.headers.get('x-captured-at'),fresh:c.fresh});}
 const filtered=await json('/api/dashboard?district=Sha%20Tin');assert.equal(filtered.status,200);assert.ok(filtered.data.detectors.length>0);assert.ok(filtered.data.detectors.every(r=>r.d==='Sha Tin'));assert.ok(filtered.data.cameras.every(r=>r.d==='Sha Tin'));
 const selected=s.frames[0];const replay=await json('/api/replay?at='+encodeURIComponent(selected.ts));assert.equal(replay.status,200);assert.ok(replay.data.detectors.length>0);assert.ok(replay.data.detectors.every(r=>r.ts===selected.ts));
 assert.equal((await json('/api/dashboard?district=unknown')).status,400);assert.equal((await json('/api/dashboard?period=unknown')).status,400);
 assert.equal((await json('/api/decisions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'invalid',detectorId:'invalid'})})).status,400);
 const result={checkedAt:new Date().toISOString(),base,checks:['root','deployed flow matches export','computed real data','six JPEGs','district filter','exact stored replay','invalid queries rejected','invalid decision rejected'],nodeRedNodes:flow.data.length,meta:s.meta,analysis:{n:s.analysis.n,paired:s.analysis.paired,wet:s.analysis.wet,dry:s.analysis.dry},images};
 console.log(JSON.stringify(result,null,2));
 if(process.env.VERIFICATION_OUTPUT)fs.writeFileSync(process.env.VERIFICATION_OUTPUT,JSON.stringify(result,null,2));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
