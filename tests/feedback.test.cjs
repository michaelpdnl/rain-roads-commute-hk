'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const f=require('../lib/feedback.cjs');
const T='2026-11-20T00:00:00.000Z';
const at=minutes=>new Date(Date.parse(T)+minutes*60000).toISOString();
const road={id:'D1',d:'Sha Tin',road:'Tolo Highway',ts:T,ci:0.7,speed:18,valid:true,hasVehicles:true};
const obs=(minutes,ci,extra={})=>({...road,ts:at(minutes),ci,...extra});
const alert=(extra={},options={})=>f.createAlert({...road,...extra},{threshold:0.6,rain:2,now:T,...options});
const decision=(a=alert(),extra={},options={})=>f.createDecision(a,{alertId:a.id,actor:'commuter',action:'leave-now',...extra},{now:T,observation:road,...options});

test('original alert rule requires CI above P90 with reported rain, never speed alone',()=>{
 assert.equal(f.createAlert({...road,ci:0.6,speed:5},{threshold:0.6,rain:2,now:T}),null);
 assert.equal(f.createAlert({...road,speed:5},{threshold:0.6,rain:0,now:T}),null);
 assert.equal(f.createAlert(road,{threshold:null,rain:2,now:T}),null);
 assert.equal(f.createAlert(road,{threshold:0.6,rain:null,now:T}),null);
 assert.equal(f.createAlert({...road,valid:false},{threshold:0.6,rain:2,now:T}),null);
 assert.equal(alert().rule,'rain-ci-p90');
});

test('30-minute detector outlook may cross threshold while dry; network forecasts never stand in',()=>{
 const forecast={detectorId:'D1',minutes:30,ci:0.8,baselineCI:0.2,predictedAt:at(30)};
 const a=alert({ci:0.2},{rain:0,forecast});
 assert.equal(a.rule,'outlook30-crossing');
 assert.equal(a.forecastCI,0.8);assert.equal(a.baselineCI,0.2);
 assert.equal(alert({ci:0.7},{rain:0,forecast}),null);
 assert.equal(alert({ci:0.2},{rain:0,forecast:{...forecast,minutes:60}}),null);
 assert.equal(alert({ci:0.2},{rain:0,forecast:{...forecast,detectorId:'D2'}}),null);
 assert.equal(alert({ci:0.2},{rain:0,forecast:{...forecast,detectorId:null,scope:'network'}}),null);
 assert.equal(alert({ci:0.2},{rain:0,forecast:{...forecast,predictedAt:at(60)}}),null);
});

test('alert snapshots are immutable; source detector/window deduplicates and expiry uses creation time',()=>{
 const input={...road},options={threshold:0.6,rain:2,now:at(7)},before=JSON.stringify({input,options});
 const a=f.createAlert(input,options),again=f.createAlert({...road,ts:at(5),ci:0.8},{...options,now:at(8)});
 assert.equal(a.id,again.id);assert.notEqual(a.id,alert({ts:at(30)},{now:at(30)}).id);
 assert.equal(a.detectorId,'D1');assert.equal(a.ts,T);assert.equal(a.createdAt,at(7));assert.equal(a.expiresAt,at(37));
 assert.equal(a.baselineCI,0.7);assert.equal(a.forecastCI,null);assert.ok(a.missingReasons.forecastCI);
 assert.equal(Object.isFrozen(a),true);assert.equal(JSON.stringify({input,options}),before);
 assert.throws(()=>{a.ci=0.1;},TypeError);
 assert.equal(f.alertState(a,[],{now:at(36)}),'active');
 assert.equal(f.alertState(a,[],{now:at(37)}),'expired');
});

test('only original actor/action pairs are valid, including explicit simulated dispatch',()=>{
 const allowed={commuter:['leave-now','delay20','switch-rail'],operator:['acknowledge','dispatch-simulated'],planner:['flag-review']};
 for(const [actor,actions] of Object.entries(allowed))for(const action of actions)assert.equal(f.validateAction(actor,action),true);
 for(const [actor,action] of [['commuter','observe'],['operator','dispatch'],['operator','consider-relief-bus'],['planner','leave-now'],['unknown','leave-now']])assert.equal(f.validateAction(actor,action),false);
});

test('decision links a live alert and snapshots actual CI at decision plus original baseline/forecast',()=>{
 const a=alert({ci:0.2},{forecast:{detectorId:'D1',minutes:30,ci:0.8,predictedAt:at(30)}});
 const d=decision(a,{action:'delay20',initialCI:0.99},{now:at(5),observation:obs(4,0.3)});
 assert.equal(d.alertId,a.id);assert.equal(d.initialCI,0.3);assert.equal(d.ciAtDecision,0.3);assert.equal(d.alertCI,0.2);
 assert.equal(d.baselineCI,0.2);assert.equal(d.forecastCI,0.8);assert.equal(d.observedAt,at(4));
 assert.equal(d.simulated,true);assert.equal(d.actualDispatch,false);assert.equal(d.observationKind,'actual');
 assert.equal(d.outcomes[0].targetAt,at(35));assert.equal(d.outcomes[1].targetAt,at(65));assert.equal(d.verdict,'pending');
 assert.equal(f.alertState(a,[d],{now:at(100)}),'decided');
 assert.equal(f.alertState(a,[{...d,alertId:'other'}],{now:at(100)}),'expired');
});

