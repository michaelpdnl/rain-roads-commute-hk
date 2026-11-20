'use strict';

// PLAN-v4 §10. These timing choices are explicit policy; they are not learned
// statistics. Source timestamps, never fetch timestamps, determine observations.
const MINUTE=60000;
const actions={commuter:['leave-now','delay20','switch-rail'],operator:['acknowledge','dispatch-simulated'],planner:['flag-review']};
const horizons=[30,60];
const finite=Number.isFinite;
const millis=value=>typeof value==='number'?value:Date.parse(value);
const iso=value=>new Date(value).toISOString();
const round=value=>finite(value)?Number(value.toFixed(12)):null;
const mean=values=>values.length?round(values.reduce((sum,value)=>sum+value,0)/values.length):null;
function deepFreeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;}
const immutable=value=>deepFreeze(structuredClone(value));
const contract=immutable({
 actions,horizons,alertWindowMinutes:30,alertExpiryMinutes:30,outcomeToleranceMinutes:10,decisionObservationMaxAgeMinutes:10,
 outcomeWindow:'[decision timestamp + horizon, target + 10 minutes]',unchangedCITolerance:0,
 baseline:'Persistence CI at alert source time; frozen with the episode',
 forecast:'Only a matching detector 30-minute outlook; unavailable predictions remain null',
 actors:'simulated',observations:'actual',
 hitRateDefinition:'hit alerts / labeled alerts; non-alert misses are unavailable and are not invented',
 hitDefinition:'An observed alert already above its threshold, or a later actual threshold exceedance in the 30-minute outlook window',
 falseAlarmDefinition:'false-alarm alerts / labeled alerts',
 falseAlarmEvidence:'After the 30-minute outlook window closes, at least one valid target-window observation and no observed exceedance; gaps are not interpolated',
 leadTimeDefinition:'Minutes from alert source time to first observed later threshold exceedance; only initially-below-threshold alerts are eligible',
 outcomeDeltaDefinition:'realized CI minus initial CI; negative means improved; descriptive change, not causal benefit',
 outcomeDeltaAggregation:'Mean of measured decision-horizon deltas; 30- and 60-minute results are also reported separately',
 evaluatedDefinition:'Decisions with actual source evidence at both 30 and 60 minutes'
});

function nowMillis(now){const value=millis(now??Date.now());if(!finite(value))throw new Error('A valid current timestamp is required');return value;}
const detectorId=row=>row?.detectorId??row?.id;
function validObservation(row,owner){
 return !!row&&row.valid===true&&row.hasVehicles!==false&&finite(row.ci)&&finite(millis(row.ts))&&
  detectorId(row)===owner.detectorId&&row.road===owner.road&&row.d===owner.d;
}
function validAlert(alert){
 return !!alert&&typeof alert.id==='string'&&!!alert.id&&!!alert.detectorId&&!!alert.d&&!!alert.road&&
  finite(alert.ci)&&finite(alert.baselineCI)&&finite(alert.threshold)&&finite(millis(alert.ts))&&
  finite(millis(alert.createdAt))&&millis(alert.expiresAt)>millis(alert.createdAt)&&
  ['rain-ci-p90','outlook30-crossing'].includes(alert.rule);
}
function validateAction(actor,action){return Object.hasOwn(actions,actor)&&actions[actor].includes(action);}
function matchingForecast(row,forecast){
 if(!forecast||forecast.detectorId!==detectorId(row)||forecast.minutes!==30||!finite(forecast.ci))return null;
 if(forecast.scope&&forecast.scope!=='detector')return null;
 if(forecast.sourceAt&&millis(forecast.sourceAt)!==millis(row.ts))return null;
 if(forecast.predictedAt&&millis(forecast.predictedAt)!==millis(row.ts)+30*MINUTE)return null;
 return forecast;
}

