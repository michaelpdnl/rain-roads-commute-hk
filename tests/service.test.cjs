'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CityService,request}=require('../lib/service.cjs');
test('HTTP reader follows redirects and rejects bad status without losing TLS checks',async()=>{
 const server=require('node:http').createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{Location:'/data'});res.end();}else if(req.url==='/data'){res.end('actual body');}else{res.writeHead(503);res.end('unavailable');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{assert.equal((await request(base+'/redirect')).body.toString(),'actual body');await assert.rejects(request(base+'/fail'),/HTTP 503/);}finally{await new Promise(r=>server.close(r));}
});

test('Historical RSS imports are deduplicated, keep unknown rain unknown, and do not replace live feed health',{skip:process.env.INTEGRATION!=='1'},async()=>{
 const name='rain_roads_test_'+require('node:crypto').randomBytes(5).toString('hex');const s=new CityService({dbName:name,dataDir:'/tmp/'+name});
 s.metadataRefresh=async()=>{s.metadata=[];s.cameras=[];};
 try{await s.init();assert.equal(typeof s.ingestHistorical,'function');
  await s.health('weather',true,'',{observedAt:'2026-11-20T00:00:00.000Z'});
  const xml='<rss><channel><item><pubDate>Fri, 02 Oct 2026 22:02:00 GMT</pubDate><description><![CDATA[Between 4:45 and 5:45 a.m., the rainfall recorded in various regions were:<table><tr><td>Sha Tin</td><td>1 to 7 mm.</td></tr></table>]]></description></item></channel></rss>';
  const provenance={requestedTime:'20261003-0605',archive:'official-test-fixture'};
  assert.equal((await s.ingestHistorical('weather-rss',xml,provenance)).inserted,1);assert.equal((await s.ingestHistorical('weather-rss',xml,provenance)).inserted,0);
  assert.equal(await s.db.collection('district_rain').countDocuments(),1);assert.equal((await s.db.collection('district_rain').findOne({d:'Sha Tin'})).mm,7);
  assert.equal((await s.db.collection('feed_health').findOne({_id:'weather'})).observedAt,'2026-11-20T00:00:00.000Z');
 }finally{if(s.db)await s.db.dropDatabase();await s.close();}
});

