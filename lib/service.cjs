'use strict';
const https=require('node:https');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const core=require('./core.cjs');
const history=require('./history.cjs');
const analytics=require('./analytics.cjs');

const SOURCES={
  traffic:{name:'TD traffic',url:'https://resource.data.one.gov.hk/td/traffic-detectors/rawSpeedVol-all.xml',catalog:'https://data.gov.hk/en-data/dataset/hk-td-sm_4-traffic-data-strategic-major-roads',maxAge:300},
  locations:{name:'TD detector locations',url:'https://static.data.gov.hk/td/traffic-data-strategic-major-roads/info/traffic_speed_volume_occ_info.csv',catalog:'https://data.gov.hk/en-data/dataset/hk-td-sm_4-traffic-data-strategic-major-roads',maxAge:172800},
  rain:{name:'HKO station rainfall',url:'https://data.weather.gov.hk/weatherAPI/opendata/hourlyRainfall.php?lang=en',catalog:'https://data.gov.hk/en-data/dataset/hk-hko-rss-rainfall-in-the-past-hour',maxAge:1800},
  weather:{name:'HKO district weather',url:'https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en',catalog:'https://data.gov.hk/en-data/dataset/hk-hko-rss-current-weather-report',maxAge:7200},
  cameras:{name:'TD camera snapshots',url:'https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.csv',catalog:'https://data.gov.hk/en-data/dataset/hk-td-tis_2-traffic-snapshot-images',maxAge:300}
};

function request(url,{maxBytes=5_000_000,timeout=20000,redirects=4}={}){
  return new Promise((resolve,reject)=>{
    const client=url.startsWith('https:')?https:http;
    const req=client.get(url,{headers:{'User-Agent':'COMP7503-RainRoads/1.0','Accept':'*/*'}},res=>{
      if(res.statusCode>=300&&res.statusCode<400&&res.headers.location&&redirects){res.resume();return resolve(request(new URL(res.headers.location,url).href,{maxBytes,timeout,redirects:redirects-1}));}
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){req.destroy(new Error('Source exceeds size limit'));return;}chunks.push(chunk);});
      res.on('end',()=>{if(res.statusCode!==200)return reject(new Error(`HTTP ${res.statusCode} from ${new URL(url).hostname}`));resolve({body:Buffer.concat(chunks),headers:res.headers,url});});
      res.on('error',reject);
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('Source request timed out')));req.on('error',reject);
  });
}

