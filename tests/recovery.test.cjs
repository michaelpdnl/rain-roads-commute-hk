'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
function engine(){const file=path.join(__dirname,'../lib/recovery.cjs');assert.ok(fs.existsSync(file),'complete historical recovery is not implemented');return require(file);}
const ok=j=>({body:Buffer.from(JSON.stringify(j)),url:'https://official.test/response',headers:{}});
const fail=status=>Object.assign(new Error(`HTTP ${status} from official.test`),{statusCode:status});
const window={from:'2026-10-20T16:00:00.000Z',to:'2026-11-19T15:59:59.999Z',start:'20261021',end:'20261119'};

test('Recovery window uses HKT calendar dates or frozen days and rejects invalid/mixed/future input',()=>{
 const {parseOptions}=engine(),now=new Date('2026-11-20T04:00:00Z');
 assert.deepEqual(parseOptions(['--start','20261021','--end','20261119'],now).window,window);
 const r=parseOptions(['--days','30','--preview'],now);assert.equal(r.window.from,'2026-10-21T04:00:00.000Z');assert.equal(r.window.to,now.toISOString());assert.equal(r.preview,true);
 for(const args of [['--days','0'],['--days','2','--start','20261021'],['--start','20260230','--end','20260301'],['--start','20261121','--end','20261122'],['--typo']])assert.throws(()=>parseOptions(args,now));
});
test('Archive discovery splits truncated listings, deduplicates actual versions and refuses incomplete single dates',async()=>{
 const {listVersions}=engine();let calls=0;
 const fetch=async url=>{calls++;const u=new URL(url),a=u.searchParams.get('start'),b=u.searchParams.get('end');if(a!==b)return ok({'version-count':3,timestamps:['20261021-0000']});return ok({'version-count':1,timestamps:[a+'-0000']});};
 const w={...window,to:'2026-10-22T15:59:59.999Z',end:'20261022'};
 const r=await listVersions('https://official.test/traffic',w,fetch);assert.equal(calls,3);assert.deepEqual(r.timestamps,['20261021-0000','20261022-0000']);assert.deepEqual(r.errors,[]);
 const broken=await listVersions('https://official.test/traffic',{...w,end:'20261021'},async()=>ok({'version-count':2,timestamps:['20261021-0000']}));
 assert.equal(broken.errors.length,1);assert.match(broken.errors[0].error,/truncat/i);
});
test('Preview discovers traffic without daily classifications, keeps 404 sources separate and does not need a store',async()=>{
 const {discover,runRecovery}=engine();
 const fetch=async url=>{const u=new URL(url);if(!u.pathname.includes('list-file-versions'))throw Error('Preview must not download observations');const source=u.searchParams.get('url');if(source.includes('rawSpeedVol'))return ok({'version-count':1,timestamps:['20261118-0000']});if(source.includes('CurrentWeather.xml'))return ok({'version-count':1,timestamps:['20261118-0005']});throw fail(404);};
 const p=await discover(window,{fetch,cameras:[{id:'TESTCAM',url:'https://tdcctv.data.one.gov.hk/TESTCAM.JPG'}]});
 assert.equal(p.sources.find(s=>s.id==='traffic').versions,1);assert.equal(p.jobs.filter(j=>j.kind==='traffic').length,1);
 assert.equal(p.sources.find(s=>s.id==='station-rain').status,'unavailable');assert.equal(p.sources.find(s=>s.id==='camera:TESTCAM').status,'unavailable');
 const result=await runRecovery(p,{preview:true});assert.equal(result.mode,'preview');assert.equal(result.importedJobs,0);
 assert.equal(p.jobs.filter(j=>j.kind==='regional-rain').length,720);assert.equal(p.sources.find(s=>s.id==='regional-rain').status,'candidates-not-yet-verified');
 assert.equal(p.jobs.find(j=>j.kind==='regional-rain'&&j.time==='20261118-0000').url,'https://www.hko.gov.hk/dps/wxinfo/rainfall/archive/rf_record_202611180000e.htm');
});
test('Recovery continues after one job failure and resumes only unfinished work',async()=>{
 const {runRecovery}=engine();const done=new Map(),written=[],jobs=['one','two','three'].map(key=>({key,kind:'traffic',sourceId:'traffic',time:'20261118-0000',url:'https://official.test/'+key}));
 const store={completed:async j=>done.get(j.key)?.ok===true,write:async j=>{written.push(j.key);return {records:2,inserted:2,dates:['20261118']};},mark:async(j,result)=>done.set(j.key,{ok:true,result}),failure:async(j,e)=>done.set(j.key,{ok:false,error:e.message})};
 const plan={window,sources:[{id:'traffic',status:'available'}],jobs};
 const first=await runRecovery(plan,{store,fetch:async url=>{if(url.endsWith('/two'))throw fail(503);return ok({});}});
 assert.equal(first.importedJobs,2);assert.equal(first.failedJobs,1);assert.deepEqual(written.sort(),['one','three']);
 const second=await runRecovery(plan,{store,fetch:async()=>ok({})});assert.equal(second.skippedJobs,2);assert.equal(second.importedJobs,1);assert.deepEqual(written.sort(),['one','three','two']);
});
test('Network policy retries temporary failures but not missing archives',async()=>{
 const {networkClient}=engine();let n=0;const pauses=[];
 const request=networkClient({request:async()=>{n++;if(n<3)throw fail(503);return ok({});},pause:async ms=>pauses.push(ms),intervalMs:0});await request('https://official.test/data');assert.equal(n,3);assert.equal(pauses.length,2);
 let missing=0;await assert.rejects(networkClient({request:async()=>{missing++;throw fail(404);},pause:async()=>{},intervalMs:0})('https://official.test/missing'));assert.equal(missing,1);
});
test('Resume reports the observation dates retained by checkpoints',async()=>{
 const {runRecovery}=engine(),job={key:'done',sourceId:'traffic'};
 const r=await runRecovery({window,sources:[{id:'traffic'}],jobs:[job]},{store:{completed:async()=>({records:7,dates:['20261118']})},fetch:async()=>{throw Error('completed files must not download');}});
 assert.deepEqual(r.sources[0].dates,['20261118']);assert.equal(r.sources[0].checkpointRecords,7);assert.equal(r.skippedJobs,1);
});
