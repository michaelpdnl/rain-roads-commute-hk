'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {CityService,request}=require('../lib/service.cjs');
const feedback=require('../lib/feedback.cjs');
const integration={skip:process.env.INTEGRATION!=='1'};
const MINUTE=60000,DAY=86400000;
const iso=value=>new Date(value).toISOString();
const closeTo=(actual,expected,label)=>{assert.ok(Number.isFinite(actual),`${label} must be finite`);assert.ok(Math.abs(actual-expected)<1e-10,`${label}: expected ${expected}, received ${actual}`);};
const row=(id,ts,speed=60,extra={})=>({_id:`${id}|${ts}`,id,d:'Sha Tin',road:'TEST fixture only',lat:22.4,lon:114.2,ts,speed,volume:5,occupancy:20,valid:true,hasVehicles:true,...extra});
const referenceDays=(id,at,count=12)=>Array.from({length:count},(_,i)=>row(id,iso(Date.parse(at)-(i+1)*DAY)));
function invalidate(s){s.cache=null;s.researchCache.clear();}
function originalWorker(state,name){
 assert.equal(state.research.methods?.available,true,state.research.methods?.reason||'The actual original-method worker must run');
 assert.equal(state.research.source?.storage,'MongoDB');
 assert.equal(state.research.source?.database,name,'The analytics worker must read this isolated test database');
}
async function fixture(metadata=[]){
 assert.ok(process.env.MONGO_URI,'INTEGRATION=1 requires an actual MongoDB MONGO_URI');
 const name='rain_roads_test_'+require('node:crypto').randomBytes(5).toString('hex');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),name+'_'));
 const s=new CityService({dbName:name,dataDir:directory});
 // Only external metadata downloads are replaced; Mongo writes and analytics remain real.
 s.metadataRefresh=async()=>{s.metadata=metadata;s.cameras=[];};
 return {s,name,async close(){
  try{if(s.db&&/^rain_roads_test_[a-f0-9]{10}$/.test(name))await s.db.dropDatabase();}finally{await s.close();await fs.rm(directory,{recursive:true,force:true});}
 }};
}

test('HTTP reader follows redirects and rejects bad source status',async()=>{
 const server=require('node:http').createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{Location:'/data'});res.end();}else if(req.url==='/data'){res.end('actual body');}else{res.writeHead(503);res.end('unavailable');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{assert.equal((await request(base+'/redirect')).body.toString(),'actual body');await assert.rejects(request(base+'/fail'),/HTTP 503/);}finally{await new Promise(r=>server.close(r));}
});

test('Legacy backup restores without optional collections and rejects missing required traffic',integration,async()=>{
 const {execFileSync}=require('node:child_process'),f=await fixture(),{s,name}=f;
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),name+'_backup_')),source=path.join(folder,'source'),target=path.join(folder,'target');
 try{await s.init();await fs.mkdir(path.join(source,'cameras'),{recursive:true});
  const legacy=['detectors','camera_metadata','traffic','district_rain','station_rain','weather','feed_health','camera_frames','camera_status','decisions','imports'];
  for(const n of legacy)await fs.writeFile(path.join(source,n+'.jsonl'),n==='traffic'?JSON.stringify({_id:'fixture-only',speed:42})+'\n':'');
  const run=()=>execFileSync(process.execPath,['tools/data.cjs','restore',source],{env:{...process.env,MONGO_DB:name,APP_DATA_DIR:target},encoding:'utf8',stdio:['ignore','pipe','pipe']});
  run();run();assert.equal(await s.db.collection('traffic').countDocuments(),1);
  await fs.unlink(path.join(source,'traffic.jsonl'));assert.throws(run,/Command failed/);
 }finally{await f.close();await fs.rm(folder,{recursive:true,force:true});}
});

