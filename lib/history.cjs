'use strict';
const core=require('./core.cjs');
const RSS_URL='https://rss.weather.gov.hk/rss/CurrentWeather.xml';
const DAILY_URL='https://data.weather.gov.hk/weatherAPI/cis/csvfile/HKO/2026/daily_HKO_RF_2026.csv';
const strip=s=>String(s).replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();

function dateRange(start,end){
 const parse=s=>{if(!/^\d{8}$/.test(s))throw new Error('Invalid archive date');const d=new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00Z`);if(!Number.isFinite(+d)||d.toISOString().slice(0,10).replaceAll('-','')!==s)throw new Error('Invalid archive date');return +d;};
 const a=parse(start),b=parse(end);if(a>b||b-a>366*86400000)throw new Error('Invalid date range (maximum 366 days)');
 return Array.from({length:(b-a)/86400000+1},(_,i)=>new Date(a+i*86400000).toISOString().slice(0,10).replaceAll('-',''));
}

async function parseWeatherRss(xml){
 const {parseStringPromise}=require('xml2js');const channel=(await parseStringPromise(String(xml),{explicitArray:false})).rss?.channel;
 const item=core.array(channel?.item)[0];const published=Date.parse(item?.pubDate);if(!Number.isFinite(published))throw new Error('RSS has no valid publication date');
 const html=String(item.description||''),plain=strip(html);
 const window=plain.match(/Between\s+(\d{1,2}:\d{2})(?:\s*([ap])\.m\.)?\s+and\s+(\d{1,2}:\d{2})\s*([ap])\.m\./i);
 if(!window)return []; // Observatory-only daily totals are not regional hourly measurements.
 const clock=(s,meridiem)=>{let [h,m]=s.split(':').map(Number);if(h>23||m>59)throw new Error('Invalid RSS clock');if(meridiem){if(h>12)throw new Error('Invalid RSS clock');h=h%12+(meridiem.toLowerCase()==='p'?12:0);}return h*60+m;};
 const endMinutes=clock(window[3],window[4]);const localDay=Math.floor((published+8*3600000)/86400000)*86400000;
 let end=localDay+endMinutes*60000-8*3600000;if(end>published)end-=86400000;
 const start=end-3600000,statedStart=clock(window[1],window[2]||window[4]);
 const actualStart=((start+8*3600000)%86400000+86400000)%86400000/60000;
 if(window[2]?statedStart!==actualStart:statedStart%720!==actualStart%720)throw new Error('RSS rainfall window is not one hour');
 const marker=html.search(/rainfall recorded in various regions were/i);if(marker<0)return [];
 const table=html.slice(marker).match(/<table\b[^>]*>([\s\S]*?)<\/table>/i);if(!table)return [];
 const rows=[];for(const tr of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
  const cells=[...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(x=>strip(x[1]));
  if(!core.STUDY.includes(cells[0]))continue;
  const m=cells[1]?.match(/^(\d+(?:\.\d+)?)(?:\s+to\s+(\d+(?:\.\d+)?))?\s*mm\b/i);if(!m)continue;
  const minMm=Number(m[1]),mm=Number(m[2]||m[1]);if(mm<minMm)throw new Error('Reversed RSS rain range');
  const ts=new Date(end).toISOString();rows.push({_id:`${cells[0]}|${ts}`,d:cells[0],ts,windowStart:new Date(start).toISOString(),publishedAt:new Date(published).toISOString(),minMm,mm,kind:'district maximum in last hour',resolution:'hour',source:RSS_URL});
 }
 return rows;
}

function parseDailyRain(csv,station='HKO'){
 const rows=[];for(const line of String(csv).split(/\r?\n/)){
  const x=line.split(',');if(!/^\d{4}$/.test(x[0])||!/^\d{1,2}$/.test(x[1]||'')||!/^\d{1,2}$/.test(x[2]||''))continue;
  const date=`${x[0]}${x[1].padStart(2,'0')}${x[2].padStart(2,'0')}`;dateRange(date,date);
  const trace=/trace|微量/i.test(x[3]||'');const mm=trace?null:core.number(x[3]);
  rows.push({_id:`${station}|${date}`,station,date,mm,trace,complete:x[4]?.trim()==='C',rawValue:x[3],resolution:'day',source:DAILY_URL});
 }
 return rows;
}

function selectTrafficVersions(timestamps,{wetDates=new Set()}={}){
 const bins=new Map();for(const t of [...timestamps].sort()){
  if(!/^\d{8}-\d{4}$/.test(t))continue;
  const minute=Number(t.slice(9,11))*60+Number(t.slice(11,13)),bin=Math.floor(minute/30);
  // Wet dates: every half hour. Other dates: night, commute and evening snapshots.
  if(!wetDates.has(t.slice(0,8))&&![6,16,17,36,37,40].includes(bin))continue;
  const key=`${t.slice(0,8)}|${bin}`;if(!bins.has(key))bins.set(key,t);
 }
 return [...bins.values()];
}

module.exports={RSS_URL,DAILY_URL,parseWeatherRss,parseDailyRain,selectTrafficVersions,dateRange};
