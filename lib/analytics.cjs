'use strict';
const core=require('./core.cjs');
const clamp=x=>Math.max(0,Math.min(1,x)),dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const local=ts=>new Date(Date.parse(ts)+8*3600000);
function quantile(values,p){const a=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!a.length)return null;const i=(a.length-1)*p,l=Math.floor(i);return a[l]+(a[Math.ceil(i)]-a[l])*(i-l);}
function baselines(rows){const groups=new Map();for(const r of rows){if(r.valid===false||r.hasVehicles===false||!(r.speed>0))continue;if(!groups.has(r.id))groups.set(r.id,[]);groups.get(r.id).push(r.speed);}const result=new Map();for(const [id,v]of groups)if(v.length>=12)result.set(id,{speed:quantile(v,0.85),n:v.length});return result;}
function enrich(rows,b){return rows.map(r=>{const base=b.get(r.id),ratio=base&&r.valid!==false&&r.hasVehicles!==false&&r.speed!=null?r.speed/base.speed:null;return {...r,freeFlow:base?.speed??null,baselineN:base?.n||0,ratio,ci:ratio==null?null:clamp(1-ratio)};});}
function inverse(matrix){const n=matrix.length,a=matrix.map((row,i)=>[...row,...Array.from({length:n},(_,j)=>+(i===j))]);for(let c=0;c<n;c++){let pivot=c;for(let r=c+1;r<n;r++)if(Math.abs(a[r][c])>Math.abs(a[pivot][c]))pivot=r;if(Math.abs(a[pivot][c])<1e-9)return null;[a[c],a[pivot]]=[a[pivot],a[c]];const q=a[c][c];for(let j=0;j<n*2;j++)a[c][j]/=q;for(let r=0;r<n;r++)if(r!==c){const f=a[r][c];if(f)for(let j=0;j<n*2;j++)a[r][j]-=f*a[c][j];}}return a.map(r=>r.slice(n));}
const multiply=(a,b)=>a.map(row=>b[0].map((_,j)=>row.reduce((s,x,k)=>s+x*b[k][j],0)));
function normalP(z){const x=Math.abs(z),t=1/(1+0.2316419*x),d=0.3989422804014327*Math.exp(-x*x/2);return Math.min(1,2*d*t*(0.319381530+t*(-0.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429)))));}