test('Historical RSS deduplicates, leaves unlisted rain unknown and preserves live health',integration,async()=>{
 const f=await fixture(),{s}=f;
 try{await s.init();const healthTs=iso(Date.now()-MINUTE);await s.health('weather',true,'',{observedAt:healthTs});
  const xml='<rss><channel><item><pubDate>Fri, 02 Oct 2026 22:02:00 GMT</pubDate><description><![CDATA[Between 4:45 and 5:45 a.m., the rainfall recorded in various regions were:<table><tr><td>Sha Tin</td><td>1 to 7 mm.</td></tr></table>]]></description></item></channel></rss>';
  const provenance={requestedTime:'20261003-0605',archive:'official-test-fixture'};
  assert.equal((await s.ingestHistorical('weather-rss',xml,provenance)).inserted,1);
  assert.equal((await s.ingestHistorical('weather-rss',xml,provenance)).inserted,0);
  assert.equal(await s.db.collection('district_rain').countDocuments(),1);
  assert.equal((await s.db.collection('district_rain').findOne({d:'Sha Tin'})).mm,7);
  assert.equal(await s.db.collection('district_rain').findOne({d:'Yuen Long'}),null);
  assert.equal((await s.db.collection('feed_health').findOne({_id:'weather'})).observedAt,healthTs);
 }finally{await f.close();}
});

test('Original research reads older wet raw periods beyond the latest 24000 display records',integration,async()=>{
 const f=await fixture(),{s,name}=f;
 try{await s.init();const now=Date.now()-2*MINUTE,old=iso(now-40*DAY);
  const recent=Array.from({length:24001},(_,i)=>row('RECENT',iso(now-i*30000)));
  await s.db.collection('traffic').insertMany([...recent,...referenceDays('OLD-WET',old),row('OLD-WET',old,20)]);
  await s.db.collection('district_rain').insertOne({_id:'old-rain',d:'Sha Tin',ts:iso(Date.parse(old)-MINUTE),mm:7,resolutionMinutes:60});
  const state=await s.snapshot();originalWorker(state,name);
  assert.equal(state.research.source.observations,24014);
  assert.equal(state.research.impact.wet,1,'Original inference must retain the older eligible wet period');
  assert.equal(state.research.impact.n,1);
  assert.equal(state.research.impact.model,null,'One detector and one wet period do not support the original controlled model');
  assert.equal(state.research.heatmap.length,7);assert.equal(state.research.forecast.models.length,3);assert.equal(state.loop.decisions,0);
 }finally{await f.close();}
});

