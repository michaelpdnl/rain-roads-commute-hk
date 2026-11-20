'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
function importer(){const file=path.join(__dirname,'../lib/recovery-store.cjs');assert.ok(fs.existsSync(file),'historical importer is not implemented');return require(file);}
const window={from:'2026-09-01T00:00:00.000Z',to:'2026-11-19T15:59:59.999Z',start:'20260901',end:'20261119'};
const job={key:'test',kind:'daily-rain',time:'2026',url:'https://official.test/2026.csv'};
test('Daily recovery preserves native daily resolution and reports unpublished requested dates',async()=>{
 const {parseJob}=importer();const r=await parseJob(job,Buffer.from('2026,10,31,Trace,C\n2026,11,1,***,\n2026,11,2,5.0,C'),window,[]);
 assert.equal(r.groups.daily_rain.length,3);assert.equal(r.groups.daily_rain[0].trace,true);assert.equal(r.groups.daily_rain[0].mm,null);
 assert.equal(r.groups.daily_rain[1].mm,null);assert.equal(r.groups.daily_rain[2].resolution,'day');assert.equal(r.groups.daily_rain[2].source,job.url);
 assert.equal(r.details.lastPublishedDate,'20261102');assert.ok(r.details.unpublishedDates>0);assert.ok(r.details.unusableDates>0);
});
test('RSS recovery retains the full report even without hourly regional rain',async()=>{
 const {parseJob}=importer();const xml='<rss><channel><item><pubDate>Tue, 17 Nov 2026 16:02:00 GMT</pubDate><description><![CDATA[At midnight at the Hong Kong Observatory: Air temperature : 25 degrees Celsius Relative Humidity : 83 per cent]]></description></item></channel></rss>';
 const r=await parseJob({...job,kind:'weather-rss-full',time:'20261118-0005'},Buffer.from(xml),window,[]);
 assert.equal(r.groups.weather[0].ts,'2026-11-17T16:00:00.000Z');assert.equal(r.groups.weather[0].humidity.data[0].value,83);
 assert.equal(r.groups.district_rain.length,0);assert.equal(r.groups.weather_archive.length,1);assert.equal(r.retainedReports,1);
});
test('Recovery excludes out-of-window observations, rejects unrelated payloads and keeps unbounded dry text only',async()=>{
 const {parseJob}=importer();const narrow={...window,from:'2026-11-01T00:00:00.000Z',start:'20261101'};
 assert.equal((await parseJob(job,Buffer.from('2026,10,31,2,C'),narrow,[])).groups.daily_rain.length,0);
 await assert.rejects(parseJob(job,Buffer.from('<html>Error</html>'),window,[]),/daily/i);
 const dry=await parseJob({...job,kind:'regional-rain',time:'20261118-0000'},Buffer.from('Rainfall Recorded in Various Regions of Hong Kong. There is currently no rainfall recorded in various regions of Hong Kong.'),window,[]);
 assert.equal(dry.groups.district_rain.length,0);assert.equal(dry.groups.weather_archive.length,1);assert.equal(dry.retainedReports,1);
});
test('Station/JSON recovery keeps native times and values; camera archives require a real JPEG',async()=>{
 const {parseJob}=importer(),ts='2026-11-17T16:00:00.000Z';
 const station=await parseJob({...job,kind:'rain'},Buffer.from(JSON.stringify({obsTime:ts,hourlyRainfall:[{automaticWeatherStationID:'HKO',value:'***',unit:'mm'}]})),window,[]);
 assert.equal(station.groups.station_rain[0].mm,null);assert.equal(station.groups.station_rain[0].ts,ts);
 const weather=await parseJob({...job,kind:'weather'},Buffer.from(JSON.stringify({updateTime:ts,rainfall:{data:[{place:'Sha Tin',max:3}],endTime:ts}})),window,[]);
 assert.equal(weather.groups.district_rain[0].mm,3);
 await assert.rejects(parseJob({...job,kind:'camera-archive',time:'20261118-0000',camera:{id:'A',d:'Sha Tin'}},Buffer.from('<html>gone</html>'),window,[]),/JPEG/);
});
test('Mongo recovery deduplicates, scopes boundary checkpoints, refreshes daily files and preserves existing observations', {skip:process.env.INTEGRATION!=='1'},async()=>{
 const {CityService}=require('../lib/service.cjs'),{createStore}=importer(),fsp=require('node:fs/promises'),os=require('node:os');
 const name='rain_roads_test_'+require('node:crypto').randomBytes(5).toString('hex'),directory=await fsp.mkdtemp(path.join(os.tmpdir(),name));
 const s=new CityService({dbName:name,dataDir:directory});s.metadataRefresh=async()=>{s.metadata=[];s.cameras=[];};
 try{
  await s.init();const store=createStore(s,window),j={...job,kind:'rain',time:'20261118-0000'};
  const response={body:Buffer.from(JSON.stringify({obsTime:'2026-11-18T00:00:00+08:00',hourlyRainfall:[{automaticWeatherStationID:'HKO',value:2,unit:'mm'}]}))};
  const r=await store.write(j,response);assert.equal(r.inserted,1);await store.mark(j,r);assert.equal((await store.completed(j)).records,1);
  assert.equal(await createStore(s,{...window,from:'2026-10-01T00:00:00.000Z'}).completed(j),false);
  await s.db.collection('station_rain').updateOne({_id:'HKO|2026-11-17T16:00:00.000Z'},{$set:{mm:9}});
  assert.equal((await store.write(j,response)).inserted,0);assert.equal((await s.db.collection('station_rain').findOne()).mm,9);
  await store.mark(job,{records:1});assert.equal(await store.completed(job),false);
  await store.failure(j,Error('temporary'));assert.equal(await store.completed(j),false);
 }finally{try{if(s.db&&/^rain_roads_test_[a-f0-9]{10}$/.test(name))await s.db.dropDatabase();}finally{await s.close();await fsp.rm(directory,{recursive:true,force:true});}}
});
