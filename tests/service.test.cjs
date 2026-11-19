'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CityService,request}=require('../lib/service.cjs');
test('HTTP reader follows redirects and rejects bad status without losing TLS checks',async()=>{
 const server=require('node:http').createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{Location:'/data'});res.end();}else if(req.url==='/data'){res.end('actual body');}else{res.writeHead(503);res.end('unavailable');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{assert.equal((await request(base+'/redirect')).body.toString(),'actual body');await assert.rejects(request(base+'/fail'),/HTTP 503/);}finally{await new Promise(r=>server.close(r));}
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
