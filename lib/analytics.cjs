'use strict';
const core=require('./core.cjs');
const local=ts=>new Date(Date.parse(ts)+8*3600000);
function quantile(values,p){const a=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!a.length)return null;const i=(a.length-1)*p,l=Math.floor(i);return a[l]+(a[Math.ceil(i)]-a[l])*(i-l);}
function baselineKey(row){const hour=local(row.ts).getUTCHours();return Number.isFinite(hour)?`${row.id}|${hour}`:null;}
function baselines(rows){const groups=new Map();for(const r of rows){const key=baselineKey(r);if(!key||r.valid===false||r.hasVehicles===false||!Number.isFinite(r.speed)||r.speed<0)continue;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r.speed);}const result=new Map();for(const [key,v]of groups){const speed=quantile(v,0.85);if(v.length>=12&&speed>0)result.set(key,{speed,n:v.length});}return result;}
function enrich(rows,b){return rows.map(r=>{const base=b.get(baselineKey(r)),ratio=base&&r.valid!==false&&r.hasVehicles!==false&&r.speed!=null?r.speed/base.speed:null;return {...r,freeFlow:base?.speed??null,baselineN:base?.n||0,ratio,ci:ratio==null?null:1-ratio};});}
function heatmap(rows,now=new Date().toISOString()){
 const end=local(now).toISOString().slice(0,10),endMs=Date.parse(end+'T00:00:00Z');const result=Array.from({length:7},(_,i)=>({date:new Date(endMs-(6-i)*86400000).toISOString().slice(0,10),cells:Array.from({length:24},(_,hour)=>({hour,total:0,valid:0,share:null}))}));const days=new Map(result.map(r=>[r.date,r]));
 for(const r of rows){const d=local(r.ts),day=days.get(d.toISOString().slice(0,10));if(!day)continue;const c=day.cells[d.getUTCHours()],n=r.records??1,valid=r.validCount??(r.valid!==false?n:0);c.total+=n;c.valid+=valid;c.share=c.valid/c.total;}return result;
}

function replayEvents(timeline){const events=[];for(let i=0;i<timeline.length;i++){const r=timeline[i],p=timeline[i-1],gap=p?Date.parse(r.ts)-Date.parse(p.ts):0;
 if(gap>900000)events.push({ts:r.ts,title:'Collection gap',detail:`${Math.round(gap/60000)} minutes between stored frames`});
 if(r.rain>0&&(!p||p.rain==null||p.rain===0))events.push({ts:r.ts,title:'Rain reported',detail:`${core.round(r.rain)} mm mean of available district maxima; hourly archive resolution`});
 if(p&&gap<=900000&&r.ci!=null&&p.ci!=null&&Math.abs(r.ci-p.ci)>=0.15)events.push({ts:r.ts,title:r.ci>p.ci?'Congestion increased':'Recovery observed',detail:`Network CI ${core.round(p.ci)} → ${core.round(r.ci)}`});
 }return events.slice(-100);}


module.exports={quantile,baselineKey,baselines,enrich,heatmap,replayEvents};