test('Actual Mongo ingestion joins rain, preserves data on feed failure and requires an alert-linked original action',integration,async()=>{
 const f=await fixture([{id:'TEST1',d:'Sha Tin',road:'TEST fixture only',lat:22.4,lon:114.2}]),{s,name}=f;
 try{await s.init();const ts=iso(Math.floor((Date.now()-2*MINUTE)/1000)*1000),hkt=iso(Date.parse(ts)+8*60*MINUTE);
  const xml=`<raw_speed_volume_list><date>${hkt.slice(0,10)}</date><periods><period><period_to>${hkt.slice(11,19)}</period_to><detectors><detector><detector_id>TEST1</detector_id><lanes><lane><speed>50</speed><volume>5</volume><occupancy>12</occupancy><valid>Y</valid></lane></lanes></detector></detectors></period></periods></raw_speed_volume_list>`;
  assert.equal((await s.ingest('traffic',xml)).inserted,1);assert.equal((await s.ingest('traffic',xml)).inserted,0);
  const rainTs=iso(Date.parse(ts)-MINUTE),weather=mm=>({updateTime:rainTs,rainfall:{endTime:rainTs,data:[{place:'Sha Tin',max:mm}]}});
  await s.ingest('weather',weather(0));let state=await s.snapshot();originalWorker(state,name);
  assert.equal(state.meta.records,1);assert.equal(state.analysis.paired,1);assert.equal(state.analysis.dry,1);assert.equal(state.analysis.rainFit,null);
  assert.equal(state.detectors[0].ci,null,'Insufficient hourly history must not acquire a substitute CI');
  await assert.rejects(s.ingest('traffic','broken',503),/503/);state=await s.snapshot();
  assert.equal(state.meta.records,1);assert.equal(state.health.find(h=>h.kind==='traffic').ok,false);
  assert.equal((await s.db.collection('traffic').findOne({id:'TEST1'})).speed,50);
  await assert.rejects(s.decision({actor:'commuter',action:'leave-now',detectorId:'TEST1'}),/alertId/);

  await s.db.collection('traffic').insertMany(referenceDays('TEST1',ts,36));await s.ingest('weather',weather(0));invalidate(s);
  state=await s.snapshot();originalWorker(state,name);closeTo(state.detectors[0].ci,1/6,'Current CI');
  const latest=await s.db.collection('traffic').findOne({id:'TEST1',ts});
  await s.ingest('weather',weather(0));await s.recordAlerts([latest]);
  assert.equal(await s.db.collection('alerts').countDocuments(),0,'CI above P90 without rain or a matching crossing forecast must not trigger an alert');
  await s.ingest('weather',weather(2));
  await s.recordAlerts([latest]);await s.recordAlerts([latest]);
  assert.equal(await s.db.collection('alerts').countDocuments(),1,'Repeated polling must deduplicate an actual alert episode');
  const alert=await s.db.collection('alerts').findOne({});assert.equal(alert.rule,'rain-ci-p90');assert.equal(alert.rain,2);assert.equal(alert.threshold,0);
  await assert.rejects(s.decision({alertId:alert.id,actor:'commuter',action:'observe'}),/valid actor|original action/);
  await assert.rejects(s.decision({alertId:alert.id,actor:'unknown',action:'leave-now'}),/valid actor|original action/);
  await assert.rejects(s.decision({alertId:alert.id,actor:'operator',action:'dispatch-a-bus'}),/valid actor|original action/);
  const decision=await s.decision({alertId:alert.id,actor:'planner',action:'flag-review',initialCI:.99});
  assert.equal(decision.alertId,alert.id);assert.equal(decision.actor,'planner');assert.equal(decision.action,'flag-review');
  closeTo(decision.initialCI,1/6,'Frozen actual CI');assert.equal(decision.verdict,'pending');assert.equal(decision.actualDispatch,false);
  assert.deepEqual(decision.outcomes.map(o=>[o.minutes,o.status,o.realizedCI]),[[30,'pending',null],[60,'pending',null]]);
  await assert.rejects(s.decision({alertId:alert.id,actor:'planner',action:'flag-review'}),/already has a decision/);
  s.cameras=[{id:'TESTCAM',d:'Sha Tin',name:'Fixture camera'}];
  await s.db.collection('camera_status').insertOne({_id:'TESTCAM',id:'TESTCAM',ok:false,lastSuccess:iso(Date.now()-60*MINUTE)});
  s.cache=null;state=await s.snapshot();assert.equal(state.cameras[0].fresh,false);assert.equal(state.loop.decisions,1);assert.equal(state.loop.pending,1);
  assert.equal((await s.replay(ts)).detectors.length,1);await assert.rejects(s.replay('invalid'),/Invalid/);
  await assert.rejects(s.snapshot({district:'Unknown'}),/Unknown district/);await assert.rejects(s.snapshot({period:'invalid'}),/Unknown period/);
  const other=await s.snapshot({district:'Yuen Long'});originalWorker(other,name);assert.equal(other.loop.decisions,0);assert.equal(other.decisions.length,0);assert.equal(other.alerts.length,0);
 }finally{await f.close();}
});