function createAlert(row,{threshold,rain,forecast=null,now}={}){
 const created=nowMillis(now),source=millis(row?.ts),detector=detectorId(row);
 if(!row||!detector||!row.d||!row.road||row.valid!==true||row.hasVehicles===false||!finite(row.ci)||!finite(source)||source>created||!finite(threshold))return null;
 const outlook=matchingForecast(row,forecast);
 const wet=row.ci>threshold&&finite(rain)&&rain>0;
 const crossing=row.ci<=threshold&&outlook&&outlook.ci>threshold;
 if(!wet&&!crossing)return null;
 const sourceKey=`${encodeURIComponent(detector)}|${Math.floor(source/(30*MINUTE))}`;
 const id=`alert|${sourceKey}`;
 return immutable({
  id,_id:id,sourceKey,detectorId:detector,d:row.d,road:row.road,ts:iso(source),createdAt:iso(created),expiresAt:iso(created+30*MINUTE),
  ci:row.ci,baselineCI:finite(outlook?.baselineCI)?outlook.baselineCI:row.ci,baselineKind:'persistence',
  forecastCI:outlook?.ci??null,forecastMinutes:30,forecastAt:outlook?iso(source+30*MINUTE):null,
  threshold,thresholdKind:'district-HKT-hour-P90',thresholdHour:new Date(source+8*60*MINUTE).getUTCHours(),
  rain:finite(rain)?rain:null,speed:finite(row.speed)?row.speed:null,valid:true,
  rule:wet?'rain-ci-p90':'outlook30-crossing',severity:wet?'warning':'advisory',status:'active',
  missingReasons:{...(outlook?{}:{forecastCI:{code:'detector_outlook_unavailable',message:'A valid matching detector 30-minute outlook is unavailable; network outlooks are not substituted.'}})},
  observationKind:'actual',actorKind:'simulated'
 });
}

function associatedDecision(alert,decision){
 return validAlert(alert)&&decision?.alertId===alert.id&&decision.detectorId===alert.detectorId&&decision.road===alert.road&&decision.d===alert.d&&
  validateAction(decision.actor,decision.action)&&finite(decision.initialCI)&&decision.observationKind==='actual'&&
  millis(decision.ts)>=millis(alert.createdAt)&&millis(decision.ts)<millis(alert.expiresAt);
}
function alertState(alert,decisions=[],{now}={}){
 const current=nowMillis(now);
 if(!validAlert(alert))return 'legacy';
 if(decisions.some(decision=>associatedDecision(alert,decision)))return 'decided';
 return current>=millis(alert.expiresAt)?'expired':'active';
}

function pendingOutcome(ts,minutes,forecastCI){
 const target=millis(ts)+minutes*MINUTE;
 return {minutes,targetAt:iso(target),windowEnd:iso(target+10*MINUTE),status:'pending',verdict:'pending',
  observedAt:null,realizedCI:null,delta:null,deltaBaseline:null,deltaForecast:null,forecastCI,
  evidenceKind:null,missingReasons:{...(!finite(forecastCI)?{forecastCI:{code:'horizon_forecast_unavailable',message:`No frozen ${minutes}-minute detector forecast is available.`}}:{})}};
}
function createDecision(alert,body,{now,observation}={}){
 const current=nowMillis(now);
 if(!validAlert(alert)||body?.alertId!==alert.id)throw new Error('Choose a valid associated alertId');
 if(current<millis(alert.createdAt)||current>=millis(alert.expiresAt))throw new Error('The alert is expired or not yet created');
 if(!validateAction(body.actor,body.action))throw new Error('Choose a valid actor and original action');
 const observed=millis(observation?.ts);
 if(!validObservation(observation,alert)||observed>current||observed<millis(alert.ts)||current-observed>10*MINUTE)throw new Error('A recent valid same-road detector observation with CI is required');
 const ts=iso(current),id=`decision|${alert.id}|${ts}|${body.actor}|${body.action}`;
 const outcomes=horizons.map(minutes=>pendingOutcome(ts,minutes,minutes===30?alert.forecastCI:null));
 return immutable({id,_id:id,alertId:alert.id,detectorId:alert.detectorId,d:alert.d,road:alert.road,ts,
  actor:body.actor,action:body.action,simulated:true,actualDispatch:false,kind:'simulated actor; observed CI change is not causal benefit',
  initialCI:observation.ci,ciAtDecision:observation.ci,alertCI:alert.ci,baselineCI:alert.baselineCI,forecastCI:alert.forecastCI,
  forecastMinutes:30,forecastAt:alert.forecastAt,threshold:alert.threshold,observedAt:iso(observed),
  initialSpeed:finite(observation.speed)?observation.speed:null,observationKind:'actual',outcomeKind:null,causalEffect:null,
  outcomes,status:'pending',verdict:'pending',outcomeAt:outcomes[0].targetAt,nextOutcomeAt:outcomes[0].targetAt,
  delta:null,deltaBaseline:null,deltaForecast:null,missingReasons:alert.missingReasons
 });
}

