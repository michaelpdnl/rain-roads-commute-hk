'use strict';
const {get}=require('../lib/service.cjs');
(async()=>{
  const service=get();const args=process.argv.slice(2);
  const times=args.length?args:['20261113-0830','20261115-0300','20261116-0830','20261116-1830','20261117-0830','20261117-1830','20261117-2100'];
  let failed=0;
  // Only TD XML archives were verified available. No historical weather is invented.
  for(const time of times)for(const kind of ['traffic']){
    try{console.log(JSON.stringify({time,kind,...await service.backfill(kind,time)}));}
    catch(e){failed++;console.log(JSON.stringify({time,kind,error:e.message}));}
  }
  await service.close();if(failed)process.exitCode=2;
})().catch(e=>{console.error(e.message);process.exitCode=1;});