test('Worker detector outlooks cross the original threshold only for the matching source detector',integration,async()=>{
 const f=await fixture(),{s,name}=f;
 try{await s.init();const ts=iso(Math.floor((Date.now()-MINUTE)/(5*MINUTE))*5*MINUTE),ids=['MATCH','WRONG-SOURCE','NETWORK','UNAVAILABLE'];
  const latest=ids.map(id=>row(id,ts));await s.db.collection('traffic').insertMany(ids.flatMap(id=>[...referenceDays(id,ts,30),row(id,ts)]));
  const state=await s.snapshot();originalWorker(state,name);
  // Deterministic adapter input in the Python worker's public contract; not a fitted production prediction.
  // pandas.Timestamp.isoformat omits .000: equal source instants must still match the raw Mongo ISO timestamp.
  const outlook=id=>({id,minutes:30,prediction:.8,baselineCI:0,sourceAt:ts.replace('.000Z','Z'),predictedAt:iso(Date.parse(ts)+30*MINUTE).replace('.000Z','Z'),spatialScope:'detector',available:true});
  s.lastResearch.forecast={...s.lastResearch.forecast,perDetectorOutlooks:[outlook('MATCH'),{...outlook('WRONG-SOURCE'),sourceAt:iso(Date.parse(ts)-MINUTE)},{...outlook('NETWORK'),spatialScope:'network'},{...outlook('UNAVAILABLE'),available:false}]};
  await s.recordAlerts(latest);const alerts=await s.db.collection('alerts').find({}).toArray();
  assert.equal(alerts.length,1);assert.equal(alerts[0].detectorId,'MATCH');assert.equal(alerts[0].rule,'outlook30-crossing');
  assert.equal(alerts[0].ci,0);assert.equal(alerts[0].threshold,0);assert.equal(alerts[0].forecastCI,.8);assert.equal(alerts[0].rain,null);
 }finally{await f.close();}
});

test('Maintenance evaluates actual 30/60-minute CI outcomes beyond the latest 30 displayed decisions',integration,async()=>{
 const f=await fixture(),{s,name}=f;
 try{await s.init();const oldTs=iso(Date.now()-4*60*MINUTE),oldSource=row('HISTORICAL',oldTs,12),sourceCI=.8;
  const alert=feedback.createAlert({...oldSource,ci:sourceCI},{threshold:.5,rain:2,now:oldTs,forecast:{detectorId:'HISTORICAL',minutes:30,ci:.6,sourceAt:oldTs,predictedAt:iso(Date.parse(oldTs)+30*MINUTE)}});
  const decision=feedback.createDecision(alert,{alertId:alert.id,actor:'commuter',action:'leave-now'},{now:oldTs,observation:{...oldSource,ci:sourceCI}});
  const observed30=row('HISTORICAL',iso(Date.parse(oldTs)+30*MINUTE),36),observed60=row('HISTORICAL',iso(Date.parse(oldTs)+60*MINUTE),48);
  const history=[oldSource,observed30,observed60],refs=new Map();
  for(const observation of history)for(const reference of referenceDays(observation.id,observation.ts))refs.set(reference._id,reference);
  const newerTs=iso(Date.now()-2*MINUTE),newerAlerts=[],newerDecisions=[],newerRows=[];
  for(let i=0;i<30;i++){
   const source=row('DISPLAY-'+i,newerTs,12),observation={...source,ci:.8};
   const newerAlert=feedback.createAlert(observation,{threshold:.5,rain:2,now:newerTs});
   newerAlerts.push(structuredClone(newerAlert));newerDecisions.push(structuredClone(feedback.createDecision(newerAlert,{alertId:newerAlert.id,actor:'operator',action:'acknowledge'},{now:newerTs,observation})));
   newerRows.push(source,...referenceDays(source.id,source.ts));
  }
  await s.db.collection('traffic').insertMany([...refs.values(),...history,...newerRows]);
  await s.db.collection('alerts').insertMany([structuredClone(alert),...newerAlerts]);
  await s.db.collection('decisions').insertMany([structuredClone(decision),...newerDecisions]);
  assert.equal((await s.db.collection('decisions').findOne({_id:decision._id})).status,'pending');
  // Build actual hourly references before maintenance; no verdict/outcome field is injected.
  await s.researchData();await s.maintenance();const state=await s.snapshot();originalWorker(state,name);
  assert.equal(state.decisions.length,30);assert.equal(state.decisions.some(d=>d._id===decision._id),false);
  const evaluated=await s.db.collection('decisions').findOne({_id:decision._id});
  assert.equal(evaluated.status,'complete');assert.equal(evaluated.verdict,'improved');assert.equal(evaluated.outcomeKind,'actual');assert.equal(evaluated.causalEffect,null);
  assert.deepEqual(evaluated.outcomes.map(o=>[o.minutes,o.status,o.verdict,o.evidenceKind,o.delta,o.deltaBaseline,o.deltaForecast]),[[30,'evaluated','improved','actual',-.4,-.4,-.2],[60,'evaluated','improved','actual',-.6,-.6,null]]);
  closeTo(evaluated.outcomes[0].realizedCI,.4,'30-minute actual CI');closeTo(evaluated.outcomes[1].realizedCI,.2,'60-minute actual CI');
  assert.equal(evaluated.outcomes[0].observedAt,observed30.ts);assert.equal(evaluated.outcomes[1].observedAt,observed60.ts);
  assert.equal(state.loop.decisions,31);assert.equal(state.loop.evaluated,1);assert.equal(state.loop.actualObservationOutcomes,2);assert.equal(state.loop.pending,30);closeTo(state.loop.outcomeDelta,-.5,'Mean measured horizon delta');
 }finally{await f.close();}
});