function evaluateDecision(decision,observations=[],{now}={}){
 const current=nowMillis(now),ts=millis(decision?.ts);
 if(!decision?.alertId||!finite(ts)||!finite(decision.initialCI))throw new Error('A valid alert-linked CI decision is required');
 const retained=(decision.outcomes??[]).map(outcome=>outcome.evidence).filter(evidence=>evidence?.kind==='actual');
 const candidates=[...observations,...retained].filter(row=>validObservation(row,decision)&&millis(row.ts)<=current).sort((a,b)=>millis(a.ts)-millis(b.ts));
 const outcomes=horizons.map(minutes=>{
  const outcome=pendingOutcome(decision.ts,minutes,minutes===30?decision.forecastCI:null),target=millis(outcome.targetAt),end=millis(outcome.windowEnd);
  const row=candidates.find(row=>millis(row.ts)>=target&&millis(row.ts)<=end);
  if(row){
   const delta=round(row.ci-decision.initialCI);
   const forecastTime=millis(decision.forecastAt),forecastAligned=finite(outcome.forecastCI)&&finite(forecastTime)&&millis(row.ts)>=forecastTime&&millis(row.ts)<=forecastTime+10*MINUTE;
   return {...outcome,status:'evaluated',verdict:row.ci<decision.initialCI?'improved':row.ci>decision.initialCI?'worse':'unchanged',
    observedAt:iso(millis(row.ts)),realizedCI:row.ci,delta,deltaBaseline:finite(decision.baselineCI)?round(row.ci-decision.baselineCI):null,
    deltaForecast:forecastAligned?round(row.ci-outcome.forecastCI):null,evidenceKind:'actual',evidence:actualEvidence(decision,row),
    missingReasons:{...outcome.missingReasons,...(finite(outcome.forecastCI)&&!forecastAligned?{forecastCI:{code:'forecast_target_mismatch',message:'The frozen forecast target does not match this outcome source-time window.'}}:{})}};
  }
  if(current>end)return {...outcome,status:'missing',verdict:'missing',missingReasons:{...outcome.missingReasons,observation:{code:'future_observation_missing',message:'No valid same-road source observation in the bounded target window.'}}};
  return outcome;
 });
 const complete=outcomes.every(outcome=>outcome.status==='evaluated'),pending=outcomes.some(outcome=>outcome.status==='pending'),measured=outcomes.filter(outcome=>outcome.status==='evaluated');
 const final=outcomes.find(outcome=>outcome.minutes===60&&outcome.status==='evaluated');
 return immutable({...decision,outcomes,status:complete?'complete':pending?(measured.length?'partial':'pending'):'missing',
  verdict:complete?final.verdict:pending?'pending':'missing',outcomeKind:measured.length?'actual':null,causalEffect:null,
  nextOutcomeAt:outcomes.find(outcome=>outcome.status!=='evaluated')?.targetAt??null,
  delta:final?.delta??null,deltaBaseline:final?.deltaBaseline??null,deltaForecast:final?.deltaForecast??null});
}

