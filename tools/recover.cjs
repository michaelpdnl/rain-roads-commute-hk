'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {CityService}=require('../lib/service.cjs');
const {parseOptions,networkClient,discover,runRecovery}=require('../lib/recovery.cjs');
const {createStore}=require('../lib/recovery-store.cjs');
async function main(args=process.argv.slice(2)){
 const options=parseOptions(args);
 if(options.help){console.log('recover.cjs [--days 30 | --start YYYYMMDD --end YYYYMMDD | --from ISO --to ISO] [--preview] [--report /path/report.json]\nDefault: past 30 days, pinned at process start. Preview downloads listings/metadata only and writes no data.');return;}
 const fetch=networkClient(),progress=p=>console.log(JSON.stringify(p));
 console.log(JSON.stringify({mode:options.preview?'preview':'recovery',window:options.window,warning:'All available versions; a month can mean tens of thousands of files, hours and many GB. No archived photos or full rainfall coverage are guaranteed.'}));
 let service;
 try{
  const plan=await discover(options.window,{fetch,onProgress:progress});
  console.log(JSON.stringify({plannedJobs:plan.jobs.length,minimumRequestSeconds:Math.ceil(plan.jobs.length/2),note:'Lower bound at two requests/second; downloads and database writes take additional time.'}));
  if(!options.preview){service=new CityService();await service.init();}
  const result=await runRecovery(plan,{preview:options.preview,store:service?createStore(service,options.window):undefined,fetch,onProgress:progress});
  if(!options.preview){
   const report=options.report||path.join(service.dataDir,'recovery',`recovery-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
   await fs.mkdir(path.dirname(report),{recursive:true});await fs.writeFile(report,JSON.stringify(result,null,2));console.log('Report: '+report);
  }
  console.log(JSON.stringify(result,null,2));
  if(result.failedJobs||result.sources.some(s=>['discovery-incomplete','failed'].includes(s.status))||!plan.sources.find(s=>s.id==='traffic')?.versions)process.exitCode=2;
 }finally{await service?.close();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={main};
