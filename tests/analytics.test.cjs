'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const a=require('../lib/analytics.cjs');

test('Free-flow baseline needs repeated actual observations and congestion never uses a missing baseline',()=>{
 const ts='2026-10-03T00:00:00.000Z',rows=Array.from({length:12},(_,i)=>({id:'A',ts,speed:(i+1)*10,valid:true,hasVehicles:true}));
 const b=a.baselines(rows);assert.ok(Math.abs(b.get('A|8').speed-103.5)<1e-9);assert.equal(a.enrich([{id:'A',ts,speed:20},{id:'B',ts,speed:20}],b)[1].ci,null);
 assert.ok(Math.abs(a.enrich([{id:'A',ts,speed:20}],b)[0].ci-(1-20/103.5))<1e-5);assert.equal(a.baselines(rows.slice(0,3)).size,0);
});

test('PLAN-v4 free-flow references never share a detector baseline across HKT hours',()=>{
 const rows=[];for(let i=0;i<12;i++)for(const [hour,speed]of [[0,40],[1,100]])rows.push({id:'A',ts:`2026-10-03T0${hour}:00:00.000Z`,speed,valid:true,hasVehicles:true});
 const b=a.baselines(rows),r=a.enrich([{id:'A',ts:'2026-10-03T00:20:00.000Z',speed:20},{id:'A',ts:'2026-10-03T01:20:00.000Z',speed:20},{id:'A',ts:'2026-10-03T02:20:00.000Z',speed:20}],b);
 assert.equal(r[0].ci,.5);assert.equal(r[1].ci,.8);assert.equal(r[2].ci,null);assert.equal(b.has('A'),false);
});

test('Measured zero speeds remain in raw hourly P85; above-reference CI stays negative',()=>{
 const rows=Array.from({length:24},(_,i)=>({id:'A',ts:new Date(Date.UTC(2026,8,1+Math.floor(i/12),0,(i%12)*5)).toISOString(),speed:i<12?0:40+(i%12)*5,valid:true,hasVehicles:true}));
 const b=a.baselines(rows);assert.equal(b.get('A|8').n,24);assert.equal(b.get('A|8').speed,77.75);
 assert.equal(a.enrich([{id:'A',ts:rows[0].ts,speed:100}],b)[0].ci,1-100/77.75);
 assert.equal(a.baselines(rows.map(r=>({...r,speed:0}))).size,0);
});

// Inferential, CCF and forecast coverage lives in analysis/tests/test_original_methods.py.
// The earlier approximate JS methods were removed, not retained as fallbacks.
test('Quality heatmap preserves unobserved cells',()=>{
 const rows=[{ts:'2026-11-19T01:00:00Z',valid:true},{ts:'2026-11-19T01:01:00Z',valid:false}];
 const h=a.heatmap(rows,'2026-11-20T00:00:00Z');assert.equal(h.length,7);const day=h.find(d=>d.date==='2026-11-19');assert.equal(day.cells[9].share,0.5);assert.equal(day.cells[10].share,null);
});