test('Replay timeline and map use finite exact raw CI with same-hour P85 history and measured zero',integration,async()=>{
 const f=await fixture(),{s,name}=f;
 try{await s.init();const day=iso(Date.now()-DAY).slice(0,10),rows=[];
  // Twelve previous days per detector/hour, rather than unrelated hours that leave CI missing.
  for(let hour=0;hour<15;hour++)for(let id=0;id<3;id++)rows.push(...referenceDays('D'+id,day+`T${String(hour).padStart(2,'0')}:00:00.000Z`));
  for(let hour=0;hour<14;hour++)for(let id=0;id<3;id++)rows.push(row('D'+id,day+`T${String(hour).padStart(2,'0')}:00:00.000Z`));
  for(const minute of [10,25])for(let id=0;id<3;id++)rows.push(row('D'+id,day+`T14:${minute}:00.000Z`,minute===10?(id===0?0:10+id*5):(id===0?90:50-id*5)));
  const zeroTs=day+'T14:42:00.000Z';rows.push(...referenceDays('ZERO-GATE',zeroTs,11),row('ZERO-GATE',zeroTs,0));
  await s.db.collection('traffic').insertMany(rows);const state=await s.snapshot();originalWorker(state,name);
  assert.ok(state.frames.some(f=>f.ts===day+'T14:10:00.000Z'),'Every exact stored source frame must remain selectable');
  for(const frame of state.frames){const replay=await s.replay(frame.ts);assert.equal(frame.n,replay.detectors.length);closeTo(frame.ci,replay.ci,`${frame.ts} timeline/map CI`);}
  const first=await s.replay(day+'T14:10:00.000Z'),second=await s.replay(day+'T14:25:00.000Z');
  closeTo(first.detectors.find(d=>d.id==='D0').ci,1,'Measured zero CI');closeTo(second.detectors.find(d=>d.id==='D0').ci,-.5,'Unclamped above-P85 CI');
  const zero=await s.replay(zeroTs);assert.equal(zero.detectors[0].baselineN,12);assert.equal(zero.detectors[0].freeFlow,60);assert.equal(zero.ci,1);
  const research=await s.researchData(),profile=research.baselineProfiles.find(([key])=>key==='ZERO-GATE|22');
  assert.deepEqual(profile,['ZERO-GATE|22',{speed:60,n:12}]);
 }finally{await f.close();}
});