test('decision refuses invalid associations, expired alerts, invalid actions and stale/other-road CI',()=>{
 const a=alert();
 assert.throws(()=>decision(a,{alertId:'wrong'}),/alert/i);
 assert.throws(()=>decision(a,{actor:'operator',action:'dispatch'}),/actor|action/i);
 assert.throws(()=>decision(a,{}, {now:at(30),observation:obs(30,0.4)}),/expired/i);
 assert.throws(()=>decision(a,{}, {now:at(11),observation:road}),/recent|stale/i);
 assert.throws(()=>decision(a,{}, {observation:{...road,id:'D2'}}),/observation|road|detector/i);
 assert.throws(()=>decision(a,{}, {observation:{...road,ci:null}}),/observation|CI/i);
 assert.throws(()=>decision(a,{}, {observation:{...road,valid:false}}),/observation/i);
 assert.throws(()=>f.createDecision(a,{alertId:a.id,actor:'commuter',action:'leave-now'},{now:T}),/observation/i);
});

test('30 and 60 minute outcomes use actual CI and compare independently with initial, baseline and matching forecast',()=>{
 const a=alert({ci:0.2},{forecast:{detectorId:'D1',minutes:30,ci:0.8,predictedAt:at(30)}});
 const d=decision(a,{}, {now:at(1),observation:obs(1,0.4)});
 const result=f.evaluateDecision(d,[obs(31,0.3,{speed:1}),obs(61,0.5,{speed:100})],{now:at(71)});
 assert.equal(result.outcomes[0].realizedCI,0.3);assert.equal(result.outcomes[0].verdict,'improved');
 assert.equal(result.outcomes[0].delta,-0.1);assert.equal(result.outcomes[0].deltaBaseline,0.1);assert.equal(result.outcomes[0].deltaForecast,-0.5);
 assert.equal(result.outcomes[1].realizedCI,0.5);assert.equal(result.outcomes[1].verdict,'worse');assert.equal(result.outcomes[1].delta,0.1);
 assert.equal(result.outcomes[1].deltaForecast,null);assert.ok(result.outcomes[1].missingReasons.forecastCI);
 assert.equal(result.verdict,'worse');assert.equal(result.status,'complete');assert.equal(result.outcomeKind,'actual');
 assert.equal(result.causalEffect,null);assert.equal(d.verdict,'pending');
});

test('outcomes select first valid same-road observation on/after target within ten minutes',()=>{
 const d=decision(),rows=[obs(29,0.1),obs(30,0.1,{valid:false}),obs(30,0.1,{id:'D2'}),obs(30,0.1,{road:'Other road'}),obs(30,0.1,{hasVehicles:false}),obs(31,0.7),obs(32,0.2),obs(71,0.4)];
 const before=JSON.stringify(rows),r=f.evaluateDecision(d,rows,{now:at(80)});
 assert.equal(r.outcomes[0].observedAt,at(31));assert.equal(r.outcomes[0].verdict,'unchanged');
 assert.equal(r.outcomes[1].status,'missing');assert.equal(r.outcomes[1].realizedCI,null);
 assert.equal(r.verdict,'missing');assert.equal(JSON.stringify(rows),before);
});

test('missing future data stays pending until the window closes then missing, and late real backfill can resolve it',()=>{
 const d=decision();
 const pending=f.evaluateDecision(d,[obs(30,0.1)],{now:at(29)});
 assert.equal(pending.outcomes[0].status,'pending');assert.equal(pending.outcomes[0].realizedCI,null);
 const missing=f.evaluateDecision(d,[],{now:at(80)});
 assert.deepEqual(missing.outcomes.map(x=>x.status),['missing','missing']);assert.equal(missing.verdict,'missing');
 assert.equal(missing.delta,null);assert.equal(missing.causalEffect,null);
 const late=f.evaluateDecision(missing,[obs(35,0.6),obs(65,0.5)],{now:at(90)});
 assert.deepEqual(late.outcomes.map(x=>x.status),['evaluated','evaluated']);
 const preserved=f.evaluateDecision(late,[],{now:at(100)});assert.deepEqual(preserved.outcomes,late.outcomes);
});