function actualEvidence(alert,row){
 return {kind:'actual',detectorId:alert.detectorId,d:alert.d,road:alert.road,ts:iso(millis(row.ts)),ci:row.ci,valid:true,hasVehicles:true};
}
function evaluateAlert(alert,observations=[],{now}={}){
 const current=nowMillis(now);
 if(!validAlert(alert))return immutable({status:'missing',label:null,leadMinutes:null,observedAt:null,evidence:null,reason:'Original CI alert snapshot unavailable'});
 const source=millis(alert.ts),target=source+30*MINUTE,end=target+10*MINUTE;
 const base={status:'pending',label:null,leadMinutes:null,observedAt:null,evidence:null,horizonMinutes:30,targetAt:iso(target),windowEnd:iso(end)};
 if(current<source)return immutable({...base,reason:'Alert source time has not occurred'});
 if(alert.rule==='rain-ci-p90'&&alert.ci>alert.threshold&&alert.rain>0){
  return immutable({...base,status:'evaluated',label:'hit',observedAt:alert.ts,evidence:actualEvidence(alert,alert),reason:'Threshold exceedance was already observed at alert time; no advance lead time'});
 }
 const rows=observations.filter(row=>validObservation(row,alert)&&millis(row.ts)>source&&millis(row.ts)<=end&&millis(row.ts)<=current).slice().sort((a,b)=>millis(a.ts)-millis(b.ts));
 const crossing=rows.find(row=>row.ci>alert.threshold);
 if(crossing)return immutable({...base,status:'evaluated',label:'hit',leadMinutes:alert.ci<=alert.threshold?round((millis(crossing.ts)-source)/MINUTE):null,
  observedAt:iso(millis(crossing.ts)),evidence:actualEvidence(alert,crossing),reason:'First actual observed threshold exceedance after alert; crossing time is bounded by the sampling cadence'});
 if(current<=end)return immutable({...base,reason:'Future source observation window remains open'});
 const targetRow=rows.find(row=>millis(row.ts)>=target);
 if(targetRow)return immutable({...base,status:'evaluated',label:'false-alarm',observedAt:iso(millis(targetRow.ts)),evidence:actualEvidence(alert,targetRow),
  reason:'Valid target-window CI did not exceed threshold and no exceedance was observed in the window; unobserved gaps are not reconstructed'});
 return immutable({...base,status:'missing',reason:'No evaluable target-window observations; alert is right-censored, not a false alarm'});
}

