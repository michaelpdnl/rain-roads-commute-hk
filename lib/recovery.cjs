'use strict';
const history=require('./history.cjs');
const core=require('./core.cjs');
const {versionTime,regionalRainUrl}=require('./historical-weather.cjs');
const {SOURCES,request:officialRequest}=require('./service.cjs');
const HOUR=3600000,DAY=24*HOUR;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hktDay=value=>new Date(Date.parse(value)+8*HOUR).toISOString().slice(0,10).replaceAll('-','');
const hktVersion=value=>new Date(value+8*HOUR).toISOString().slice(0,16).replaceAll('-','').replace('T','-').replace(':','');
const statusOf=e=>Number(e.statusCode)||Number(e.message?.match(/HTTP\s+(\d{3})/)?.[1])||null;
const archiveFile=(url,time)=>'https://app.data.gov.hk/v1/historical-archive/get-file?'+new URLSearchParams({url,time});

function parseOptions(args,now=new Date()){
 const values={},flags=new Set(['--preview','--help']),options=new Set(['--days','--start','--end','--from','--to','--as-of','--report']);
 for(let i=0;i<args.length;i++){const key=args[i];if(Object.hasOwn(values,key))throw new Error('Duplicate option '+key);if(flags.has(key))values[key]=true;else if(options.has(key)){if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('Missing value for '+key);values[key]=args[++i];}else throw new Error('Unknown option '+key);}
 if(values['--help'])return {help:true};
 const time=value=>{if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))throw new Error('Use an ISO timestamp with timezone');return Date.parse(value);};
 const cutoff=values['--as-of']?time(values['--as-of']):+now;
 if(cutoff>+now)throw new Error('Recovery cutoff cannot be in the future');
 let from,to=cutoff;
 if(values['--from']||values['--to']){
  if(!values['--from']||!values['--to']||['--days','--start','--end','--as-of'].some(k=>values[k]))throw new Error('Use --from and --to alone to pin a precise window');
  from=time(values['--from']);to=time(values['--to']);
 }else if(values['--start']||values['--end']){
  if(!values['--start']||!values['--end']||values['--days'])throw new Error('Use --start and --end together, without --days');
  history.dateRange(values['--start'],values['--end']);from=Date.parse(versionTime(values['--start']+'-0000'));to=Math.min(cutoff,Date.parse(versionTime(values['--end']+'-2359'))+59999);
 }else{const days=Number(values['--days']||30);if(!Number.isInteger(days)||days<1||days>365)throw new Error('--days must be 1 to 365');from=to-days*DAY;}
 if(!Number.isFinite(from)||from>to||to>+now||to-from>366*DAY)throw new Error('Invalid or future recovery window');
 const window={from:new Date(from).toISOString(),to:new Date(to).toISOString(),start:hktDay(new Date(from).toISOString()),end:hktDay(new Date(to).toISOString())};history.dateRange(window.start,window.end);
 return {window,preview:!!values['--preview'],report:values['--report']||null};
}
function networkClient({request=officialRequest,pause:wait=pause,intervalMs=500,attempts=3}={}){
 let next=0;
 return async url=>{for(let attempt=0;;attempt++){
  if(intervalMs){const at=Math.max(Date.now(),next);next=at+intervalMs;if(at>Date.now())await wait(at-Date.now());}
  try{return await request(url);}catch(e){const code=statusOf(e);if(attempt>=attempts-1||code&&code!==408&&code!==429&&code<500)throw e;await wait(500*2**attempt);}
 }};
}
async function listVersions(url,window,fetch){
 const found=new Set(),errors=[];
 async function visit(start,end){
  try{
   const target='https://app.data.gov.hk/v1/historical-archive/list-file-versions?'+new URLSearchParams({url,start,end});
   const j=JSON.parse((await fetch(target)).body.toString());
   if(!Array.isArray(j.timestamps)||!Number.isInteger(j['version-count'])||j['version-count']<0||j.timestamps.length>j['version-count'])throw new Error('Invalid official archive listing');
   if(j.timestamps.length<j['version-count']){
    const days=history.dateRange(start,end);if(days.length===1)throw new Error('Official archive listing truncated within one date');
    const middle=Math.floor(days.length/2);await visit(start,days[middle-1]);await visit(days[middle],end);return;
   }
   for(const time of j.timestamps){const at=Date.parse(versionTime(time));if(at>=Date.parse(window.from)&&at<=Date.parse(window.to))found.add(time);}
  }catch(e){errors.push({start,end,status:statusOf(e),error:e.message});}
 }
 await visit(window.start,window.end);return {timestamps:[...found].sort(),errors};
}
async function selectedCameras(fetch){
 const rows=core.parseCsv((await fetch(SOURCES.cameras.url)).body).filter(r=>/^[A-Z0-9]+$/.test(r.key)&&r.url===`https://tdcctv.data.one.gov.hk/${r.key}.JPG`);
 return core.STUDY.map(d=>rows.find(r=>r.district===d)).filter(Boolean).map(r=>({id:r.key,d:r.district,url:r.url}));
}
async function discover(window,{fetch=networkClient(),cameras,onProgress=()=>{}}={}){
 const sources=[],jobs=[];
 const definitions=[{id:'traffic',kind:'traffic',url:SOURCES.traffic.url},{id:'weather-rss',kind:'weather-rss-full',url:history.RSS_URL},{id:'weather-json',kind:'weather',url:SOURCES.weather.url},{id:'station-rain',kind:'rain',url:SOURCES.rain.url}];
 if(!cameras){try{cameras=await selectedCameras(fetch);}catch(e){sources.push({id:'camera-metadata',status:'failed',error:e.message});cameras=[];}}
 for(const c of cameras)definitions.push({id:'camera:'+c.id,kind:'camera-archive',url:c.url,camera:c});
 for(const source of definitions){
  const listing=await listVersions(source.url,window,fetch),unavailable=!listing.timestamps.length&&listing.errors.length&&listing.errors.every(e=>[400,404,410].includes(e.status));
  sources.push({id:source.id,url:source.url,status:listing.errors.length?(unavailable?'unavailable':'discovery-incomplete'):'available',versions:listing.timestamps.length,errors:listing.errors});
  for(const time of listing.timestamps)jobs.push({key:source.kind==='traffic'?`traffic|${time}`:`recover-v1|${source.id}|${time}`,kind:source.kind,sourceId:source.id,time,sourceUrl:source.url,url:archiveFile(source.url,time),...(source.camera?{camera:source.camera}:{})});
  onProgress({stage:'discovery',source:source.id,versions:listing.timestamps.length,status:sources.at(-1).status});
 }
 const days=history.dateRange(window.start,window.end),years=[...new Set(days.map(d=>d.slice(0,4)))];
 for(const year of years)jobs.push({key:`recover-v1|daily-rain|${year}|${window.start}|${window.end}`,kind:'daily-rain',sourceId:'daily-rain',time:year,url:`https://data.weather.gov.hk/weatherAPI/cis/csvfile/HKO/${year}/daily_HKO_RF_${year}.csv`});
 sources.push({id:'daily-rain',status:'candidate-files-not-yet-verified',candidateFiles:years.length});
 let hours=0;
 for(let at=Math.floor(Date.parse(window.from)/HOUR)*HOUR;at<=Date.parse(window.to);at+=HOUR){const time=hktVersion(at);jobs.push({key:'recover-v1|regional-rain|'+time,kind:'regional-rain',sourceId:'regional-rain',time,url:regionalRainUrl(time)});hours++;}
 sources.push({id:'regional-rain',status:'candidates-not-yet-verified',candidateHours:hours});
 return {version:1,window,sources,jobs};
}
async function runRecovery(plan,{preview=false,store,fetch=networkClient(),onProgress=()=>{}}={}){
 const result={mode:preview?'preview':'recovery',window:plan.window,startedAt:new Date().toISOString(),plannedJobs:plan.jobs.length,listedArchiveVersions:plan.sources.reduce((n,s)=>n+(s.versions||0),0),minimumRequestSeconds:Math.ceil(plan.jobs.length/2),importedJobs:0,skippedJobs:0,failedJobs:0,unavailableJobs:0,records:0,inserted:0,retainedReports:0,sources:plan.sources.map(s=>({...s,importedJobs:0,skippedJobs:0,failedJobs:0,unavailableJobs:0,records:0,inserted:0,dates:[]})),failures:[],resumeArguments:`--from ${plan.window.from} --to ${plan.window.to}`};
 if(preview)return result;if(!store)throw new Error('Recovery requires a database store; use --preview to inspect without MongoDB');
 let next=0,done=0;
 const worker=async()=>{while(next<plan.jobs.length){const job=plan.jobs[next++],source=result.sources.find(s=>s.id===job.sourceId);let field;
  try{
   const completed=await store.completed(job);
   if(completed){field='skippedJobs';if(source&&typeof completed==='object'){source.checkpointRecords=(source.checkpointRecords||0)+(completed.records||0);source.dates=[...new Set([...source.dates,...(completed.dates||[])])].sort();}}
   else{const response=await fetch(job.url),value=await store.write(job,response,plan.window);await store.mark(job,value);field='importedJobs';
    for(const key of ['records','inserted','retainedReports'])result[key]+=value[key]||0;
    if(source){source.records+=value.records||0;source.inserted+=value.inserted||0;source.dates=[...new Set([...source.dates,...(value.dates||[])])].sort();if(value.details)source.lastDetails=value.details;}
   }
  }catch(e){field=[404,410].includes(statusOf(e))?'unavailableJobs':'failedJobs';result.failures.push({key:job.key,source:job.sourceId,status:statusOf(e),error:e.message});await store.failure(job,e);}
  result[field]++;if(source)source[field]++;done++;if(done%25===0||done===plan.jobs.length)onProgress({stage:'recovery',done,total:plan.jobs.length,imported:result.importedJobs,skipped:result.skippedJobs,failed:result.failedJobs,unavailable:result.unavailableJobs});
 }};
 const workers=await Promise.allSettled([worker(),worker()]);const rejected=workers.filter(r=>r.status==='rejected');if(rejected.length)throw new AggregateError(rejected.map(r=>r.reason),'Recovery database/checkpoint failure; rerun the same fixed window');
 const requested=history.dateRange(plan.window.start,plan.window.end);
 for(const source of result.sources)source.datesWithoutRecoveredObservations=requested.filter(d=>!source.dates.includes(d));
 result.finishedAt=new Date().toISOString();return result;
}
module.exports={parseOptions,networkClient,listVersions,selectedCameras,discover,runRecovery,hktDay,statusOf,archiveFile};