test('alert evaluation only gives lead time from an actual later crossing and censors unobserved alerts',()=>{
 const a=alert({ci:0.2},{rain:0,forecast:{detectorId:'D1',minutes:30,ci:0.8,predictedAt:at(30)}});
 const hit=f.evaluateAlert(a,[obs(10,0.4),obs(20,0.7)],{now:at(50)});
 assert.equal(hit.label,'hit');assert.equal(hit.leadMinutes,20);assert.equal(hit.observedAt,at(20));
 assert.equal(f.evaluateAlert(a,[],{now:at(50)}).status,'missing');
 assert.equal(f.evaluateAlert(a,[obs(10,0.4)],{now:at(50)}).status,'missing');
 assert.equal(f.evaluateAlert(a,[obs(30,0.4)],{now:at(35)}).status,'pending');
 const falseAlarm=f.evaluateAlert(a,[obs(30,0.4)],{now:at(41)});
 assert.equal(falseAlarm.label,'false-alarm');assert.equal(falseAlarm.leadMinutes,null);
 const observed=f.evaluateAlert(alert(),[],{now:at(50)});assert.equal(observed.label,'hit');assert.equal(observed.leadMinutes,null);
});

test('summary metrics declare labeled denominators, expiry, horizon deltas and simulated/actual evidence',()=>{
 const a=alert(),outlook=alert({id:'D2',ci:0.2},{rain:0,forecast:{detectorId:'D2',minutes:30,ci:0.8,predictedAt:at(30)}}),missing=alert({id:'D3',ci:0.2},{rain:0,forecast:{detectorId:'D3',minutes:30,ci:0.8,predictedAt:at(30)}});
 const d=f.evaluateDecision(decision(a),[obs(30,0.5),obs(60,0.6)],{now:at(80)});
 const rows=[{...a,evaluation:f.evaluateAlert(a,[],{now:at(80)})},{...outlook,evaluation:f.evaluateAlert(outlook,[obs(30,0.4,{id:'D2'})],{now:at(80)})},missing];
 const s=f.summarize(rows,[d],{now:at(80)});
 assert.equal(s.alerts,3);assert.equal(s.decidedAlerts,1);assert.equal(s.expiredAlerts,2);assert.equal(s.activeAlerts,0);
 assert.equal(s.labeledAlerts,2);assert.equal(s.censoredAlerts,1);assert.equal(s.hitRate,0.5);assert.equal(s.falseAlarmRate,0.5);
 assert.equal(s.denominators.hitRate,2);assert.equal(s.denominators.falseAlarmRate,2);assert.equal(s.leadTimeMinutes,null);assert.equal(s.denominators.leadTimeMinutes,0);
 assert.equal(s.outcomesByHorizon[30].outcomeDelta,-0.2);assert.equal(s.outcomesByHorizon[60].outcomeDelta,-0.1);
 assert.equal(s.simulatedDecisions,1);assert.equal(s.actualObservationOutcomes,2);assert.equal(s.evaluated,1);
 assert.deepEqual(s.horizons,[30,60]);assert.equal(s.falseAlarmDefinition,'false-alarm alerts / labeled alerts');
 const empty=f.summarize([],[],{now:T});assert.equal(empty.hitRate,null);assert.equal(empty.falseAlarmRate,null);assert.equal(empty.outcomeDelta,null);
});

test('summary refuses unassociated decisions and fabricated labels without actual source evidence',()=>{
 const a=alert({ci:0.2},{rain:0,forecast:{detectorId:'D1',minutes:30,ci:0.8,predictedAt:at(30)}});
 const s=f.summarize([{...a,evaluation:{status:'evaluated',label:'hit',leadMinutes:10}}],[{...decision(alert()),alertId:'other'}],{now:at(80)});
 assert.equal(s.labeledAlerts,0);assert.equal(s.decidedAlerts,0);assert.equal(s.orphanDecisions,1);assert.equal(s.hitRate,null);
});

test('a delayed decision never compares its later outcome to an expired 30-minute forecast target',()=>{
 const a=alert({ci:0.2},{forecast:{detectorId:'D1',minutes:30,ci:0.8,predictedAt:at(30)}});
 const d=decision(a,{}, {now:at(20),observation:obs(20,0.4)});
 const result=f.evaluateDecision(d,[obs(50,0.3),obs(80,0.2)],{now:at(90)});
 assert.equal(result.forecastCI,0.8);assert.equal(result.outcomes[0].deltaForecast,null);
 assert.equal(result.outcomes[0].missingReasons.forecastCI.code,'forecast_target_mismatch');
 assert.equal(result.outcomes[0].deltaBaseline,0.1);
});

test('a stored outcome without actual bounded source evidence cannot create a measured benefit',()=>{
 const a=alert(),d=decision(a),forged={...d,outcomes:d.outcomes.map(outcome=>({...outcome,status:'evaluated',evidenceKind:'actual',realizedCI:0,delta:-0.7,verdict:'improved'})),verdict:'improved'};
 const result=f.evaluateDecision(forged,[],{now:at(80)});
 assert.equal(result.verdict,'missing');
 const s=f.summarize([a],[forged],{now:at(80)});
 assert.equal(s.evaluated,0);assert.equal(s.outcomeDelta,null);assert.equal(s.actualObservationOutcomes,0);assert.equal(s.improved,0);
});