test('Concurrent original actions create exactly one decision per alert and retain unlinked legacy records',integration,async()=>{
 const f=await fixture(),{s,name}=f,{MongoClient}=require('mongodb'),seed=new MongoClient(process.env.MONGO_URI);
 try{
  await seed.connect();await seed.db(name).collection('decisions').insertMany([{_id:'legacy-one',action:'observe'},{_id:'legacy-two',action:'observe'}]);await seed.close();
  await s.init();const ts=iso(Date.now()-MINUTE),source=row('CONCURRENT',ts,12);
  await s.db.collection('traffic').insertMany([...referenceDays(source.id,ts),source]);
  const alert=feedback.createAlert({...source,ci:.8},{threshold:.5,rain:2,now:ts});await s.db.collection('alerts').insertOne(structuredClone(alert));
  const results=await Promise.allSettled([
   s.decision({alertId:alert.id,actor:'commuter',action:'leave-now'}),
   s.decision({alertId:alert.id,actor:'commuter',action:'delay20'})
  ]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1,'Two simultaneous original actions cannot both win the same alert');
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  assert.equal(await s.db.collection('decisions').countDocuments({alertId:alert.id}),1);
  assert.equal(await s.db.collection('decisions').countDocuments({alertId:{$exists:false}}),2,'A uniqueness migration must preserve compatible unlinked legacy decisions');
 }finally{await seed.close();await f.close();}
});

test('Legacy speed alerts are retained in storage but excluded from active original CI alerts and loop counts',integration,async()=>{
 const f=await fixture(),{s,name}=f;
 try{await s.init();const ts=iso(Date.now()-MINUTE);
  await s.db.collection('alerts').insertOne({_id:'TEST1|window|speed',id:'TEST1',d:'Sha Tin',road:'Legacy speed alert',ts,speed:10,rule:'slow-speed'});
  const state=await s.snapshot();originalWorker(state,name);
  assert.equal(await s.db.collection('alerts').countDocuments(),1);
  assert.equal(state.alerts.length,0,'A legacy alert lacking the original CI association and expiry cannot remain active');
  assert.equal(state.loop.alerts,0);assert.equal(state.loop.activeAlerts,0);assert.equal(state.loop.decisions,0);
  const legacy=await s.db.collection('alerts').findOne({_id:'TEST1|window|speed'});
  assert.equal(legacy.evaluation,undefined,'Legacy substitutes must not enter original outcome maintenance');
  assert.equal(legacy.status,undefined);
 }finally{await f.close();}
});