test('Research retains older wet history beyond latest 24000 records and real alert episodes deduplicate',{skip:process.env.INTEGRATION!=='1'},async()=>{
 const name='rain_roads_test_'+require('node:crypto').randomBytes(5).toString('hex');const s=new CityService({dbName:name,dataDir:'/tmp/'+name});
 s.metadataRefresh=async()=>{s.metadata=[{id:'TEST1',d:'Sha Tin',road:'Fixture',lat:22.4,lon:114.2}];s.cameras=[];};
 try{await s.init();const base={id:'TEST1',d:'Sha Tin',road:'Fixture',lat:22.4,lon:114.2,speed:60,volume:3,occupancy:15,valid:true,hasVehicles:true};
  const recent=Array.from({length:24001},(_,i)=>({...base,_id:'recent'+i,ts:new Date(Date.now()-i*30000).toISOString()}));
  await s.db.collection('traffic').insertMany([...recent,{...base,_id:'old-wet',ts:'2026-10-03T05:00:00.000Z',speed:20}]);
  await s.db.collection('district_rain').insertOne({_id:'old-rain',d:'Sha Tin',ts:'2026-10-03T04:45:00.000Z',mm:7});
  const state=await s.snapshot();assert.ok(state.research,'Research panel data must be implemented');assert.ok(state.research.impact.wet>0,'Earlier rain must not disappear behind the latest 24000 records');
  assert.equal(state.research.heatmap.length,7);assert.equal(state.research.forecast.models.length,3);assert.equal(state.loop.decisions,0);
  assert.equal(typeof s.recordAlerts,'function');const low=[{...base,speed:10,ts:new Date().toISOString()}];await s.recordAlerts(low);await s.recordAlerts(low);assert.equal(await s.db.collection('alerts').countDocuments(),1);
 }finally{if(s.db)await s.db.dropDatabase();await s.close();}
});
test('Real MongoDB: ingestion deduplicates, rainfall joins, failure preserves data, decisions evaluate', {skip:process.env.INTEGRATION!=='1'},async()=>{
 const name='rain_roads_test_'+require('node:crypto').randomBytes(5).toString('hex');
 const s=new CityService({dbName:name,dataDir:'/tmp/'+name});
 s.metadataRefresh=async()=>{s.metadata=[{id:'TEST1',d:'Sha Tin',road:'TEST fixture only',lat:22.4,lon:114.2}];s.cameras=[];};
 try{
  await s.init();const ts=new Date(Date.now()-120000).toISOString(),hkt=new Date(Date.parse(ts)+8*3600000).toISOString(),date=hkt.slice(0,10),to=hkt.slice(11,19);
  const xml=`<raw_speed_volume_list><date>${date}</date><periods><period><period_to>${to}</period_to><detectors><detector><detector_id>TEST1</detector_id><lanes><lane><speed>50</speed><volume>5</volume><occupancy>12</occupancy><valid>Y</valid></lane></lanes></detector></detectors></period></periods></raw_speed_volume_list>`;
  assert.equal((await s.ingest('traffic',xml)).inserted,1);assert.equal((await s.ingest('traffic',xml)).inserted,0);
  const rainTs=new Date(Date.parse(ts)-60000).toISOString();await s.ingest('weather',{updateTime:rainTs,rainfall:{endTime:rainTs,data:[{place:'Sha Tin',max:0}]}});
  let snapshot=await s.snapshot();assert.equal(snapshot.meta.records,1);assert.equal(snapshot.analysis.paired,1);assert.equal(snapshot.analysis.dry,1);assert.equal(snapshot.analysis.rainFit,null);
  await assert.rejects(s.ingest('traffic','broken',503),/503/);snapshot=await s.snapshot();assert.equal(snapshot.meta.records,1);assert.equal(snapshot.health.find(h=>h.kind==='traffic').ok,false);
  await assert.rejects(s.decision({action:'dispatch-a-bus',detectorId:'TEST1'}),/valid/);
  const decision=await s.decision({action:'observe',detectorId:'TEST1'});assert.equal(decision.verdict,'pending');
  await s.db.collection('decisions').updateOne({_id:decision._id},{$set:{outcomeAt:new Date(Date.parse(ts)-1000).toISOString(),initialSpeed:10}});
  s.cache=null;snapshot=await s.snapshot();assert.equal(snapshot.decisions[0].verdict,'faster');assert.equal(snapshot.decisions[0].outcomeSpeed,50);
  await s.db.collection('decisions').insertMany(Array.from({length:30},(_,i)=>({_id:`new-${i}`,ts:new Date().toISOString(),verdict:'similar'})));
  await s.db.collection('decisions').insertOne({...decision,_id:'older-pending',ts:new Date(Date.now()-3600000).toISOString(),outcomeAt:new Date(Date.parse(ts)-1000).toISOString(),initialSpeed:10,verdict:'pending'});
  s.cameras=[{id:'TESTCAM',d:'Sha Tin',name:'Fixture camera'}];
  await s.db.collection('camera_status').insertOne({_id:'TESTCAM',id:'TESTCAM',ok:false,lastSuccess:new Date(Date.now()-3600000).toISOString()});
  s.cache=null;snapshot=await s.snapshot();const problems=[];
  if((await s.db.collection('decisions').findOne({_id:'older-pending'})).verdict!=='faster')problems.push('Older pending decisions must evaluate beyond the latest-30 display limit');
  if(snapshot.cameras[0].fresh!==false)problems.push('A failed or old camera capture must be explicitly marked stale');
  assert.deepEqual(problems,[]);assert.equal(snapshot.decisions.length,30);
  assert.equal((await s.replay(snapshot.meta.latestTs)).detectors.length,1);await assert.rejects(s.replay('invalid'),/Invalid/);
  await assert.rejects(s.snapshot({district:'Unknown'}),/Unknown district/);
  await assert.rejects(s.snapshot({period:'invalid'}),/Unknown period/);
 }finally{if(s.db&&/^rain_roads_test_[a-f0-9]{10}$/.test(name))await s.db.dropDatabase();await s.close();}
});