function fitControlled(input,{interaction=false}={}){
 const rows=input.filter(r=>Number.isFinite(r.ratio)&&r.ratio>=0&&r.ratio<=2&&Number.isFinite(r.rain));
 const wet=rows.filter(r=>r.rain>0),dry=rows.filter(r=>r.rain===0),clusters=new Set(rows.map(r=>r.id));
 const windows=v=>new Set(v.map(r=>`${r.d}|${r.rainTs||r.ts}`)).size;
 if(rows.length<60||wet.length<10||dry.length<10||windows(wet)<3||windows(dry)<3||clusters.size<6)return null;
 const hours=[...new Set(rows.map(r=>local(r.ts).getUTCHours()))].sort((a,b)=>a-b),days=[...new Set(rows.map(r=>local(r.ts).getUTCDay()))].sort();
 const terms=['intercept','rain',...hours.slice(1).map(h=>'hour'+h),...days.slice(1).map(d=>'weekday'+d)];
 if(interaction){if(!wet.some(r=>core.isPeak(r.ts))||!wet.some(r=>!core.isPeak(r.ts)))return null;terms.push('peak','rainPeak');}
 const vector=r=>{const d=local(r.ts),x=[1,r.rain,...hours.slice(1).map(h=>+(d.getUTCHours()===h)),...days.slice(1).map(w=>+(d.getUTCDay()===w))];if(interaction)x.push(+core.isPeak(r.ts),r.rain*(+core.isPeak(r.ts)));return x;};
 const k=terms.length,xx=Array.from({length:k},()=>Array(k).fill(0)),xy=Array(k).fill(0);
 for(const r of rows){const x=vector(r),nz=x.map((v,i)=>v?i:-1).filter(i=>i>=0);for(const i of nz){xy[i]+=x[i]*r.ratio;for(const j of nz)xx[i][j]+=x[i]*x[j];}}
 // Preserve the nuisance-control span first. Rain must vary independently of it.
 const chosen=[0],independent=j=>{const si=inverse(chosen.map(i=>chosen.map(q=>xx[i][q])));if(!si)return false;const v=chosen.map(i=>xx[i][j]),residual=xx[j][j]-dot(v,si.map(r=>dot(r,v)));return residual>Math.max(1,xx[j][j])*1e-9;};
 for(let j=2;j<k;j++)if(terms[j]!=='rainPeak'&&independent(j))chosen.push(j);
 if(!independent(1))return null;chosen.push(1);
 if(interaction){const j=terms.indexOf('rainPeak');if(!independent(j))return null;chosen.push(j);}chosen.sort((a,b)=>a-b);
 const inv=inverse(chosen.map(i=>chosen.map(j=>xx[i][j])));if(!inv)return null;const keptTerms=chosen.map(i=>terms[i]),q=chosen.length,coefficients=inv.map(row=>dot(row,chosen.map(i=>xy[i]))),scores=new Map();let sse=0,sst=0;const my=core.mean(rows.map(r=>r.ratio));
 for(const r of rows){const full=vector(r),x=chosen.map(i=>full[i]),residual=r.ratio-dot(x,coefficients);sse+=residual*residual;sst+=(r.ratio-my)**2;if(!scores.has(r.id))scores.set(r.id,Array(q).fill(0));const s=scores.get(r.id);for(let i=0;i<q;i++)s[i]+=x[i]*residual;}
 const meat=Array.from({length:q},()=>Array(q).fill(0));for(const s of scores.values())for(let i=0;i<q;i++)for(let j=0;j<q;j++)meat[i][j]+=s[i]*s[j];
 const correction=clusters.size/(clusters.size-1)*(rows.length-1)/(rows.length-q),cov=multiply(multiply(inv,meat),inv).map(row=>row.map(v=>v*correction));
 const se=Math.sqrt(Math.max(0,cov[1][1])),slope=coefficients[1];
 const result={slope,se,lo:slope-1.96*se,hi:slope+1.96*se,p:se?normalP(slope/se):null,r2:sst?1-sse/sst:null,n:rows.length,clusters:clusters.size,wet:wet.length,dry:dry.length,wetWindows:windows(wet),dryWindows:windows(dry),terms:keptTerms,droppedTerms:terms.filter((_,i)=>!chosen.includes(i)),coefficients,method:'OLS + available hour/weekday controls (redundant columns removed); detector-cluster sandwich SE; approximate 95% normal interval'};
 if(interaction){const i=keptTerms.indexOf('rainPeak');if(i>=0){const peak=slope+coefficients[i],peakSE=Math.sqrt(Math.max(0,cov[1][1]+cov[i][i]+2*cov[1][i]));result.interaction={off:slope,peak,offLo:result.lo,offHi:result.hi,peakLo:peak-1.96*peakSE,peakHi:peak+1.96*peakSE};}}
 return result;
}

function lagAssociations(rows,rain){return [0,30,60,90,120].map(minutes=>{const shifted=rows.map(r=>({...r,ts:new Date(Date.parse(r.ts)-minutes*60000).toISOString()}));const paired=core.joinRain(shifted,rain).filter(r=>r.rain!=null&&r.ratio!=null);const windows=new Set(paired.map(r=>`${r.d}|${r.rainTs}`)).size;return {minutes,n:paired.length,windows,r:paired.length>=30&&windows>=3?core.correlation(paired.map(r=>({x:r.rain,y:r.ratio}))):null};});}

function networkFrames(rows){
 const groups=new Map();for(const r of rows){const ms=Math.floor(Date.parse(r.ts)/300000)*300000;if(!Number.isFinite(ms))continue;if(!groups.has(ms))groups.set(ms,[]);groups.get(ms).push(r);}
 return [...groups].sort((a,b)=>a[0]-b[0]).map(([,v])=>{const good=v.filter(r=>r.ci!=null),rain=new Map();for(const r of v)if(r.rain!=null)rain.set(r.d,r.rain);const observedAt=v.reduce((s,r)=>r.ts>s?r.ts:s,v[0].ts);
  return {ts:observedAt,observedAt,n:v.length,valid:v.filter(r=>r.valid!==false).length,baselineN:good.length,ci:core.mean(good.map(r=>r.ci)),speed:core.mean(v.filter(r=>r.valid!==false&&r.hasVehicles!==false).map(r=>r.speed)),occupancy:core.mean(v.map(r=>r.occupancy)),rain:core.mean([...rain.values()]),rainDistricts:rain.size};
 });
}
function joinAvailableRain(rows,rain){
 const groups=new Map();for(const r of rain){if(!groups.has(r.d))groups.set(r.d,[]);groups.get(r.d).push(r);}for(const g of groups.values())g.sort((a,b)=>a.ts.localeCompare(b.ts));
 return rows.map(row=>{const t=Date.parse(row.ts),g=groups.get(row.d)||[];let match=null;for(let i=g.length-1;i>=0;i--){const r=g[i],observed=Date.parse(r.ts);if(observed>t)continue;if(t-observed>1800000)break;const available=Date.parse(r.publishedAt||r.fetchedAt);if(Number.isFinite(available)&&available<=t){match=r;break;}}return {...row,rain:match?.mm??null,rainTs:match?.ts||null};});
}