test('Research completion evaluates a current forecast at its exact stored source even after a later ingest',integration,async()=>{
 const f=await fixture(),{s,name}=f,previousURL=process.env.ANALYTICS_URL;
 const ts=iso(Math.floor((Date.now()-2*MINUTE)/(5*MINUTE))*5*MINUTE),stale=iso(Date.now()-11*MINUTE),future=iso(Date.now()+DAY);
 const sources=[row('COMPLETION',ts),row('STALE-OUTLOOK',stale),row('FUTURE-OUTLOOK',future)];
 const missingTs=iso(Date.parse(ts)-30000),thresholdProfiles=Object.fromEntries([...sources.map(source=>source.ts),missingTs].map(at=>[`Sha Tin|${new Date(Date.parse(at)+8*60*MINUTE).getUTCHours()}`,0]));
 const forecast=(id,sourceAt)=>({id,sourceAt,minutes:30,prediction:.8,predictedAt:iso(Date.parse(sourceAt)+30*MINUTE),available:true,spatialScope:'detector'});
 let requestedDatabase;
 // This local HTTP fixture controls completion timing and forecast contract only;
 // all other worker integration tests above still call the actual Python service.
 const server=require('node:http').createServer((req,res)=>{
  const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{(async()=>{
   requestedDatabase=JSON.parse(Buffer.concat(chunks)).database;
   // A new source period lands while the original-source forecast is computing.
   await s.db.collection('traffic').insertMany([row('COMPLETION',iso(Date.parse(ts)+30000),30),row('MISSING-ORIGIN',ts)]);
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({methods:{available:true,fixture:true},impact:{model:null},
    thresholdProfiles,forecast:{models:[],perDetectorOutlooks:[forecast('COMPLETION',ts.replace('.000Z','Z')),forecast('MISSING-ORIGIN',missingTs),forecast('STALE-OUTLOOK',stale),forecast('FUTURE-OUTLOOK',future)]}}));
  })().catch(error=>{res.statusCode=500;res.end(error.message);});});
 });
 try{await s.init();await s.db.collection('traffic').insertMany([...sources.flatMap(source=>[...referenceDays(source.id,source.ts),source]),...referenceDays('MISSING-ORIGIN',ts)]);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));process.env.ANALYTICS_URL=`http://127.0.0.1:${server.address().port}`;
  await s.computeResearchData();assert.equal(requestedDatabase,name);
  const alerts=await s.db.collection('alerts').find({}).toArray();assert.equal(alerts.length,1,'A completed matching forecast must trigger the original rule without waiting for another ingest');
  assert.equal(alerts[0].detectorId,'COMPLETION');assert.equal(alerts[0].ts,ts);assert.equal(alerts[0].rule,'outlook30-crossing');
  assert.equal(alerts[0].ci,0,'The later ingested CI must not replace the forecast source CI');assert.equal(alerts[0].forecastCI,.8);
 }finally{if(previousURL===undefined)delete process.env.ANALYTICS_URL;else process.env.ANALYTICS_URL=previousURL;
  if(server.listening)await new Promise(resolve=>server.close(resolve));await f.close();}
});

test('Future raw timestamps cannot enter current P85 references, live map, timeline or decision observations',integration,async()=>{
 const f=await fixture(),{s,name}=f;
 try{await s.init();const ts=iso(Date.now()-MINUTE),source=row('CURRENT',ts,30),future=Array.from({length:12},(_,i)=>row('CURRENT',iso(Date.parse(ts)+(i+1)*DAY),600));
  await s.db.collection('traffic').insertMany([...referenceDays(source.id,ts),source,...future,row('FUTURE-ONLY',iso(Date.now()+DAY),10)]);
  const refs=await s.hourlyReferences(),hour=new Date(Date.parse(ts)+8*60*MINUTE).getUTCHours(),reference=refs.get(`CURRENT|${hour}`),state=await s.snapshot();originalWorker(state,name);
  assert.equal(state.research.source.observations,13,'The actual Python worker already bounds original input by the present');
  const problems=[];
  if(reference?.speed!==60||reference.n!==13)problems.push(`Hourly P85 includes future evidence: ${JSON.stringify(reference)}`);
  if(state.meta.latestTs!==ts)problems.push(`Live latestTs is future-dated: ${state.meta.latestTs}`);
  if(state.detectors.length!==1||state.detectors[0].id!=='CURRENT'||state.detectors[0].ts!==ts)problems.push('Live detectors must contain only the latest actual current source');
  if(state.frames.some(frame=>Date.parse(frame.ts)>Date.now()))problems.push('Replay timeline contains future raw observations');
  const alert=feedback.createAlert({...source,ci:.5},{threshold:.4,rain:2,now:Date.now()});await s.db.collection('alerts').insertOne(structuredClone(alert));
  try{const decision=await s.decision({alertId:alert.id,actor:'planner',action:'flag-review'});if(decision.observedAt!==ts||Math.abs(decision.initialCI-.5)>1e-10)problems.push('Decision used a future source/reference');}
  catch(error){problems.push(`Current decision was displaced by future raw data: ${error.message}`);}
  assert.deepEqual(problems,[]);
 }finally{await f.close();}
});
