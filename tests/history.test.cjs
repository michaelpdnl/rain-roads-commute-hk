'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const history=require('../lib/history.cjs');
const rss=(published,description)=>`<rss><channel><item><pubDate>${published}</pubDate><description><![CDATA[${description}]]></description></item></channel></rss>`;

test('Archived RSS reads actual hourly rain ranges, not temperature or daily accumulation',async()=>{
 const xml=rss('Fri, 02 Oct 2026 22:02:00 GMT',`<table><tr><td>Kwun Tong</td><td>28 degrees</td></tr></table>Between 4:45 and 5:45 a.m., lightning was detected. The rainfall recorded in various regions were:<table><tr><td>Kwun Tong</td><td>6 to 17&nbsp;mm;</td></tr><tr><td>Sha Tin</td><td>1 mm.</td></tr></table>From midnight to noon, 44.1 millimetres of rainfall were recorded at the Hong Kong Observatory.`);
 const rows=await history.parseWeatherRss(xml);
 assert.equal(rows.length,2);const kt=rows.find(r=>r.d==='Kwun Tong');
 assert.equal(kt.mm,17);assert.equal(kt.minMm,6);assert.equal(kt.ts,'2026-10-02T21:45:00.000Z');assert.equal(kt.windowStart,'2026-10-02T20:45:00.000Z');
 assert.equal(rows.find(r=>r.d==='Sha Tin').mm,1);assert.ok(!rows.some(r=>r.d==='Yuen Long'));
});

test('RSS rain window crosses midnight and a dry Observatory statement does not invent regional zeros',async()=>{
 const rows=await history.parseWeatherRss(rss('Fri, 02 Oct 2026 16:02:00 GMT','Between 10:45 and 11:45 p.m., the rainfall recorded in various regions were:<table><tr><td>Sha Tin</td><td>0 to 3 mm.</td></tr></table>'));
 assert.equal(rows[0].ts,'2026-10-02T15:45:00.000Z');
 assert.deepEqual(await history.parseWeatherRss(rss('Thu, 01 Oct 2026 04:02:00 GMT','From midnight to noon, no rainfall was recorded at the Hong Kong Observatory.')),[]);
});

test('An unqualified 11:45 before 0:45 a.m. means the preceding night',async()=>{
 const rows=await history.parseWeatherRss(rss('Fri, 02 Oct 2026 17:02:00 GMT','Between 11:45 and 0:45 a.m., the rainfall recorded in various regions were:<table><tr><td>Sha Tin</td><td>2 mm.</td></tr></table>'));
 assert.equal(rows[0].windowStart,'2026-10-02T15:45:00.000Z');assert.equal(rows[0].ts,'2026-10-02T16:45:00.000Z');
});

test('Daily rain preserves trace and unavailable readings and never changes its daily resolution',()=>{
 const rows=history.parseDailyRain('年/Year,月/Month,日/Day,數值/Value,數據完整性/data Completeness\n2026,10,3,44.1,C\n2026,10,4,Trace,C\n2026,10,5,***,#\n','HKO');
 assert.equal(rows.length,3);assert.equal(rows[0].mm,44.1);assert.equal(rows[0].resolution,'day');assert.equal(rows[1].mm,null);assert.equal(rows[1].trace,true);assert.equal(rows[2].mm,null);
});

test('Archive selection uses listed versions, preserves wet-day detail, and rejects impossible dates',()=>{
 const times=['20261003-0601','20261003-0606','20261003-0631','20261003-0702','20261003-1804'];
 const selected=history.selectTrafficVersions(times,{wetDates:new Set(['20261003'])});
 assert.ok(selected.includes('20261003-0601'));assert.ok(selected.includes('20261003-0631'));assert.ok(!selected.includes('20261003-0606'));
 assert.ok(selected.every(t=>times.includes(t)));assert.throws(()=>history.dateRange('20261301','20261302'),/date/i);
});
