'use strict';
const {parseStringPromise}=require('xml2js');
const {array}=require('./core.cjs');
const history=require('./history.cjs');
const HOUR=3600000,DAY=24*HOUR;
const clean=s=>String(s).replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();

function versionTime(time){
 if(!/^\d{8}-\d{4}$/.test(time))throw new Error('Invalid historical version time');
 history.dateRange(time.slice(0,8),time.slice(0,8));
 const h=Number(time.slice(9,11)),m=Number(time.slice(11,13));if(h>23||m>59)throw new Error('Invalid historical version hour');
 return new Date(`${time.slice(0,4)}-${time.slice(4,6)}-${time.slice(6,8)}T${time.slice(9,11)}:${time.slice(11,13)}:00+08:00`).toISOString();
}
function regionalRainUrl(time){versionTime(time);return `https://www.hko.gov.hk/dps/wxinfo/rainfall/archive/rf_record_${time.replace('-','')}e.htm`;}
function minutes(clock,meridiem){
 let [h,m]=clock.split(':').map(Number);if(h>23||m>59||meridiem&&h>12)throw new Error('Invalid rainfall hour');
 if(meridiem)h=h%12+(meridiem.toLowerCase()==='p'?12:0);return h*60+m;
}
function parseRegionalRain(html,time){
 const selected=Date.parse(versionTime(time)),plain=clean(html);
 if(!/Rainfall Recorded in Various Regions of Hong Kong/i.test(plain))throw new Error('Unrecognized historical rainfall page');
 const base={source:regionalRainUrl(time),requestedTime:time,observedAt:null,windowStart:null,rows:[]};
 if(/There is currently no rainfall recorded in various regions of Hong Kong\./i.test(plain))return {...base,statement:'no-rain-without-explicit-window'};
 const marker=html.search(/the rainfall recorded in various regions were/i);if(marker<0)throw new Error('Historical rainfall page has no supported observations');
 const prefix=clean(html.slice(0,marker));
 const matches=[...prefix.matchAll(/Between\s+(\d{1,2}:\d{2})(?:\s*([ap])\.m\.)?\s+and\s+(\d{1,2}:\d{2})\s*([ap])\.m\./gi)],w=matches.at(-1);
 if(!w)throw new Error('Rainfall page has no explicit hour window');
 const endMinutes=minutes(w[3],w[4]),startMinutes=minutes(w[1],w[2]||w[4]);
 const expectedStart=(endMinutes+1440-60)%1440;
 if(w[2]?startMinutes!==expectedStart:startMinutes%720!==expectedStart%720)throw new Error('Rainfall window is not one hour');
 if(Math.floor(endMinutes/60)!==Number(time.slice(9,11)))throw new Error('Rainfall window does not match nominal historical hour');
 const midnight=Math.floor((selected+8*HOUR)/DAY)*DAY-8*HOUR,end=midnight+endMinutes*60000,start=end-HOUR;
 const table=html.slice(marker).match(/<table\b[^>]*>([\s\S]*?)<\/table>/i);if(!table)throw new Error('Rainfall table missing');
 const ts=new Date(end).toISOString(),windowStart=new Date(start).toISOString(),rows=[];
 for(const tr of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
  const cells=[...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(x=>clean(x[1]));
  if(cells.length<2||/^(Region|Rainfall)$/i.test(cells[0]))continue;
  const m=cells[1].match(/^(\d+(?:\.\d+)?)(?:\s+to\s+(\d+(?:\.\d+)?))?\s*mm\b/i);
  if(!m)throw new Error(`Unrecognized rainfall value for ${cells[0]}`);
  const minMm=Number(m[1]),mm=Number(m[2]||m[1]);if(mm<minMm)throw new Error('Reversed rainfall range');
  rows.push({_id:`${cells[0]}|${ts}`,d:cells[0],ts,windowStart,minMm,mm,kind:'district maximum in last hour',resolution:'hour',source:base.source});
 }
 if(!rows.length)throw new Error('Historical rainfall table is empty');
 return {...base,observedAt:ts,windowStart,rows,statement:'explicit-hourly-values'};
}
function observationTime(plain,published){
 const m=plain.match(/\bAt\s+(midnight|noon|\d{1,2}(?::\d{2})?\s*[ap]\.m\.)\s+at the Hong Kong Observatory/i);if(!m)return null;
 const value=m[1].toLowerCase();let minute;
 if(value==='midnight')minute=0;else if(value==='noon')minute=720;
 else{const c=value.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.m\./);minute=minutes(c[1]+':'+(c[2]||'00'),c[3]);}
 const pub=Date.parse(published),midnight=Math.floor((pub+8*HOUR)/DAY)*DAY-8*HOUR;let ts=midnight+minute*60000;if(ts>pub)ts-=DAY;
 return new Date(ts).toISOString();
}
async function parseWeatherReport(xml){
 const item=array((await parseStringPromise(String(xml),{explicitArray:false})).rss?.channel?.item)[0];
 const pub=Date.parse(item?.pubDate);if(!Number.isFinite(pub))throw new Error('Historical weather RSS has no valid publication date');
 const html=String(item.description||''),plain=clean(html);if(!/Hong Kong Observatory/i.test(plain))throw new Error('Unrecognized historical weather report');
 const publishedAt=new Date(pub).toISOString(),observedAt=observationTime(plain,publishedAt),data=[];
 const temp=plain.match(/Air temperature\s*:\s*(-?\d+(?:\.\d+)?)\s*degrees Celsius/i),humidity=plain.match(/Relative Humidity\s*:\s*(\d+(?:\.\d+)?)\s*per cent/i);
 if(temp)data.push({place:'Hong Kong Observatory',value:Number(temp[1]),unit:'C'});
 const marker=html.search(/air temperatures at other places were/i);
 if(marker>=0){const table=html.slice(marker).match(/<table\b[^>]*>([\s\S]*?)<\/table>/i);if(table)for(const tr of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
  const cells=[...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(x=>clean(x[1]));const value=cells[1]?.match(/^(-?\d+(?:\.\d+)?)\s*degrees\b/i);
  if(value){const row={place:cells[0],value:Number(value[1]),unit:'C'},i=data.findIndex(x=>x.place===row.place);if(i>=0)data[i]=row;else data.push(row);}
 }}
 const h=humidity?Number(humidity[1]):null;if(h!=null&&(h<0||h>100))throw new Error('Invalid relative humidity');
 return {publishedAt,observedAt,source:history.RSS_URL,temperature:{recordTime:observedAt,data},humidity:{recordTime:observedAt,data:h==null?[]:[{place:'Hong Kong Observatory',value:h,unit:'percent'}]},rain:await history.parseWeatherRss(xml)};
}
module.exports={versionTime,regionalRainUrl,parseRegionalRain,parseWeatherReport};