class CityService {
  constructor(options={}) {this.uri=options.uri||process.env.MONGO_URI;this.dbName=options.dbName||process.env.MONGO_DB||'rain_roads';this.dataDir=options.dataDir||process.env.APP_DATA_DIR||'/data/commute';this.cache=null;this.researchCache=new Map();this.researchLoading=new Map();this.loading=null;this.cameraBusy=false;}
  async init(){
    if(this.loading)return this.loading;
    this.loading=(async()=>{
      const {MongoClient}=require('mongodb');
      this.client=new MongoClient(this.uri,{serverSelectionTimeoutMS:12000});await this.client.connect();this.db=this.client.db(this.dbName);
      await fs.mkdir(path.join(this.dataDir,'cameras'),{recursive:true});
      await Promise.all([
        this.db.collection('traffic').createIndex({ts:-1}),this.db.collection('traffic').createIndex({d:1,ts:-1}),
        this.db.collection('district_rain').createIndex({d:1,ts:-1}),this.db.collection('camera_frames').createIndex({id:1,ts:-1}),
        this.db.collection('decisions').createIndex({ts:-1}),this.db.collection('decisions').createIndex({verdict:1,outcomeAt:1}),
        this.db.collection('alerts').createIndex({d:1,ts:-1}),this.db.collection('camera_checks').createIndex({ts:-1})
      ]);
      this.metadata=await this.db.collection('detectors').find({}).toArray();this.cameras=await this.db.collection('camera_metadata').find({}).toArray();
      try{await this.metadataRefresh();}catch(e){await this.health('locations',false,e.message);if(!this.metadata.length)throw e;}
      return this;
    })();
    try{return await this.loading;}catch(e){this.loading=null;throw e;}
  }
  async health(kind,ok,error='',extra={}){
    if(!this.db)return;
    const now=new Date().toISOString();const update={$set:{kind,name:SOURCES[kind]?.name||kind,catalog:SOURCES[kind]?.catalog||'',ok,error:String(error).slice(0,220),lastAttempt:now,...extra}};
    if(ok)update.$set.lastSuccess=now;
    await this.db.collection('feed_health').updateOne({_id:kind},update,{upsert:true});this.cache=null;
  }
  async save(collection,docs){
    if(!docs.length)return {upsertedCount:0};
    const fetchedAt=new Date().toISOString();
    return this.db.collection(collection).bulkWrite(docs.map(doc=>({updateOne:{filter:{_id:doc._id},update:{$set:{...doc,fetchedAt}},upsert:true}})),{ordered:false});
  }
  async metadataRefresh(){
    const response=await request(SOURCES.locations.url);
    const all=core.parseCsv(response.body);
    this.metadata=all.filter(r=>core.STUDY.includes(r.District)).map(r=>({_id:r.AID_ID_Number,id:r.AID_ID_Number,d:r.District,road:r.Road_EN,lat:core.number(r.Latitude),lon:core.number(r.Longitude)})).filter(r=>r.id&&r.lat&&r.lon);
    if(!this.metadata.length)throw new Error('Detector location feed contains no study locations');
    await this.save('detectors',this.metadata);await this.health('locations',true,'',{count:this.metadata.length,networkCount:all.length,observedAt:new Date().toISOString()});
    try{
      const c=core.parseCsv((await request(SOURCES.cameras.url)).body);
      this.cameras=c.filter(r=>core.STUDY.includes(r.district)).map(r=>({_id:r.key,id:r.key,d:r.district,name:r.description,lat:core.number(r.latitude),lon:core.number(r.longitude),url:r.url})).filter(r=>/^[A-Z0-9]+$/.test(r.id)&&/^https:\/\/tdcctv\.data\.one\.gov\.hk\/[A-Z0-9]+\.JPG$/i.test(r.url));
      await this.save('camera_metadata',this.cameras);
    }catch(e){await this.health('cameras',false,e.message);}
  }
  async ingest(kind,body,status=200,provenance=null){
    await this.init();
    if(Number(status)!==200){await this.health(kind,false,`HTTP ${status}`);throw new Error(`${kind} HTTP ${status}`);}
    try{
      let docs=[],collection,observedAt;
      if(kind==='traffic'){
        docs=await core.parseTraffic(Buffer.isBuffer(body)?body.toString('utf8'):body,this.metadata);collection='traffic';
        if(!docs.length)throw new Error('No traffic observations match study metadata');
        observedAt=docs.reduce((v,r)=>r.ts>v?r.ts:v,docs[0].ts);
        if(provenance)docs=docs.map(r=>({...r,provenance}));
      }else{
        const json=typeof body==='object'&&!Buffer.isBuffer(body)?body:JSON.parse(body.toString());
        if(kind==='weather'){
          if(!json.updateTime||!Array.isArray(json.rainfall?.data))throw new Error('Invalid weather payload');
          const ts=new Date(json.rainfall.endTime||json.updateTime).toISOString();
          const rain=json.rainfall.data.filter(r=>core.STUDY.includes(r.place)).map(r=>({_id:`${r.place}|${ts}`,d:r.place,ts,publishedAt:new Date(json.updateTime).toISOString(),mm:core.number(r.max),kind:'district maximum in last hour',source:SOURCES.weather.url}));
          await this.save('district_rain',rain);
          observedAt=new Date(json.updateTime).toISOString();docs=[{...json,_id:observedAt,ts:observedAt,provenance}];collection='weather';
        }else if(kind==='rain'){
          if(!json.obsTime||!Array.isArray(json.hourlyRainfall))throw new Error('Invalid station rainfall payload');
          observedAt=new Date(json.obsTime).toISOString();collection='station_rain';
          docs=json.hourlyRainfall.map(r=>({_id:`${r.automaticWeatherStationID}|${observedAt}`,id:r.automaticWeatherStationID,name:r.automaticWeatherStation,ts:observedAt,mm:core.number(r.value),rawValue:r.value,unit:r.unit,provenance}));
        }else throw new Error('Unknown source');
      }
      const result=await this.save(collection,docs);
      this.researchCache.clear();if(kind==='traffic'&&!provenance)await this.recordAlerts(docs);
      if(!provenance)await this.health(kind,true,'',{observedAt,count:docs.length,inserted:result.upsertedCount});
      this.cache=null;return {kind,count:docs.length,inserted:result.upsertedCount,observedAt};
    }catch(e){if(!provenance)await this.health(kind,false,e.message);throw e;}
  }
  selectedCameras(){return core.STUDY.map(d=>this.cameras.find(c=>c.d===d)).filter(Boolean);}
  async captureCameras(){
    await this.init();if(this.cameraBusy)return {skipped:true};this.cameraBusy=true;
    try{
      const results=await Promise.all(this.selectedCameras().map(async c=>{
        try{
          const response=await request(c.url,{maxBytes:1_000_000,timeout:12000});const bytes=response.body;
          if(bytes[0]!==255||bytes[1]!==216)throw new Error('Source is not JPEG');
          const ts=new Date().toISOString(),file=`${c.id}_${Date.parse(ts)}.jpg`;
          await fs.writeFile(path.join(this.dataDir,'cameras',file),bytes);
          const frame={_id:`${c.id}|${ts}`,id:c.id,d:c.d,ts,file,bytes:bytes.length,sourceModified:response.headers['last-modified']||null};
          await this.save('camera_frames',[frame]);await this.db.collection('camera_checks').insertOne({_id:frame._id,id:c.id,d:c.d,ts,ok:true});await this.db.collection('camera_status').updateOne({_id:c.id},{$set:{id:c.id,d:c.d,ok:true,lastAttempt:ts,lastSuccess:ts,error:''}},{upsert:true});return true;
        }catch(e){const ts=new Date().toISOString();await this.db.collection('camera_checks').insertOne({_id:`${c.id}|${ts}`,id:c.id,d:c.d,ts,ok:false,error:e.message});await this.db.collection('camera_status').updateOne({_id:c.id},{$set:{id:c.id,d:c.d,ok:false,lastAttempt:ts,error:e.message}},{upsert:true});return false;}
      }));
      const count=results.filter(Boolean).length;await this.health('cameras',count>0,count===results.length?'':`${results.length-count} camera requests failed`,{count,total:results.length,observedAt:count?new Date().toISOString():null});return {count,total:results.length};
    }finally{this.cameraBusy=false;}
  }
  async camera(id,at){
    await this.init();if(!this.cameras.some(c=>c.id===id))throw new Error('Unknown camera');
    const query={id};if(at){const parsed=Date.parse(at);if(!Number.isFinite(parsed))throw new Error('Invalid camera timestamp');query.ts={$lte:new Date(parsed).toISOString(),$gte:new Date(parsed-180000).toISOString()};}
    const row=await this.db.collection('camera_frames').findOne(query,{sort:{ts:-1}});if(!row)throw new Error('No captured frame for this time');
    return {body:await fs.readFile(path.join(this.dataDir,'cameras',row.file)),ts:row.ts};
  }
  async snapshot({district='',period='all'}={}){
    await this.init();
    if(district&&!core.STUDY.includes(district))throw new Error('Unknown district');
    if(!['all','peak','off'].includes(period))throw new Error('Unknown period');
    const key=`${district}|${period}`;if(this.cache?.key===key&&Date.now()-this.cache.time<15000)return this.cache.value;
    await this.evaluateDecisions();
    const query=district?{d:district}:{};
    const [raw,rain,weather,health,cameraStatus,decisions,count,stationCount,allDecisions,alertCount,cameraAvailability]=await Promise.all([
      this.db.collection('traffic').find(query).sort({ts:-1}).limit(24000).toArray(),
      this.db.collection('district_rain').find({}).sort({ts:-1}).limit(30000).toArray(),
      this.db.collection('weather').findOne({},{sort:{ts:-1}}),this.db.collection('feed_health').find({}).toArray(),
      this.db.collection('camera_status').find({}).toArray(),this.db.collection('decisions').find(query).sort({ts:-1}).limit(30).toArray(),
      this.db.collection('traffic').estimatedDocumentCount(),this.db.collection('station_rain').estimatedDocumentCount(),
      this.db.collection('decisions').find(query,{projection:{verdict:1}}).toArray(),this.db.collection('alerts').countDocuments(query),
      this.db.collection('camera_checks').aggregate([{$match:{...query,ts:{$gte:new Date(Date.now()-7*86400000).toISOString()}}},{$group:{_id:'$d',attempts:{$sum:1},success:{$sum:{$cond:['$ok',1,0]}},first:{$min:'$ts'},last:{$max:'$ts'}}}]).toArray()
    ]);
    const research=await this.researchData(district,period,rain);
    const joined=core.joinRain(analytics.enrich(raw,research.baselines),rain),analysis=core.analyse(research.selected),latestTs=raw[0]?.ts||null;
    const byId=new Map();for(const row of joined){if(!byId.has(row.id)&&Date.parse(latestTs)-Date.parse(row.ts)<=120000)byId.set(row.id,row);}
    const latest=[...byId.values()];
    const rainDistricts=core.STUDY.map(d=>{const r=rain.find(r=>r.d===d);return {d,mm:r?.mm??null,ts:r?.ts||null};});
    const cameras=this.selectedCameras().filter(c=>!district||c.d===district).map(c=>{const status=cameraStatus.find(s=>s.id===c.id)||{};return {...c,...status,fresh:!!status.ok&&!!status.lastSuccess&&Date.now()-Date.parse(status.lastSuccess)<300000,file:`/api/camera/${c.id}`};});
    const frames=research.timeline.map(r=>({...r,ts:r.observedAt}));
    const alerts=latest.filter(r=>{const h=new Date(Date.parse(r.ts)+8*3600000).getUTCHours(),threshold=research.thresholds[`${r.d}|${h}`];return r.valid&&r.hasVehicles&&(r.speed<20||(r.ci!=null&&threshold!=null&&r.ci>threshold&&r.rain>0));}).sort((a,b)=>(b.ci??0)-(a.ci??0)||a.speed-b.speed).slice(0,8).map(r=>({id:r.id,d:r.d,road:r.road,speed:r.speed,ci:r.ci,occupancy:r.occupancy,rain:r.rain,ts:r.ts,rule:r.speed<20?'Measured speed below 20 km/h':'CI above district/hour P90 with reported rain'}));
    const {baselines,rows,selected,...publicResearch}=research;
    const value={meta:{generatedAt:new Date().toISOString(),latestTs,records:count,stationRecords:stationCount,locations:this.metadata.length,sampleLimit:180000,analysisScope:'Up to 120,000 archived detector/hour snapshots + 60,000 recent live detector/5-minute bins within 90 days; raw records retained',district,period},
      detectors:latest,analysis,rain:{districts:rainDistricts,stationFeed:health.find(h=>h.kind==='rain')||null},weather:weather?{ts:weather.ts,temperature:weather.temperature,humidity:weather.humidity,warningMessage:weather.warningMessage}:null,
      cameras,frames,alerts,decisions,research:publicResearch,loop:analytics.loopStats(alertCount,allDecisions),cameraAvailability,sources:[...Object.values(SOURCES),{name:'HKO archived hourly weather (RSS)',url:history.RSS_URL,catalog:SOURCES.weather.catalog},{name:'HKO daily rainfall (day selection only)',url:history.DAILY_URL,catalog:'https://data.gov.hk/en-data/dataset/hk-hko-rss-daily-total-rainfall'}],health:health.map(h=>({...h,maxAge:SOURCES[h.kind]?.maxAge||3600,fresh:!!h.observedAt&&Date.now()-Date.parse(h.observedAt)<(SOURCES[h.kind]?.maxAge||3600)*1000})),
      trust:{valid:latest.filter(r=>r.valid).length,total:latest.length,coverage:frames,notes:['District rain is the maximum reported within a district, not rainfall at each road.','Source periods are 30 seconds; polling does not observe every intervening period.','Camera health measures successful JPEG retrieval, not image-content availability.','No causal claim or validated forecast is made.']}};
    this.cache={key,time:Date.now(),value};return value;
  }
  async replay(at,district=''){
    await this.init();if(!Number.isFinite(Date.parse(at)))throw new Error('Invalid replay time');
    if(district&&!core.STUDY.includes(district))throw new Error('Unknown district');
    const ts=new Date(at).toISOString();const query={ts};if(district)query.d=district;
    const raw=await this.db.collection('traffic').find(query).toArray(),rain=await this.db.collection('district_rain').find({}).sort({ts:-1}).limit(30000).toArray();
    const research=await this.researchData(district,'all',rain),rows=core.joinRain(analytics.enrich(raw,research.baselines),rain);
    const captures=await this.db.collection('camera_frames').find({ts:{$gte:new Date(Date.parse(ts)-180000).toISOString(),$lte:ts}}).sort({ts:-1}).toArray();
    const cameras=this.selectedCameras().filter(c=>(!district||c.d===district)&&captures.some(f=>f.id===c.id)).map(c=>({...c,lastSuccess:captures.find(f=>f.id===c.id).ts,file:`/api/camera/${c.id}`}));
    return {ts,detectors:rows,cameras,rain:core.mean([...new Map(rows.filter(r=>r.rain!=null).map(r=>[r.d,r.rain])).values()]),ci:core.mean(rows.map(r=>r.ci))};
  }
  async researchData(district='',period='all',rain=null){
    const key=`${district}|${period}`,cached=this.researchCache.get(key);if(cached&&Date.now()-cached.time<180000)return cached.value;
    if(this.researchLoading.has(key))return this.researchLoading.get(key);
    const work=this.computeResearchData(district,period,rain);this.researchLoading.set(key,work);
    try{return await work;}finally{this.researchLoading.delete(key);}
  }
  async computeResearchData(district='',period='all',rain=null){
    const key=`${district}|${period}`,cached=this.researchCache.get(key);if(cached&&Date.now()-cached.time<180000)return cached.value;
    const query={ts:{$gte:new Date(Date.now()-90*86400000).toISOString()}};if(district)query.d=district;
    const usable={$and:[{$eq:['$valid',true]},{$eq:['$hasVehicles',true]},{$ne:['$speed',null]}]};
    const pipeline=(archived,binSize,limit)=>[
      {$match:{...query,'provenance.archive':{$exists:archived}}},{$group:{_id:{id:'$id',bin:{$dateTrunc:{date:{$dateFromString:{dateString:'$ts'}},unit:'minute',binSize}}},id:{$first:'$id'},d:{$first:'$d'},ts:{$max:'$ts'},speedSum:{$sum:{$cond:[usable,{$multiply:['$speed','$volume']},0]}},volume:{$sum:{$cond:[usable,'$volume',0]}},occupancy:{$avg:{$cond:[{$eq:['$valid',true]},'$occupancy',null]}},validCount:{$sum:{$cond:['$valid',1,0]}},records:{$sum:1}}},
      {$project:{_id:0,id:1,d:1,ts:1,volume:1,occupancy:1,validCount:1,records:1,speed:{$cond:[{$gt:['$volume',0]},{$divide:['$speedSum','$volume']},null]},valid:{$gt:['$validCount',0]},hasVehicles:{$gt:['$volume',0]}}},{$sort:{ts:-1}},{$limit:limit}
    ];
    const parts=await Promise.all([this.db.collection('traffic').aggregate(pipeline(true,60,120000),{allowDiskUse:true}).toArray(),this.db.collection('traffic').aggregate(pipeline(false,5,60000),{allowDiskUse:true}).toArray()]);
    const projected=parts.flat();
    if(!rain)rain=await this.db.collection('district_rain').find({}).toArray();const value=analytics.buildResearch(projected,rain,{period});
    // Replay summarizes exact stored frames; detector/hour research bins are a different series.
    value.timeline=await this.replayFrames(query,value.baselines,rain);value.events=analytics.replayEvents(value.timeline);
    this.researchCache.set(key,{time:Date.now(),value});if(this.researchCache.size>2)this.researchCache.delete(this.researchCache.keys().next().value);if(!district&&period==='all')this.lastResearch=value;return value;
  }
  async replayFrames(query,baselines,rain){
    const reference=Object.fromEntries([...baselines].map(([id,b])=>[id,b.speed]));
    const usable={$and:[{$eq:['$valid',true]},{$eq:['$hasVehicles',true]},{$ne:['$speed',null]}]};
    const rows=await this.db.collection('traffic').aggregate([
      {$match:query},{$set:{_base:{$getField:{field:'$id',input:{$literal:reference}}}}},
      {$set:{_ci:{$cond:[{$and:[usable,{$gt:['$_base',0]}]},{$max:[0,{$min:[1,{$subtract:[1,{$divide:['$speed','$_base']}]}]}]},null]}}},
      {$group:{_id:{ts:'$ts',d:'$d'},n:{$sum:1},valid:{$sum:{$cond:['$valid',1,0]}},baselineN:{$sum:{$cond:[{$ne:['$_ci',null]},1,0]}},ciSum:{$sum:'$_ci'},speedSum:{$sum:{$cond:[usable,'$speed',0]}},speedN:{$sum:{$cond:[usable,1,0]}},occupancySum:{$sum:'$occupancy'},occupancyN:{$sum:{$cond:[{$ne:['$occupancy',null]},1,0]}}}},
      {$project:{_id:0,ts:'$_id.ts',d:'$_id.d',n:1,valid:1,baselineN:1,ciSum:1,speedSum:1,speedN:1,occupancySum:1,occupancyN:1}}
    ],{allowDiskUse:true}).toArray();
    const groups=new Map();for(const row of core.joinRain(rows,rain)){if(!groups.has(row.ts))groups.set(row.ts,[]);groups.get(row.ts).push(row);}
    return [...groups].sort((a,b)=>a[0].localeCompare(b[0])).map(([ts,v])=>{const sum=key=>v.reduce((s,r)=>s+r[key],0),baselineN=sum('baselineN'),speedN=sum('speedN'),occupancyN=sum('occupancyN'),wet=v.filter(r=>r.rain!=null);return {ts,observedAt:ts,n:sum('n'),valid:sum('valid'),baselineN,ci:baselineN?sum('ciSum')/baselineN:null,speed:speedN?sum('speedSum')/speedN:null,occupancy:occupancyN?sum('occupancySum')/occupancyN:null,rain:core.mean(wet.map(r=>r.rain)),rainDistricts:wet.length};});
  }
  async recordAlerts(input){
    if(!input.length)return;const max=input.reduce((v,r)=>r.ts>v?r.ts:v,input[0].ts),rows=input.filter(r=>r.ts===max&&r.valid&&r.hasVehicles&&Date.now()-Date.parse(r.ts)<600000);
    const rain=await this.db.collection('district_rain').find({}).sort({ts:-1}).limit(30000).toArray(),joined=core.joinRain(analytics.enrich(rows,this.lastResearch?.baselines||new Map()),rain);
    const docs=[];for(const r of joined){const hour=new Date(Date.parse(r.ts)+8*3600000).getUTCHours(),threshold=this.lastResearch?.thresholds?.[`${r.d}|${hour}`],wet=r.ci!=null&&threshold!=null&&r.ci>threshold&&r.rain>0;
      if(!wet&&!(r.speed<20))continue;const rule=wet?'CI above district/hour P90 with reported rain':'Measured speed below 20 km/h';const kind=wet?'rain-ci':'low-speed';docs.push({_id:`${r.id}|${Math.floor(Date.parse(r.ts)/1800000)}|${kind}`,id:r.id,d:r.d,road:r.road,ts:r.ts,speed:r.speed,ci:r.ci,rain:r.rain,rule,kind});}
    if(docs.length)await this.db.collection('alerts').bulkWrite(docs.map(r=>({updateOne:{filter:{_id:r._id},update:{$setOnInsert:r},upsert:true}})),{ordered:false});
  }
  async maintenance(){await this.init();await this.evaluateDecisions();return {evaluatedAt:new Date().toISOString()};}
  async decision(body){
    await this.init();const actor=body.actor||'commuter',actions={commuter:['observe','delay20','switch-rail'],operator:['acknowledge','consider-relief-bus'],planner:['flag-review']};if(!actions[actor]?.includes(body.action)||!this.metadata.some(d=>d.id===body.detectorId))throw new Error('Choose a valid actor, road and action');
    const observation=await this.db.collection('traffic').findOne({id:body.detectorId,valid:true,hasVehicles:true},{sort:{ts:-1}});
    if(!observation||Date.now()-Date.parse(observation.ts)>600000)throw new Error('No recent valid observation for this road');
    const ts=new Date().toISOString();const row={_id:require('node:crypto').randomUUID(),ts,detectorId:observation.id,d:observation.d,road:observation.road,actor,action:body.action,initialSpeed:observation.speed,observedAt:observation.ts,outcomeAt:new Date(Date.now()+1800000).toISOString(),verdict:'pending',kind:'user observation; no dispatch or causal benefit claimed'};
    await this.db.collection('decisions').insertOne(row);this.cache=null;return row;
  }
  async evaluateDecisions(rows){
    if(!rows)rows=await this.db.collection('decisions').find({verdict:'pending',outcomeAt:{$lte:new Date().toISOString()}}).toArray();
    for(const row of rows.filter(r=>r.verdict==='pending'&&Date.parse(r.outcomeAt)<=Date.now())){
      const next=await this.db.collection('traffic').findOne({id:row.detectorId,valid:true,hasVehicles:true,ts:{$gte:row.outcomeAt,$lte:new Date(Date.parse(row.outcomeAt)+600000).toISOString()}},{sort:{ts:1}});
      if(next){row.outcomeSpeed=next.speed;row.outcomeTs=next.ts;row.delta=core.round(next.speed-row.initialSpeed);row.verdict=row.delta>3?'faster':row.delta< -3?'slower':'similar';await this.db.collection('decisions').updateOne({_id:row._id},{$set:{outcomeSpeed:row.outcomeSpeed,outcomeTs:row.outcomeTs,delta:row.delta,verdict:row.verdict}});}
    }
  }
  async backfill(kind,time){
    await this.init();if(!['traffic','weather','rain','weather-rss'].includes(kind)||!/^\d{8}-\d{4}$/.test(time))throw new Error('Invalid archive request');
    const id=`${kind}|${time}`;if(await this.db.collection('imports').findOne({_id:id,ok:true}))return {skipped:true,id};
    const archive=`https://app.data.gov.hk/v1/historical-archive/get-file?url=${encodeURIComponent(kind==='weather-rss'?history.RSS_URL:SOURCES[kind].url)}&time=${time}`;
    const response=await request(archive);const provenance={archive,requestedTime:time,resolvedUrl:response.url};
    const result=kind==='weather-rss'?await this.ingestHistorical(kind,response.body,provenance):await this.ingest(kind,response.body,200,provenance);
    await this.db.collection('imports').updateOne({_id:id},{$set:{ok:true,...result,archive,at:new Date().toISOString()}},{upsert:true});return result;
  }
  async ingestHistorical(kind,body,provenance){
    await this.init();let docs,collection;
    if(kind==='weather-rss'){docs=await history.parseWeatherRss(body.toString());collection='district_rain';
      await this.save('weather_archive',[{_id:provenance.requestedTime,xml:body.toString(),provenance}]);
    }else if(kind==='daily-rain'){docs=history.parseDailyRain(body.toString());collection='daily_rain';}
    else throw new Error('Unknown historical source');
    const result=await this.save(collection,docs.map(r=>({...r,provenance})));this.cache=null;this.researchCache.clear();
    return {kind,count:docs.length,inserted:result.upsertedCount};
  }
  async fail(kind,error){await this.init();await this.health(kind,false,error);}
  async close(){await this.client?.close();}
}

let singleton;
function get(){if(!singleton)singleton=new CityService();return singleton;}
module.exports={CityService,SOURCES,request,get};
