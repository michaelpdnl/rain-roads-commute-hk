'use strict';
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const number = value => value == null || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const mean = values => { const v=values.filter(x=>x!=null&&Number.isFinite(x)); return v.length?v.reduce((a,b)=>a+b,0)/v.length:null; };
const round = (x,n=3) => x==null?null:Number(x.toFixed(n));
const STUDY = ['Kwun Tong','Yau Tsim Mong','Sha Tin','Yuen Long','Tsuen Wan','Sham Shui Po'];

function parseCsv(input) {
  let text=Buffer.isBuffer(input)?input.toString(input[0]===255&&input[1]===254?'utf16le':'utf8'):String(input);
  text=text.replace(/^\uFEFF+/, '');
  const sep=text.split(/\r?\n/,1)[0].includes('\t')?'\t':',';
  const rows=[]; let row=[],field='',quoted=false;
  for(let i=0;i<=text.length;i++){
    const c=text[i];
    if(c==='"') {if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
    else if(!quoted&&(c===sep||c==='\n'||c===undefined)){
      row.push(field.replace(/\r$/, '').trim());field='';
      if(c!==sep){if(row.some(Boolean))rows.push(row);row=[];}
    }else if(c!==undefined)field+=c;
  }
  const head=rows.shift()||[];
  return rows.map(r=>Object.fromEntries(head.map((k,i)=>[k,r[i]||''])));
}

async function parseTraffic(xml, metadata) {
  const {parseStringPromise}=require('xml2js');
  const root=(await parseStringPromise(xml,{explicitArray:false})).raw_speed_volume_list;
  if(!root?.date||!root.periods)throw new Error('Unexpected TD XML structure');
  const map=new Map(metadata.map(d=>[d.id,d]));const rows=[];
  for(const p of array(root.periods.period))for(const det of array(p.detectors?.detector)){
    const meta=map.get(String(det.detector_id));if(!meta)continue;
    const ts=new Date(`${root.date}T${p.period_to}+08:00`).toISOString();
    const all=array(det.lanes?.lane);
    const lanes=all.map(l=>({speed:number(l.speed),volume:number(l.volume),occupancy:number(l.occupancy),valid:l.valid}))
      .filter(l=>l.valid==='Y'&&l.speed!=null&&l.speed>=0&&l.speed<=160&&l.volume!=null&&l.volume>=0);
    const volume=lanes.reduce((s,l)=>s+l.volume,0);
    const speed=lanes.length?(volume>0?lanes.reduce((s,l)=>s+l.speed*l.volume,0)/volume:mean(lanes.map(l=>l.speed))):null;
    rows.push({...meta,_id:`${meta.id}|${ts}`,ts,direction:det.direction||'',speed:round(speed),volume,
      occupancy:round(mean(lanes.map(l=>l.occupancy!=null&&l.occupancy>=0&&l.occupancy<=100?l.occupancy:null))),
      validLanes:lanes.length,totalLanes:all.length,valid:lanes.length>0,hasVehicles:volume>0});
  }
  return rows;
}

function correlation(points) {
  const p=points.filter(p=>p.x!=null&&p.y!=null&&Number.isFinite(p.x)&&Number.isFinite(p.y));
  if(p.length<3)return null;
  const mx=mean(p.map(p=>p.x)),my=mean(p.map(p=>p.y));
  let xy=0,xx=0,yy=0;for(const p0 of p){const x=p0.x-mx,y=p0.y-my;xy+=x*y;xx+=x*x;yy+=y*y;}
  return xx&&yy?round(xy/Math.sqrt(xx*yy),6):null;
}

function joinRain(traffic,rain,maxMinutes=30) {
  const groups=new Map();
  for(const r of rain){if(!groups.has(r.d))groups.set(r.d,[]);groups.get(r.d).push(r);}
  for(const g of groups.values())g.sort((a,b)=>a.ts.localeCompare(b.ts));
  return traffic.map(t=>{const g=groups.get(t.d)||[];let r=null;
    for(let i=g.length-1;i>=0;i--){if(g[i].ts<=t.ts){r=g[i];break;}}
    const age=r?Date.parse(t.ts)-Date.parse(r.ts):Infinity;
    return {...t,rain:age<=maxMinutes*60000?r.mm:null,rainTs:age<=maxMinutes*60000?r.ts:null};
  });
}

function isPeak(ts){const d=new Date(Date.parse(ts)+8*3600000);const h=d.getUTCHours();return d.getUTCDay()>0&&d.getUTCDay()<6&&((h>=7&&h<10)||(h>=17&&h<20));}
function analyse(input) {
  const rows=input.filter(r=>r.speed!=null&&r.speed>=0&&r.valid!==false&&r.hasVehicles!==false);
  const grouped=new Map();for(const r of rows){if(!grouped.has(r.d))grouped.set(r.d,[]);grouped.get(r.d).push(r);}
  const districts=[...grouped].map(([d,v])=>({d,n:v.length,speed:round(mean(v.map(r=>r.speed))),occupancy:round(mean(v.map(r=>r.occupancy))),volume:v.reduce((s,r)=>s+(r.volume||0),0)}));
  const paired=rows.filter(r=>r.rain!=null);const wet=paired.filter(r=>r.rain>0),dry=paired.filter(r=>r.rain===0);
  const points=paired.map(r=>({x:r.rain,y:r.speed}));const r=correlation(points);let rainFit=null;
  // Samples within a rolling rainfall window are descriptive; no IID p-values or causal claims.
  if(wet.length>=10&&dry.length>=10&&r!=null){const mx=mean(points.map(p=>p.x)),my=mean(points.map(p=>p.y));const xx=points.reduce((s,p)=>s+(p.x-mx)**2,0);const slope=points.reduce((s,p)=>s+(p.x-mx)*(p.y-my),0)/xx;
    rainFit={slope:round(slope,6),intercept:round(my-slope*mx),r,r2:round(r*r),n:paired.length};}
  const speedOccupancy=correlation(rows.map(r=>({x:r.occupancy,y:r.speed})));
  const slow=rows.filter(r=>r.speed<30).length;
  const findings=[];if(rows.length){findings.push({title:'Observed speed',value:`${round(mean(rows.map(r=>r.speed)),1)} km/h`,detail:`Mean across ${rows.length} valid detector-periods with vehicles; not a journey-time estimate.`});
    findings.push({title:'Below 30 km/h',value:`${round(slow/rows.length*100,1)}%`,detail:`${slow}/${rows.length} detector-periods. This threshold is descriptive, not an official congestion category.`});}
  if(speedOccupancy!=null)findings.push({title:'Speed / occupancy association',value:`r = ${speedOccupancy}`,detail:'Pearson correlation on observed detector-periods; roadway and time confounding remain.'});
  return {n:rows.length,meanSpeed:round(mean(rows.map(r=>r.speed))),speedOccupancy,districts,wet:wet.length,dry:dry.length,paired:paired.length,
    wetSpeed:round(mean(wet.map(r=>r.speed))),drySpeed:round(mean(dry.map(r=>r.speed))),rainFit,
    peakSpeed:round(mean(rows.filter(r=>isPeak(r.ts)).map(r=>r.speed))),offPeakSpeed:round(mean(rows.filter(r=>!isPeak(r.ts)).map(r=>r.speed))),
    findings,points:points.filter((_,i)=>i%Math.max(1,Math.ceil(points.length/1200))===0),
    occupancyPoints:rows.filter((_,i)=>i%Math.max(1,Math.ceil(rows.length/1200))===0).map(r=>({x:r.occupancy,y:r.speed})),
    rainMessage:rainFit?'Descriptive association only; rolling windows and repeated detectors are not independent.':`Insufficient variation / paired samples for a rainfall fit (${wet.length} wet, ${dry.length} dry).`,
    start:rows.length?rows.reduce((v,r)=>r.ts<v?r.ts:v,rows[0].ts):null,end:rows.length?rows.reduce((v,r)=>r.ts>v?r.ts:v,rows[0].ts):null};
}
module.exports={STUDY,array,number,mean,round,parseCsv,parseTraffic,correlation,joinRain,isPeak,analyse};