function summarize(alerts=[],decisions=[],{now,observations=[]}={}){
 const current=nowMillis(now),uniqueAlerts=[...new Map(alerts.filter(validAlert).map(alert=>[alert.id,alert])).values()];
 const uniqueDecisions=[...new Map(decisions.map((decision,i)=>[decision.id??decision._id??`legacy-${i}`,decision])).values()];
 const linked=uniqueDecisions.filter(decision=>uniqueAlerts.some(alert=>associatedDecision(alert,decision))).map(decision=>evaluateDecision(decision,observations,{now:current}));
 const states=uniqueAlerts.map(alert=>alertState(alert,linked,{now:current}));
 const evaluations=uniqueAlerts.map(alert=>{
  const evidence=alert.evaluation?.evidence;
  // A stored label without valid actual source evidence cannot enter a denominator.
  return evaluateAlert(alert,[...observations,...(evidence?.kind==='actual'?[evidence]:[])],{now:current});
 });
 const labeled=evaluations.filter(evaluation=>evaluation.status==='evaluated'),hits=labeled.filter(evaluation=>evaluation.label==='hit').length;
 const falseAlarms=labeled.filter(evaluation=>evaluation.label==='false-alarm').length,lead=labeled.map(evaluation=>evaluation.leadMinutes).filter(finite);
 const outcomesByHorizon=Object.fromEntries(horizons.map(minutes=>{
  const entries=linked.map(decision=>decision.outcomes?.find(outcome=>outcome.minutes===minutes)).filter(Boolean);
  const measured=entries.filter(outcome=>outcome.status==='evaluated'&&outcome.evidenceKind==='actual'&&finite(outcome.realizedCI));
  const deltas=measured.map(outcome=>outcome.delta).filter(finite),baselines=measured.map(outcome=>outcome.deltaBaseline).filter(finite),forecasts=measured.map(outcome=>outcome.deltaForecast).filter(finite);
  return [minutes,{minutes,evaluated:measured.length,pending:entries.filter(outcome=>outcome.status==='pending').length,missing:entries.filter(outcome=>outcome.status==='missing').length,
   improved:measured.filter(outcome=>outcome.verdict==='improved').length,unchanged:measured.filter(outcome=>outcome.verdict==='unchanged').length,worse:measured.filter(outcome=>outcome.verdict==='worse').length,
   outcomeDelta:mean(deltas),baselineDelta:mean(baselines),forecastDelta:mean(forecasts),denominators:{outcomeDelta:deltas.length,baselineDelta:baselines.length,forecastDelta:forecasts.length}}];
 }));
 const measured=linked.flatMap(decision=>(decision.outcomes??[]).filter(outcome=>outcome.status==='evaluated'&&outcome.evidenceKind==='actual'&&finite(outcome.realizedCI))),deltas=measured.map(outcome=>outcome.delta).filter(finite);
 return immutable({alerts:uniqueAlerts.length,decisions:linked.length,orphanDecisions:uniqueDecisions.length-linked.length,
  activeAlerts:states.filter(state=>state==='active').length,decidedAlerts:states.filter(state=>state==='decided').length,expiredAlerts:states.filter(state=>state==='expired').length,
  labeledAlerts:labeled.length,censoredAlerts:evaluations.filter(evaluation=>evaluation.status==='missing').length,pendingAlerts:evaluations.filter(evaluation=>evaluation.status==='pending').length,
  hits,falseAlarms,hitRate:labeled.length?hits/labeled.length:null,falseAlarmRate:labeled.length?falseAlarms/labeled.length:null,
  leadTimeMinutes:mean(lead),outcomeDelta:mean(deltas),denominators:{hitRate:labeled.length,falseAlarmRate:labeled.length,leadTimeMinutes:lead.length,outcomeDelta:deltas.length},
  evaluated:linked.filter(decision=>horizons.every(minutes=>decision.outcomes?.some(outcome=>outcome.minutes===minutes&&outcome.status==='evaluated'))).length,
  pending:linked.filter(decision=>decision.outcomes?.some(outcome=>outcome.status==='pending')).length,missing:linked.filter(decision=>decision.outcomes?.some(outcome=>outcome.status==='missing')).length,
  improved:linked.filter(decision=>decision.verdict==='improved').length,unchanged:linked.filter(decision=>decision.verdict==='unchanged').length,worse:linked.filter(decision=>decision.verdict==='worse').length,
  simulatedDecisions:linked.length,actualObservationOutcomes:measured.length,actualDispatches:0,causalEffect:null,
  horizons,outcomesByHorizon,falseAlarmDefinition:contract.falseAlarmDefinition,hitDefinition:contract.hitDefinition,leadTimeDefinition:contract.leadTimeDefinition,
  hitRateDefinition:contract.hitRateDefinition,outcomeDeltaDefinition:contract.outcomeDeltaDefinition,outcomeDeltaAggregation:contract.outcomeDeltaAggregation,evaluatedDefinition:contract.evaluatedDefinition,
  outcomeWindow:contract.outcomeWindow,labels:{actors:'simulated',observations:'actual',effects:'descriptive CI change; no causal or dispatch benefit claimed'}});
}

module.exports={contract,createAlert,validateAction,createDecision,evaluateDecision,evaluateAlert,alertState,summarize};
