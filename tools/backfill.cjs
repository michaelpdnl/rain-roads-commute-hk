'use strict';
const {get,request,SOURCES}=require('../lib/service.cjs');const history=require('../lib/history.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function research(service,args){
 const flag=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
 const start=flag('--start','20261001'),end=flag('--end','20261031'),days=history.dateRange(start,end);
 const daily=await request(history.DAILY_URL);await service.ingestHistorical('daily-rain',daily.body,{resolvedUrl:daily.url,downloadedAt:new Date().toISOString()});
 const dailyRows=history.parseDailyRain(daily.body.toString()),knownDates=new Set(dailyRows.filter(r=>Number.isFinite(r.mm)||r.trace).map(r=>r.date));
 const wetDates=new Set(dailyRows.filter(r=>r.mm>0||r.trace).map(r=>r.date));
 const versions=async(url,a,b)=>{const target=`https://app.data.gov.hk/v1/historical-archive/list-file-versions?url=${encodeURIComponent(url)}&start=${a}&end=${b}`;const j=JSON.parse((await request(target)).body.toString());if(!Array.isArray(j.timestamps)||j.timestamps.length<j['version-count'])throw new Error(`Archive listing truncated: ${a}–${b}`);return j.timestamps;};
 const weather=await versions(history.RSS_URL,start,end),traffic=[];
 for(let i=0;i<days.length;i+=3){traffic.push(...await versions(SOURCES.traffic.url,days[i],days[Math.min(days.length-1,i+2)]));await pause(500);}
 const imported=new Set((await service.db.collection('imports').find({ok:true},{projection:{_id:1}}).toArray()).map(r=>r._id));
 const selected=history.selectTrafficVersions(traffic,{wetDates,knownDates});
 const jobs=[...weather.map(time=>({kind:'weather-rss',time})),...selected.map(time=>({kind:'traffic',time}))].filter(j=>!imported.has(`${j.kind}|${j.time}`));
 console.log(JSON.stringify({stage:'plan',start,end,weatherVersions:weather.length,trafficVersions:traffic.length,selectedTraffic:selected.length,pending:jobs.length,rate:'2 archive downloads/s; two workers',unknownDailyDates:days.filter(d=>!knownDates.has(d)),cadence:'wet 10 minutes / dry 60 minutes; missing daily classification skipped',wetDates:[...wetDates].filter(d=>d>=start&&d<=end)}));
 let next=0,done=0,failed=0,inserted=0,nextAt=Date.now();
 const worker=async()=>{while(next<jobs.length){const job=jobs[next++],slot=nextAt;nextAt=Math.max(Date.now(),slot)+500;await pause(Math.max(0,slot-Date.now()));
  try{const r=await service.backfill(job.kind,job.time);inserted+=r.inserted||0;done++;if(done%25===0)console.log(JSON.stringify({stage:'progress',done,failed,pending:jobs.length-done-failed,inserted,last:job}));}
  catch(e){failed++;await service.db.collection('imports').updateOne({_id:`${job.kind}|${job.time}`},{$set:{ok:false,error:e.message,at:new Date().toISOString()}},{upsert:true});console.log(JSON.stringify({stage:'failed',...job,error:e.message}));}
 }};
 await Promise.all([worker(),worker()]);return {start,end,done,failed,inserted};
}
(async()=>{const service=get(),args=process.argv.slice(2);let failed=0;
 try{if(args.includes('--research')){const result=await research(service,args);failed=result.failed;console.log(JSON.stringify({stage:'complete',...result}));}
 else{const times=args.length?args:['20261113-0830','20261115-0300','20261116-0830','20261116-1830','20261117-0830','20261117-1830','20261117-2100'];for(const time of times){try{console.log(JSON.stringify({time,...await service.backfill('traffic',time)}));}catch(e){failed++;console.log(JSON.stringify({time,error:e.message}));}}}
 }finally{await service.close();}if(failed)process.exitCode=2;
})().catch(e=>{console.error(e.message);process.exitCode=1;});
