'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const core=require('./core.cjs'),history=require('./history.cjs');
const {parseRegionalRain,parseWeatherReport,versionTime}=require('./historical-weather.cjs');
const {hktDay}=require('./recovery.cjs');

// Parse separately from writes so schema/time failures cannot become successful checkpoints.
async function parseJob(job,body,window,metadata){
 const groups={},inside=ts=>Number.isFinite(Date.parse(ts))&&ts>=window.from&&ts<=window.to;
 let retainedReports=0,details={};
 if(job.kind==='traffic'){
  const rows=await core.parseTraffic(body.toString(),metadata);if(!rows.length)throw Error('No historical traffic matches study metadata');groups.traffic=rows.filter(r=>inside(r.ts));
 }else if(job.kind==='weather-rss-full'){
  const report=await parseWeatherReport(body.toString());
  groups.weather_archive=[{_id:'full-rss|'+job.time,xml:body.toString(),report}];retainedReports=1;
  groups.weather=report.observedAt&&inside(report.observedAt)?[{...report,_id:'rss|'+report.publishedAt,ts:report.observedAt}]:[];
  groups.district_rain=report.rain.filter(r=>inside(r.ts));
 }else if(job.kind==='regional-rain'){
  const report=parseRegionalRain(body.toString(),job.time);
  groups.weather_archive=[{_id:'regional|'+job.time,html:body.toString(),report}];retainedReports=1;
  groups.district_rain=report.rows.filter(r=>inside(r.ts));details={statement:report.statement};
 }else if(job.kind==='daily-rain'){
  const all=history.parseDailyRain(body.toString());if(!all.length)throw Error('Unrecognized daily rainfall file');
  groups.daily_rain=all.filter(r=>r.date>=window.start&&r.date<=window.end).map(r=>({...r,source:job.url}));
  const requested=history.dateRange(window.start,window.end).filter(d=>d.startsWith(job.time));
  const present=new Set(groups.daily_rain.map(r=>r.date));
  details={lastPublishedDate:all.map(r=>r.date).sort().at(-1),unpublishedDates:requested.filter(d=>!present.has(d)).length,unusableDates:groups.daily_rain.filter(r=>r.mm==null&&!r.trace).length};
 }else if(job.kind==='weather'){
  const j=JSON.parse(body.toString());if(!j.updateTime||!Array.isArray(j.rainfall?.data))throw Error('Invalid historical weather JSON');
  const publishedAt=new Date(j.updateTime).toISOString(),ts=new Date(j.rainfall.endTime||j.updateTime).toISOString();
  groups.weather=inside(publishedAt)?[{...j,_id:publishedAt,ts:publishedAt}]:[];
  groups.district_rain=inside(ts)?j.rainfall.data.filter(r=>core.STUDY.includes(r.place)).map(r=>({_id:`${r.place}|${ts}`,d:r.place,ts,publishedAt,mm:core.number(r.max),source:job.sourceUrl,resolution:'hour',kind:'district maximum in last hour'})):[];
 }else if(job.kind==='rain'){
  const j=JSON.parse(body.toString());if(!j.obsTime||!Array.isArray(j.hourlyRainfall))throw Error('Invalid historical station rainfall JSON');
  const ts=new Date(j.obsTime).toISOString();groups.station_rain=inside(ts)?j.hourlyRainfall.map(r=>({_id:`${r.automaticWeatherStationID}|${ts}`,id:r.automaticWeatherStationID,name:r.automaticWeatherStation,ts,mm:core.number(r.value),rawValue:r.value,unit:r.unit,source:job.sourceUrl,resolution:'hour'})):[];
 }else if(job.kind==='camera-archive'){
  if(body.length<4||body[0]!==255||body[1]!==216||body.at(-2)!==255||body.at(-1)!==217)throw Error('Historical camera response is not a complete JPEG');
  const ts=versionTime(job.time);groups.camera_frames=inside(ts)?[{_id:`${job.camera.id}|${ts}`,id:job.camera.id,d:job.camera.d,ts,archiveCapturedAt:ts,timestampMeaning:'official archive retrieval; original exposure time unknown',file:`${job.camera.id}-archive-${job.time}.jpg`,bytes:body.length}]:[];
 }else throw Error('Unknown recovery source '+job.kind);
 const observations=Object.entries(groups).filter(([name])=>name!=='weather_archive').flatMap(([,rows])=>rows);
 return {groups,retainedReports,details,dates:[...new Set(observations.map(r=>r.date||hktDay(r.ts)))].sort(),records:observations.length};
}

function createStore(service,window){
 // Scope a checkpoint to its exact window: a clipped boundary file can later be imported in full.
 const checkpoint=job=>`${job.key}|${window.from}|${window.to}`;
 const imports=service.db.collection('imports');
 return {
  async completed(job){
   // Annual files are revised as new dates are published: always refresh these small files.
   if(job.kind==='daily-rain')return false;
   const old=await imports.findOne({_id:checkpoint(job),ok:true});return old?.result||false;
  },
  async write(job,response){
   const value=await parseJob(job,response.body,window,service.metadata),fetchedAt=new Date().toISOString();let inserted=0;
   const provenance={archive:job.url,requestedTime:job.time,resolvedUrl:response.url||job.url,downloadedAt:fetchedAt};
   for(const [name,rows] of Object.entries(value.groups)){
    if(!rows.length)continue;
    if(name==='camera_frames')for(const row of rows)await fs.writeFile(path.join(service.dataDir,'cameras',row.file),response.body);
    // Never replace existing live/archive observations or known publication timestamps.
    const result=await service.db.collection(name).bulkWrite(rows.map(row=>({updateOne:{filter:{_id:row._id},update:{$setOnInsert:{...row,provenance,fetchedAt}},upsert:true}})),{ordered:false});
    if(name!=='weather_archive')inserted+=result.upsertedCount;
   }
   service.cache=null;service.researchCache.clear();
   return {records:value.records,inserted,dates:value.dates,retainedReports:value.retainedReports,details:value.details};
  },
  async mark(job,result){await imports.updateOne({_id:checkpoint(job)},{$set:{ok:true,kind:job.kind,time:job.time,archive:job.url,window,result,at:new Date().toISOString()}},{upsert:true});},
  async failure(job,error){await imports.updateOne({_id:checkpoint(job)},{$set:{ok:false,kind:job.kind,archive:job.url,window,error:error.message,at:new Date().toISOString()}},{upsert:true});}
 };
}
module.exports={parseJob,createStore};
