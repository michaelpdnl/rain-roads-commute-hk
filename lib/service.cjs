'use strict';
const https=require('node:https');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const core=require('./core.cjs');

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
  constructor(options={}) {this.uri=options.uri||process.env.MONGO_URI;this.dbName=options.dbName||process.env.MONGO_DB||'rain_roads';this.dataDir=options.dataDir||process.env.APP_DATA_DIR||'/data/commute';this.cache=null;this.loading=null;this.cameraBusy=false;}
  async init(){
    if(this.loading)return this.loading;
    this.loading=(async()=>{
      const {MongoClient}=require('mongodb');
      this.client=new MongoClient(this.uri,{serverSelectionTimeoutMS:12000});await this.client.connect();this.db=this.client.db(this.dbName);
      await fs.mkdir(path.join(this.dataDir,'cameras'),{recursive:true});
      await Promise.all([
        this.db.collection('traffic').createIndex({ts:-1}),this.db.collection('traffic').createIndex({d:1,ts:-1}),
        this.db.collection('district_rain').createIndex({d:1,ts:-1}),this.db.collection('camera_frames').createIndex({id:1,ts:-1}),
        this.db.collection('decisions').createIndex({ts:-1}),this.db.collection('decisions').createIndex({verdict:1,outcomeAt:1})
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
          const rain=json.rainfall.data.filter(r=>core.STUDY.includes(r.place)).map(r=>({_id:`${r.place}|${ts}`,d:r.place,ts,mm:core.number(r.max),kind:'district maximum in last hour',source:SOURCES.weather.url}));
          await this.save('district_rain',rain);
          observedAt=new Date(json.updateTime).toISOString();docs=[{...json,_id:observedAt,ts:observedAt,provenance}];collection='weather';
        }else if(kind==='rain'){
          if(!json.obsTime||!Array.isArray(json.hourlyRainfall))throw new Error('Invalid station rainfall payload');
          observedAt=new Date(json.obsTime).toISOString();collection='station_rain';
          docs=json.hourlyRainfall.map(r=>({_id:`${r.automaticWeatherStationID}|${observedAt}`,id:r.automaticWeatherStationID,name:r.automaticWeatherStation,ts:observedAt,mm:core.number(r.value),rawValue:r.value,unit:r.unit,provenance}));
        }else throw new Error('Unknown source');
      }
      const result=await this.save(collection,docs);
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
          await this.save('camera_frames',[frame]);await this.db.collection('camera_status').updateOne({_id:c.id},{$set:{id:c.id,d:c.d,ok:true,lastAttempt:ts,lastSuccess:ts,error:''}},{upsert:true});return true;
        }catch(e){await this.db.collection('camera_status').updateOne({_id:c.id},{$set:{id:c.id,d:c.d,ok:false,lastAttempt:new Date().toISOString(),error:e.message}},{upsert:true});return false;}
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
    const [raw,rain,weather,health,cameraStatus,decisions,count,stationCount]=await Promise.all([
      this.db.collection('traffic').find(query).sort({ts:-1}).limit(24000).toArray(),
      this.db.collection('district_rain').find({}).sort({ts:-1}).limit(10000).toArray(),
      this.db.collection('weather').findOne({},{sort:{ts:-1}}),this.db.collection('feed_health').find({}).toArray(),
      this.db.collection('camera_status').find({}).toArray(),this.db.collection('decisions').find({}).sort({ts:-1}).limit(30).toArray(),
      this.db.collection('traffic').estimatedDocumentCount(),this.db.collection('station_rain').estimatedDocumentCount()
    ]);
    const joined=core.joinRain(raw,rain);let selected=joined;
    if(period==='peak')selected=joined.filter(r=>core.isPeak(r.ts));else if(period==='off')selected=joined.filter(r=>!core.isPeak(r.ts));
    const analysis=core.analyse(selected), latestTs=raw[0]?.ts||null;
    const byId=new Map();for(const row of joined){if(!byId.has(row.id)&&Date.parse(latestTs)-Date.parse(row.ts)<=120000)byId.set(row.id,row);}
    const latest=[...byId.values()];
    const rainDistricts=core.STUDY.map(d=>{const r=rain.find(r=>r.d===d);return {d,mm:r?.mm??null,ts:r?.ts||null};});
    const cameras=this.selectedCameras().filter(c=>!district||c.d===district).map(c=>{const status=cameraStatus.find(s=>s.id===c.id)||{};return {...c,...status,fresh:!!status.ok&&!!status.lastSuccess&&Date.now()-Date.parse(status.lastSuccess)<300000,file:`/api/camera/${c.id}`};});
    const frameGroups=new Map();for(const r of [...raw].reverse()){if(!frameGroups.has(r.ts))frameGroups.set(r.ts,[]);frameGroups.get(r.ts).push(r);}
    const frames=[...frameGroups].map(([ts,rows])=>({ts,n:rows.length,valid:rows.filter(r=>r.valid).length,speed:core.round(core.mean(rows.filter(r=>r.valid&&r.hasVehicles).map(r=>r.speed))),occupancy:core.round(core.mean(rows.filter(r=>r.valid).map(r=>r.occupancy)))}));
    const alerts=latest.filter(r=>r.valid&&r.hasVehicles&&r.speed<20).sort((a,b)=>a.speed-b.speed).slice(0,8).map(r=>({id:r.id,d:r.d,road:r.road,speed:r.speed,occupancy:r.occupancy,rain:r.rain,ts:r.ts,rule:'Measured speed below 20 km/h; descriptive threshold'}));
    const value={meta:{generatedAt:new Date().toISOString(),latestTs,records:count,stationRecords:stationCount,locations:this.metadata.length,sampleLimit:24000,analysisScope:'Most recent 24,000 stored detector-periods; filtering applied after selection',district,period},
      detectors:latest,analysis,rain:{districts:rainDistricts,stationFeed:health.find(h=>h.kind==='rain')||null},weather:weather?{ts:weather.ts,temperature:weather.temperature,humidity:weather.humidity,warningMessage:weather.warningMessage}:null,
      cameras,frames,alerts,decisions,sources:Object.values(SOURCES),health:health.map(h=>({...h,maxAge:SOURCES[h.kind]?.maxAge||3600,fresh:!!h.observedAt&&Date.now()-Date.parse(h.observedAt)<(SOURCES[h.kind]?.maxAge||3600)*1000})),
      trust:{valid:latest.filter(r=>r.valid).length,total:latest.length,coverage:frames,notes:['District rain is the maximum reported within a district, not rainfall at each road.','Source periods are 30 seconds; polling does not observe every intervening period.','Camera health measures successful JPEG retrieval, not image-content availability.','No causal claim or validated forecast is made.']}};
    this.cache={key,time:Date.now(),value};return value;
  }
  async replay(at,district=''){
    await this.init();if(!Number.isFinite(Date.parse(at)))throw new Error('Invalid replay time');
    if(district&&!core.STUDY.includes(district))throw new Error('Unknown district');
    const ts=new Date(at).toISOString();const query={ts};if(district)query.d=district;
    const rows=await this.db.collection('traffic').find(query).toArray();
    const captures=await this.db.collection('camera_frames').find({ts:{$gte:new Date(Date.parse(ts)-180000).toISOString(),$lte:ts}}).sort({ts:-1}).toArray();
    const cameras=this.selectedCameras().filter(c=>(!district||c.d===district)&&captures.some(f=>f.id===c.id)).map(c=>({...c,lastSuccess:captures.find(f=>f.id===c.id).ts,file:`/api/camera/${c.id}`}));
    return {ts,detectors:rows,cameras};
  }
  async decision(body){
    await this.init();const actions=['observe','delay20','switch-rail'];if(!actions.includes(body.action)||!this.metadata.some(d=>d.id===body.detectorId))throw new Error('Choose a valid road and action');
    const observation=await this.db.collection('traffic').findOne({id:body.detectorId,valid:true,hasVehicles:true},{sort:{ts:-1}});
    if(!observation||Date.now()-Date.parse(observation.ts)>600000)throw new Error('No recent valid observation for this road');
    const ts=new Date().toISOString();const row={_id:require('node:crypto').randomUUID(),ts,detectorId:observation.id,d:observation.d,road:observation.road,action:body.action,initialSpeed:observation.speed,observedAt:observation.ts,outcomeAt:new Date(Date.now()+1800000).toISOString(),verdict:'pending',kind:'user observation; no dispatch or causal benefit claimed'};
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
    await this.init();if(!['traffic','weather','rain'].includes(kind)||!/^\d{8}-\d{4}$/.test(time))throw new Error('Invalid archive request');
    const id=`${kind}|${time}`;if(await this.db.collection('imports').findOne({_id:id,ok:true}))return {skipped:true,id};
    const archive=`https://app.data.gov.hk/v1/historical-archive/get-file?url=${encodeURIComponent(SOURCES[kind].url)}&time=${time}`;
    const response=await request(archive);const result=await this.ingest(kind,response.body,200,{archive,requestedTime:time,resolvedUrl:response.url});
    await this.db.collection('imports').updateOne({_id:id},{$set:{ok:true,...result,archive,at:new Date().toISOString()}},{upsert:true});return result;
  }
  async fail(kind,error){await this.init();await this.health(kind,false,error);}
  async close(){await this.client?.close();}
}

let singleton;
function get(){if(!singleton)singleton=new CityService();return singleton;}
module.exports={CityService,SOURCES,request,get};