function forecast(input,{cutTime}={}){
 const frames=input.filter(r=>Number.isFinite(r.ci)).sort((a,b)=>a.ts.localeCompare(b.ts));
 const cut=cutTime||frames[Math.floor(frames.length*0.75)]?.ts,models=[];
 const nearest=(target,start=0)=>{let l=start,h=frames.length;while(l<h){const m=(l+h)>>1;if(Date.parse(frames[m].ts)<target)l=m+1;else h=m;}return l<frames.length&&Date.parse(frames[l].ts)-target<=300000?l:-1;};
 const features=(r,i)=>{const prev=nearest(Date.parse(r.ts)-1800000);const old=prev>=0&&prev<i?frames[prev].ci:null,h=local(r.ts).getUTCHours()+local(r.ts).getUTCMinutes()/60;return [r.ci,old==null?0:r.ci-old,+(old!=null),r.occupancy==null?0:r.occupancy/100,+(r.occupancy!=null),r.rain??0,+(r.rain!=null),Math.sin(h*Math.PI/12),Math.cos(h*Math.PI/12)];};
 const ridge=pairs=>{const k=9,means=Array.from({length:k},(_,j)=>core.mean(pairs.map(p=>p.x[j]))),sd=means.map((m,j)=>Math.sqrt(core.mean(pairs.map(p=>(p.x[j]-m)**2)))||1),vec=x=>[1,...x.map((v,j)=>(v-means[j])/sd[j])],xx=Array.from({length:k+1},()=>Array(k+1).fill(0)),xy=Array(k+1).fill(0);for(const p of pairs){const x=vec(p.x);for(let i=0;i<x.length;i++){xy[i]+=x[i]*p.y;for(let j=0;j<x.length;j++)xx[i][j]+=x[i]*x[j];}}for(let i=1;i<=k;i++)xx[i][i]+=1;const inv=inverse(xx);if(!inv)return null;const beta=inv.map(row=>dot(row,xy));return {beta,predict:x=>clamp(dot(vec(x),beta))};};
 for(const minutes of [30,60,120]){
  const pairs=[];frames.forEach((r,i)=>{const j=nearest(Date.parse(r.ts)+minutes*60000,i+1);if(j>=0)pairs.push({ts:r.ts,target:frames[j].ts,x:features(r,i),y:frames[j].ci,persistence:r.ci});});
  const train=pairs.filter(p=>p.target<cut),test=pairs.filter(p=>p.ts>=cut),model={minutes,nTrain:train.length,nTest:test.length,available:false,reason:'Need at least 30 training pairs and 10 later test pairs; gaps are not interpolated.'};
  if(train.length>=30&&test.length>=10){const trained=ridge(train);if(trained){const evaluated=test.map(p=>({ts:p.target,actual:p.y,predicted:trained.predict(p.x),baseline:p.persistence})),modelMAE=core.mean(evaluated.map(p=>Math.abs(p.predicted-p.actual))),baselineMAE=core.mean(evaluated.map(p=>Math.abs(p.baseline-p.actual))),all=ridge(pairs);Object.assign(model,{available:true,reason:null,coefficients:trained.beta,trainedThrough:train.at(-1).target,testFrom:test[0].ts,modelMAE,baselineMAE,skill:baselineMAE?(baselineMAE-modelMAE)/baselineMAE*100:null,prediction:all?.predict(features(frames.at(-1),frames.length-1))??null,predictedAt:new Date(Date.parse(frames.at(-1).ts)+minutes*60000).toISOString(),evaluated});}}
  models.push(model);
 }
 const last=frames.at(-1);return {models,cutTime:cut||null,latestTs:last?.ts||null,scope:'Network mean congestion index; chronological held-out observations, ridge regression vs persistence. Not a journey forecast.',outlook:models.filter(m=>m.available).map(m=>({ts:m.predictedAt,ci:m.prediction,minutes:m.minutes})),recent:frames.slice(-60).map(r=>({ts:r.ts,ci:r.ci}))};
}

function heatmap(rows,now=new Date().toISOString()){
 const end=local(now).toISOString().slice(0,10),endMs=Date.parse(end+'T00:00:00Z');const result=Array.from({length:7},(_,i)=>({date:new Date(endMs-(6-i)*86400000).toISOString().slice(0,10),cells:Array.from({length:24},(_,hour)=>({hour,total:0,valid:0,share:null}))}));const days=new Map(result.map(r=>[r.date,r]));
 for(const r of rows){const d=local(r.ts),day=days.get(d.toISOString().slice(0,10));if(!day)continue;const c=day.cells[d.getUTCHours()],n=r.records??1,valid=r.validCount??(r.valid!==false?n:0);c.total+=n;c.valid+=valid;c.share=c.valid/c.total;}return result;
}
function loopStats(alerts,decisions){return {alerts,decisions:decisions.length,evaluated:decisions.filter(r=>['faster','slower','similar'].includes(r.verdict)).length,faster:decisions.filter(r=>r.verdict==='faster').length,pending:decisions.filter(r=>r.verdict==='pending').length};}

