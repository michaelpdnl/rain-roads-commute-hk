'use strict';
const {MongoClient,BSON}=require('mongodb');
const fs=require('node:fs/promises'),path=require('node:path');
const collections=['detectors','camera_metadata','traffic','district_rain','station_rain','weather','feed_health','camera_frames','camera_status','decisions','imports'];
(async()=>{
  const [mode,folder]=process.argv.slice(2);if(!['export','restore'].includes(mode)||!folder)throw new Error('Usage: node tools/data.cjs export|restore /absolute/folder');
  const client=new MongoClient(process.env.MONGO_URI);await client.connect();
  try{
    const db=client.db(process.env.MONGO_DB||'rain_roads'),counts={};await fs.mkdir(folder,{recursive:true});
    for(const name of collections){
      const file=path.join(folder,`${name}.jsonl`);
      if(mode==='export'){
        const handle=await fs.open(file,'w');let n=0;
        try{for await(const row of db.collection(name).find({})){await handle.write(BSON.EJSON.stringify(row)+'\n');n++;}}finally{await handle.close();}counts[name]=n;
      }else{
        const text=await fs.readFile(file,'utf8');const rows=text.split('\n').filter(Boolean).map(x=>BSON.EJSON.parse(x));
        for(let i=0;i<rows.length;i+=500)await db.collection(name).bulkWrite(rows.slice(i,i+500).map(row=>({replaceOne:{filter:{_id:row._id},replacement:row,upsert:true}})),{ordered:false});counts[name]=rows.length;
      }
    }
    const cameraDir=path.join(process.env.APP_DATA_DIR||'/data/commute','cameras');
    if(mode==='export'){await fs.cp(cameraDir,path.join(folder,'cameras'),{recursive:true});await fs.writeFile(path.join(folder,'manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),format:'MongoDB Extended JSON lines',counts},null,2));}
    else{await fs.mkdir(cameraDir,{recursive:true});await fs.cp(path.join(folder,'cameras'),cameraDir,{recursive:true});}
    console.log(JSON.stringify({mode,counts}));
  }finally{await client.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
