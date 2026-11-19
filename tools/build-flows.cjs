'use strict';
const fs=require('node:fs');
const flows=[];
const add=n=>(flows.push(n),n.id);
const tab=(id,label,info)=>add({id,type:'tab',label,disabled:false,info});
tab('collect','1 · Automatic data collection','Real DATA.GOV.HK streams. Trigger → core HTTP request → validate / transform / MongoDB upsert. Timers run on the Node-RED server even when no dashboard is open.');
tab('api','2 · Dashboard API','The static dashboard at / queries these HTTP endpoints. The editor is at /red/. The service in /opt/commute/lib provides tested validation, MongoDB storage, joins and descriptive statistics.');
function fn(id,z,name,func,x,y,wires){return add({id,type:'function',z,name,func,outputs:1,timeout:0,noerr:0,initialize:'',finalize:'',libs:[],x,y,wires:[wires]});}
function trigger(id,name,seconds,delay,y,target){add({id,type:'inject',z:'collect',name,props:[{p:'payload'},{p:'topic',vt:'str'}],repeat:String(seconds),crontab:'',once:true,onceDelay:delay,topic:'',payload:'',payloadType:'date',x:160,y,wires:[[target]]});}
const asyncFn=expression=>`const city=global.get('city');
(async()=>{try{msg.payload=await (${expression});node.status({fill:'green',shape:'dot',text:new Date().toLocaleTimeString('en-GB',{timeZone:'Asia/Hong_Kong'})});node.send(msg);}catch(e){node.status({fill:'red',shape:'ring',text:e.message.slice(0,60)});node.error(e.message,msg);}finally{node.done();}})();
return;`;
trigger('init','Initialize / refresh locations · daily',86400,2,80,'metadata');
fn('metadata','collect','Load official detector + camera metadata',asyncFn('city.init().then(()=>city.metadataRefresh())'),470,80,['log']);
for(const [kind,seconds,delay,url,y] of [
 ['traffic',120,10,'https://resource.data.one.gov.hk/td/traffic-detectors/rawSpeedVol-all.xml',180],
 ['rain',900,12,'https://data.weather.gov.hk/weatherAPI/opendata/hourlyRainfall.php?lang=en',280],
 ['weather',600,14,'https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en',380]
]){
 trigger(`timer-${kind}`,`${kind} · every ${seconds/60} min`,seconds,delay,y,`url-${kind}`);
 fn(`url-${kind}`,'collect',`Set ${kind} source`, `msg.sourceKind=${JSON.stringify(kind)};msg.url=${JSON.stringify(url)};return msg;`,420,y,[`http-${kind}`]);
 add({id:`http-${kind}`,type:'http request',z:'collect',name:`Fetch ${kind}`,method:'GET',ret:'txt',paytoqs:'ignore',url:'',tls:'',persist:false,proxy:'',insecureHTTPParser:false,authType:'',senderr:false,headers:[],x:650,y,wires:[[`store-${kind}`]]});
 fn(`store-${kind}`,'collect','Validate → normalize → MongoDB',asyncFn(`city.ingest(${JSON.stringify(kind)},msg.payload,msg.statusCode)`),930,y,['log']);
}
trigger('timer-camera','Capture six cameras · every 2 min',120,20,480,'camera');
fn('camera','collect','Download / persist actual JPEG frames',asyncFn('city.captureCameras()'),480,480,['log']);
add({id:'catch-collect',type:'catch',z:'collect',name:'Record source failure',scope:null,uncaught:false,x:220,y:580,wires:[['error-state']]});
fn('error-state','collect','Mark feed unavailable; keep stored history',`const city=global.get('city');if(msg.sourceKind)city.fail(msg.sourceKind,msg.error?.message||'Request failed').catch(()=>{});msg.payload={source:msg.sourceKind||msg.error?.source?.name,error:msg.error?.message};return msg;`,640,580,['log']);
add({id:'log',type:'debug',z:'collect',name:'Acquisition status',active:true,tosidebar:true,console:false,tostatus:false,complete:'payload',targetType:'msg',x:1220,y:480,wires:[]});
const api=(id,method,url,expression,y,image=false)=>{
 add({id:`in-${id}`,type:'http in',z:'api',name:`${method.toUpperCase()} ${url}`,url,method,upload:false,swaggerDoc:'',x:220,y,wires:[[`fn-${id}`]]});
 const func=`const city=global.get('city');(async()=>{try{const value=await (${expression});msg.statusCode=200;${image?"msg.headers={'Content-Type':'image/jpeg','Cache-Control':'no-store','X-Captured-At':value.ts};msg.payload=value.body;":"msg.headers={'Content-Type':'application/json','Cache-Control':'no-store'};msg.payload=value;"}}catch(e){msg.statusCode=${image?404:400};msg.headers={'Content-Type':'application/json','Cache-Control':'no-store'};msg.payload={error:e.message};}node.send(msg);node.done();})();return;`;
 fn(`fn-${id}`,'api',id,func,590,y,[`out-${id}`]);
 add({id:`out-${id}`,type:'http response',z:'api',name:'',statusCode:'',headers:{},x:920,y,wires:[]});
};
api('Dashboard','get','/api/dashboard','city.snapshot(msg.req.query||{})',100);
api('Historical replay','get','/api/replay',"city.replay(msg.req.query.at,msg.req.query.district||'')",200);
api('Captured image','get','/api/camera/:id',"city.camera(msg.req.params.id,msg.req.query.at)",300,true);
api('Log a user decision','post','/api/decisions','city.decision(msg.payload||{})',400);
api('Health','get','/api/health',"city.init().then(async()=>({ready:!!(await city.db.command({ping:1})).ok,service:'rain-roads'}))",500);
fs.writeFileSync('flows.json',JSON.stringify(flows,null,2)+'\n');
console.log(`Exported ${flows.length} Node-RED nodes`);