function replayEvents(timeline){const events=[];for(let i=0;i<timeline.length;i++){const r=timeline[i],p=timeline[i-1],gap=p?Date.parse(r.ts)-Date.parse(p.ts):0;
 if(gap>900000)events.push({ts:r.ts,title:'Collection gap',detail:`${Math.round(gap/60000)} minutes between stored frames`});
 if(r.rain>0&&(!p||p.rain==null||p.rain===0))events.push({ts:r.ts,title:'Rain reported',detail:`${core.round(r.rain)} mm mean of available district maxima; hourly archive resolution`});
 if(p&&gap<=900000&&r.ci!=null&&p.ci!=null&&Math.abs(r.ci-p.ci)>=0.15)events.push({ts:r.ts,title:r.ci>p.ci?'Congestion increased':'Recovery observed',detail:`Network CI ${core.round(p.ci)} → ${core.round(r.ci)}`});
 }return events.slice(-100);}

function buildResearch(input,rain,{period='all'}={}){
 const b=baselines(input),all=core.joinRain(enrich(input,b),rain),selected=all.filter(r=>period==='all'||(period==='peak'?core.isPeak(r.ts):!core.isPeak(r.ts)));
 // One detector per rainfall window / hour: repeated 30-second observations do not inflate the fit.
 const buckets=new Map();for(const r of selected){if(r.rain==null||r.ratio==null)continue;const key=`${r.id}|${r.rainTs}|${local(r.ts).getUTCHours()}`;if(!buckets.has(key))buckets.set(key,{...r,_ratios:[]});buckets.get(key)._ratios.push(r.ratio);}
 const sample=[...buckets.values()].map(({_ratios,...r})=>({...r,ratio:core.mean(_ratios)}));const model=fitControlled(sample),districts=core.STUDY.map(d=>({d,model:fitControlled(sample.filter(r=>r.d===d)),interaction:fitControlled(sample.filter(r=>r.d===d),{interaction:true})?.interaction||null}));
 const timeline=networkFrames(all),cut=timeline[Math.floor(timeline.length*0.75)]?.ts;
 const forecastBase=baselines(input.filter(r=>!cut||r.ts<cut));const forecastTimeline=networkFrames(joinAvailableRain(enrich(input,forecastBase),rain));const maxCoverage=Math.max(0,...forecastTimeline.map(r=>r.baselineN));
 const predictions=forecast(forecastTimeline.filter(r=>r.baselineN>=Math.max(1,maxCoverage*0.5)),{cutTime:cut});predictions.baselineCutoff=cut||null;
 const events=replayEvents(timeline);
 const thresholdGroups=new Map();for(const r of all)if(r.ci!=null){const key=`${r.d}|${local(r.ts).getUTCHours()}`;if(!thresholdGroups.has(key))thresholdGroups.set(key,[]);thresholdGroups.get(key).push(r.ci);}
 const thresholds=Object.fromEntries([...thresholdGroups].filter(([,v])=>v.length>=30).map(([key,v])=>[key,quantile(v,0.9)]));
 return {baseline:{method:'Per detector historical 85th percentile of measured speeds; minimum 12 nonzero observations',detectors:b.size,observations:input.length},baselines:b,thresholds,rows:all,selected,timeline,events:events.slice(-100),impact:{model,districts,lag:lagAssociations(selected,rain),points:sample.filter((_,i)=>i%Math.max(1,Math.ceil(sample.length/1200))===0).map(r=>({x:r.rain,y:r.ratio})),n:sample.length,wet:sample.filter(r=>r.rain>0).length,dry:sample.filter(r=>r.rain===0).length,message:model?'Descriptive association, not causal. Hours/weekdays controlled; repeated detectors clustered. Sampling and omitted factors still matter.':'Not enough independent wet/dry windows, detectors, or full-rank variation for a controlled fit.',resolution:'Archived rainfall is hourly; unlisted districts remain unknown. Lag curves are lagged associations, not precise rain-onset timing.'},forecast:predictions,heatmap:heatmap(input)};
}
module.exports={quantile,baselines,enrich,fitControlled,lagAssociations,networkFrames,forecast,joinAvailableRain,heatmap,loopStats,replayEvents,buildResearch};
