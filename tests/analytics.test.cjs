'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const a=require('../lib/analytics.cjs');

test('Free-flow baseline needs repeated actual observations and congestion never uses a missing baseline',()=>{
 const rows=Array.from({length:12},(_,i)=>({id:'A',speed:(i+1)*10,valid:true,hasVehicles:true}));
 const b=a.baselines(rows);assert.ok(Math.abs(b.get('A').speed-103.5)<1e-9);assert.equal(a.enrich([{id:'A',speed:20},{id:'B',speed:20}],b)[1].ci,null);
 assert.ok(Math.abs(a.enrich([{id:'A',speed:20}],b)[0].ci-(1-20/103.5))<1e-5);assert.equal(a.baselines(rows.slice(0,3)).size,0);
});

function regressionRows(){return Array.from({length:30*12},(_,i)=>{const detector=i%12,day=Math.floor(i/12),rain=(day%5===0||day%5===1)?0:((day+detector)%8+1);const hour=day%3*4+6;return {id:'D'+detector,d:'Sha Tin',ts:new Date(Date.UTC(2026,9,1+day,hour-8)).toISOString(),rainTs:new Date(Date.UTC(2026,9,1+day,hour-8)).toISOString(),rain,ratio:0.9-0.02*rain+hour*0.002};});}
test('Controlled rain model recovers effect with detector-cluster intervals and real wet/dry windows',()=>{
 const model=a.fitControlled(regressionRows());assert.ok(model);assert.ok(Math.abs(model.slope+0.02)<1e-6);assert.ok(model.lo<=model.slope&&model.hi>=model.slope);assert.equal(model.clusters,12);assert.ok(model.wetWindows>=3&&model.dryWindows>=3);
 assert.equal(a.fitControlled(regressionRows().map(r=>({...r,rain:0}))),null);
});

test('A peak dummy redundant with hour controls does not suppress an estimable rain interaction',()=>{
 const rows=[];for(let day=0;day<10;day++)for(const hour of [6,8])for(let id=0;id<6;id++){const rain=day%3===0?0:(day+id)%5+1;const peak=hour===8;const ts=new Date(Date.UTC(2026,9,5+day*7,hour-8)).toISOString();rows.push({id:'D'+id,d:'Sha Tin',ts,rainTs:ts,rain,ratio:.9-.02*rain-.02*rain*(+peak)+.01*(+peak)});}
 const m=a.fitControlled(rows,{interaction:true});assert.ok(m?.interaction);assert.ok(Math.abs(m.interaction.off+.02)<1e-6);assert.ok(Math.abs(m.interaction.peak+.04)<1e-6);
});

test('Lag associations cannot consume rainfall measured after the shifted road time',()=>{
 const t=Date.parse('2026-10-03T00:00:00Z');const roads=Array.from({length:24},(_,i)=>({id:'D'+i,d:'Sha Tin',ts:new Date(t+i*60000).toISOString(),ratio:1-i/100}));
 const result=a.lagAssociations(roads,[{d:'Sha Tin',ts:new Date(t+600000).toISOString(),mm:5}]);
 assert.equal(result.find(r=>r.minutes===30).n,0);assert.equal(result.find(r=>r.minutes===0).n,14);
});

function frames(){const t=Date.parse('2026-10-03T00:00:00Z');return Array.from({length:240},(_,i)=>({ts:new Date(t+i*300000).toISOString(),ci:0.35+0.12*Math.sin(i/12),occupancy:25+5*Math.sin(i/12),rain:i%48<24?0:2}));}
test('Forecast uses chronological labels before test features, reports persistence errors and preserves gaps',()=>{
 const result=a.forecast(frames());const m=result.models.find(m=>m.minutes===30);assert.ok(m&&m.available);assert.ok(m.trainedThrough<m.testFrom);assert.ok(m.nTest>=10);assert.ok(m.modelMAE>=0&&m.baselineMAE>=0);assert.ok(Number.isFinite(m.skill));
 const sparse=a.forecast(frames().filter((_,i)=>i%24===0));assert.ok(sparse.models.every(m=>!m.available));
});

test('Changing held-out future values does not change trained model coefficients',()=>{
 const f=frames(),cut=f[180].ts;const one=a.forecast(f,{cutTime:cut});const two=a.forecast(f.map((r,i)=>i>=180?{...r,ci:0.95}:r),{cutTime:cut});
 assert.deepEqual(one.models[0].coefficients,two.models[0].coefficients);assert.ok(one.models[0].available);
});

test('Forecast frame is dated when its latest measurement exists and rain waits for publication',()=>{
 const rows=[{id:'A',d:'Sha Tin',ts:'2026-10-03T05:04:30.000Z',ci:.2,speed:40,valid:true}],rain=[{d:'Sha Tin',ts:'2026-10-03T04:45:00.000Z',publishedAt:'2026-10-03T05:10:00.000Z',mm:7}];
 assert.equal(a.networkFrames(rows)[0].ts,rows[0].ts);assert.equal(typeof a.joinAvailableRain,'function');assert.equal(a.joinAvailableRain(rows,rain)[0].rain,null);
 assert.equal(a.joinAvailableRain([{...rows[0],ts:'2026-10-03T05:12:00.000Z'}],rain)[0].rain,7);
});

test('Quality heatmap preserves unobserved cells and loop counts actual records only',()=>{
 const rows=[{ts:'2026-11-19T01:00:00Z',valid:true},{ts:'2026-11-19T01:01:00Z',valid:false}];
 const h=a.heatmap(rows,'2026-11-20T00:00:00Z');assert.equal(h.length,7);const day=h.find(d=>d.date==='2026-11-19');assert.equal(day.cells[9].share,0.5);assert.equal(day.cells[10].share,null);
 assert.deepEqual(a.loopStats(4,[{verdict:'faster'},{verdict:'pending'}]),{alerts:4,decisions:2,evaluated:1,faster:1,pending:1});
});
