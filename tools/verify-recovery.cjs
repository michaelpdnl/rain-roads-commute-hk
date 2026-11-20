'use strict';
// Explicit, small real-source verification. Never a full-window backfill.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {CityService,SOURCES}=require('../lib/service.cjs'),history=require('../lib/history.cjs');
const {createStore}=require('../lib/recovery-store.cjs');
const {archiveFile,networkClient,listVersions,selectedCameras,runRecovery,discover}=require('../lib/recovery.cjs');
async function verify(){
 if(!process.argv.includes('--real'))throw Error('Use --real to authorize a few real-source downloads into a temporary test database.');
 if(!process.env.MONGO_URI)throw Error('Run inside the Compose network with MONGO_URI.');
 const name='rain_roads_test_recovery_'+crypto.randomBytes(5).toString('hex');
 assert.match(name,/^rain_roads_test_recovery_[a-f0-9]{10}$/);assert.notEqual(name,process.env.MONGO_DB);
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),name+'_'));
 const s=new CityService({dbName:name,dataDir:directory}),fetch=networkClient();
 const window={from:'2026-09-22T16:00:00.000Z',to:'2026-11-19T15:59:59.999Z',start:'20260923',end:'20261119'};
 const jobs=[
  {key:'real-traffic',kind:'traffic',sourceId:'traffic',time:'20261118-0000',url:archiveFile(SOURCES.traffic.url,'20261118-0000')},
  {key:'real-rss',kind:'weather-rss-full',sourceId:'weather-rss',time:'20261118-0005',url:archiveFile(history.RSS_URL,'20261118-0005')},
  {key:'real-wet',kind:'regional-rain',sourceId:'regional-rain',time:'20260923-0900',url:'https://www.hko.gov.hk/dps/wxinfo/rainfall/archive/rf_record_202609230900e.htm'},
  {key:'real-dry',kind:'regional-rain',sourceId:'regional-rain',time:'20261118-0000',url:'https://www.hko.gov.hk/dps/wxinfo/rainfall/archive/rf_record_202611180000e.htm'},
  {key:'real-daily',kind:'daily-rain',sourceId:'daily-rain',time:'2026',url:history.DAILY_URL}
 ];
 try{
  await s.init();console.log('Isolated database: '+name);
  // Exercise the production discovery path, then fetch exactly its wet/dry rainfall jobs.
  for(const time of ['20260923-0900','20261118-0000']){
   const {versionTime}=require('../lib/historical-weather.cjs'),at=versionTime(time);
   const p=await discover({from:at,to:at,start:time.slice(0,8),end:time.slice(0,8)},{cameras:[],fetch:async()=>({body:Buffer.from('{"version-count":0,"timestamps":[]}')})});
   const discovered=p.jobs.find(j=>j.kind==='regional-rain'&&j.time===time),index=jobs.findIndex(j=>j.kind==='regional-rain'&&j.time===time);
   assert.equal(discovered.url,jobs[index].url);jobs[index]=discovered;
  }
  const plan={window,jobs,sources:[...new Set(jobs.map(j=>j.sourceId))].map(id=>({id,status:'sample-only'}))},store=createStore(s,window);
  const first=await runRecovery(plan,{store,fetch});assert.equal(first.failedJobs,0,JSON.stringify(first.failures));assert.equal(first.unavailableJobs,0,JSON.stringify(first.failures));
  const counts={};for(const collection of ['traffic','weather','district_rain','daily_rain','weather_archive','camera_frames'])counts[collection]=await s.db.collection(collection).countDocuments();
  assert.ok(counts.traffic>0);assert.ok(counts.daily_rain>0);assert.equal(counts.weather,1);assert.equal(counts.weather_archive,3);assert.equal(counts.camera_frames,0);
  const weather=await s.db.collection('weather').findOne();assert.equal(weather.temperature.data.find(r=>r.place==='Hong Kong Observatory').value,25);assert.equal(weather.humidity.data[0].value,83);assert.equal(weather.ts,'2026-11-17T16:00:00.000Z');assert.ok(weather.temperature.data.length>1);
  const wet=await s.db.collection('district_rain').findOne({d:'Sha Tin'});assert.equal(wet.mm,4);assert.equal(wet.ts,'2026-09-23T01:45:00.000Z');assert.equal(wet.publishedAt,undefined);
  const dry=await s.db.collection('weather_archive').findOne({_id:'regional|20261118-0000'});assert.equal(dry.report.rows.length,0);assert.equal(dry.report.statement,'no-rain-without-explicit-window');
  // Re-running is idempotent; annual mutable files are refreshed, not permanently skipped.
  const second=await runRecovery(plan,{store,fetch});assert.equal(second.skippedJobs,4);assert.equal(second.importedJobs,1);assert.equal(second.inserted,0);
  for(const [collection,count] of Object.entries(counts))assert.equal(await s.db.collection(collection).countDocuments(),count);
  // Insert-only import must preserve existing live facts, including known publication time.
  await s.db.collection('district_rain').updateOne({_id:wet._id},{$set:{publishedAt:'2026-09-23T01:46:00.000Z',preservationCheck:true}});
  await store.write(jobs[2],await fetch(jobs[2].url));assert.equal((await s.db.collection('district_rain').findOne({_id:wet._id})).publishedAt,'2026-09-23T01:46:00.000Z');
  const optional=[],oneDay={from:'2026-11-17T16:00:00.000Z',to:'2026-11-18T15:59:59.999Z',start:'20261118',end:'20261118'};
  for(const [id,url] of [['station-rain',SOURCES.rain.url],['weather-json',SOURCES.weather.url],...(await selectedCameras(fetch)).map(c=>['camera:'+c.id,c.url])]){
   const result=await listVersions(url,oneDay,fetch);optional.push({id,versions:result.timestamps.length,errors:result.errors});
   // If a provider adds an archive, fail this verification until an actual import test is added.
   assert.equal(result.timestamps.length,0,'New archive available: extend real recovery test for '+id);
   assert.ok(result.errors.every(e=>[400,404,410].includes(e.status))&&result.errors.length,'Source check had a transient/schema failure: '+id);
  }
  console.log(JSON.stringify({verified:true,sampleJobs:jobs.length,counts,secondRun:{skipped:second.skippedJobs,inserted:second.inserted},optional,fullMonthRecoveryRun:false},null,2));
 }finally{
  try{if(s.db&&/^rain_roads_test_recovery_[a-f0-9]{10}$/.test(name))await s.db.dropDatabase();}finally{await s.close();await fs.rm(directory,{recursive:true,force:true});console.log('Temporary database and downloaded sample files removed.');}
 }
}
if(require.main===module)verify().catch(e=>{console.error(e.stack);process.exitCode=1;});
