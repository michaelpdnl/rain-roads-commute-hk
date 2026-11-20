'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
function parser(){const file=path.join(__dirname,'../lib/historical-weather.cjs');assert.ok(fs.existsSync(file),'historical weather recovery parser is not implemented');return require(file);}
const rss=(published,description)=>`<rss><channel><item><pubDate>${published}</pubDate><description><![CDATA[${description}]]></description></item></channel></rss>`;
const rain=(window,rows)=>`<html><title>Rainfall Recorded in Various Regions of Hong Kong</title>Between ${window}, the rainfall recorded in various regions were:<table>${rows.map(([d,v])=>`<tr><td>${d}</td><td>${v}</td></tr>`).join('')}</table></html>`;

test('Full RSS recovery retains actual publication, midnight observations, station temperatures and humidity',async()=>{
 const result=await parser().parseWeatherReport(rss('Tue, 17 Nov 2026 16:02:00 GMT',`At midnight at the Hong Kong Observatory :<br>Air temperature : 25 degrees Celsius<br>Relative Humidity : 83 per cent<br>The air temperatures at other places were:<table><tr><td>Sha Tin</td><td>22 degrees ;</td></tr><tr><td>King's Park</td><td>24 degrees .</td></tr></table>`));
 assert.equal(result.publishedAt,'2026-11-17T16:02:00.000Z');assert.equal(result.observedAt,'2026-11-17T16:00:00.000Z');
 assert.equal(result.temperature.data.find(r=>r.place==='Sha Tin').value,22);assert.equal(result.temperature.data.find(r=>r.place==='Hong Kong Observatory').value,25);
 assert.equal(result.humidity.data[0].value,83);assert.deepEqual(result.rain,[]);
});
test('Missing measurement clock is not replaced by publication time',async()=>{
 const r=await parser().parseWeatherReport(rss('Tue, 17 Nov 2026 16:02:00 GMT','Hong Kong Observatory. Air temperature : 25 degrees Celsius. Relative Humidity : 83 per cent.'));
 assert.equal(r.observedAt,null);assert.equal(r.temperature.recordTime,null);assert.equal(r.publishedAt,'2026-11-17T16:02:00.000Z');
});
test('Regional history uses explicit :45 rain window, not the nominal URL hour; retains all reported regions',()=>{
 const r=parser().parseRegionalRain(rain('8:45 and 9:45 a.m.',[['Sha Tin','0 to 4 mm'],['Tai Po','1 to 8 mm']]),'20260923-0900');
 assert.equal(r.observedAt,'2026-09-23T01:45:00.000Z');assert.equal(r.windowStart,'2026-09-23T00:45:00.000Z');
 assert.equal(r.rows.find(x=>x.d==='Sha Tin').mm,4);assert.equal(r.rows.find(x=>x.d==='Tai Po').minMm,1);
 assert.ok(r.rows.every(x=>x.resolution==='hour'&&!Object.hasOwn(x,'publishedAt')));assert.ok(!r.rows.some(x=>x.d==='Kwun Tong'));
});
test('Regional rain crosses midnight without inventing publication availability',()=>{
 const r=parser().parseRegionalRain(rain('11:45 and 0:45 a.m.',[['Sha Tin','2 mm']]),'20261003-0000');
 assert.equal(r.observedAt,'2026-10-02T16:45:00.000Z');assert.equal(r.windowStart,'2026-10-02T15:45:00.000Z');
});
test('An unbounded no-rain page is retained as a statement, not six fabricated hourly zeros',()=>{
 const r=parser().parseRegionalRain('<html><title>Rainfall Recorded in Various Regions of Hong Kong</title>There is currently no rainfall recorded in various regions of Hong Kong.</html>','20261118-0000');
 assert.equal(r.statement,'no-rain-without-explicit-window');assert.deepEqual(r.rows,[]);assert.equal(r.observedAt,null);
});
test('Rain recovery rejects unrelated HTML, invalid hour windows, reversed ranges and nominal-hour mismatches',()=>{
 const {parseRegionalRain}=parser();assert.throws(()=>parseRegionalRain('<html>maintenance</html>','20260923-0900'),/rainfall/i);
 assert.throws(()=>parseRegionalRain(rain('7:45 and 9:45 a.m.',[['Sha Tin','1 mm']]),'20260923-0900'),/hour/i);
 assert.throws(()=>parseRegionalRain(rain('8:45 and 9:45 a.m.',[['Sha Tin','8 to 2 mm']]),'20260923-0900'),/range/i);
 assert.throws(()=>parseRegionalRain(rain('8:45 and 9:45 a.m.',[['Sha Tin','1 mm']]),'20260923-1800'),/nominal|hour/i);
});
