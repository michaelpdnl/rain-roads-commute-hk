const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/core.cjs');

test('CSV accepts BOM, quoted commas and UTF16 tab-separated camera locations', () => {
  assert.deepEqual(core.parseCsv('\ufeffid,name\r\nA,"road, west"\r\n'), [{id:'A',name:'road, west'}]);
  const b = Buffer.from('\ufeffkey\tdistrict\r\nK1\tSha Tin\r\n','utf16le');
  assert.deepEqual(core.parseCsv(b), [{key:'K1',district:'Sha Tin'}]);
});

test('Traffic timestamps use HKT and invalid lanes do not distort weighted speed', async () => {
  const xml = '<raw_speed_volume_list><date>2026-11-17</date><periods><period><period_from>08:00:00</period_from><period_to>08:00:30</period_to><detectors><detector><detector_id>A</detector_id><direction>West</direction><lanes><lane><lane_id>1</lane_id><speed>20</speed><occupancy>30</occupancy><volume>3</volume><valid>Y</valid></lane><lane><lane_id>2</lane_id><speed>60</speed><occupancy>10</occupancy><volume>1</volume><valid>Y</valid></lane><lane><lane_id>3</lane_id><speed>999</speed><occupancy>999</occupancy><volume>9</volume><valid>N</valid></lane></lanes></detector></detectors></period></periods></raw_speed_volume_list>';
  const rows = await core.parseTraffic(xml, [{id:'A',d:'Sha Tin',lat:22.3,lon:114.1,road:'Test'}]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].ts,'2026-11-17T00:00:30.000Z');
  assert.equal(rows[0].speed,30);
  assert.equal(rows[0].volume,4);
  assert.equal(rows[0].occupancy,20);
  assert.equal(rows[0].validLanes,2);
  assert.equal(rows[0]._id,'A|2026-11-17T00:00:30.000Z');
});

test('Missing numbers are not silently treated as measured zero; stopped vehicles remain valid', () => {
  assert.equal(core.number(''),null);
  assert.equal(core.number('N/A'),null);
  assert.equal(core.number('0'),0);
  assert.equal(core.correlation([{x:0,y:2},{x:0,y:3}]),null);
  assert.equal(core.correlation([{x:1,y:3},{x:2,y:2},{x:3,y:1}]),-1);
});

test('District rainfall joins are bounded, source-timed, and never use future observations', () => {
  const rows=[{d:'Sha Tin',ts:'2026-11-17T01:20:00.000Z',speed:40},{d:'Sha Tin',ts:'2026-11-17T01:10:00.000Z',speed:50},{d:'Sha Tin',ts:'2026-11-17T03:00:00.000Z',speed:60}];
  const rain=[{d:'Sha Tin',ts:'2026-11-17T01:15:00.000Z',mm:2}];
  const joined=core.joinRain(rows,rain);
  assert.equal(joined[0].rain,2);
  assert.equal(joined[1].rain,null);
  assert.equal(joined[2].rain,null);
});

test('Analysis uses real rows, reports sample size, and refuses constant-rain regression', () => {
  const rows=Array.from({length:6},(_,i)=>({id:'A'+i,d:i<3?'Sha Tin':'Kwun Tong',ts:'2026-11-17T01:20:00.000Z',speed:20+i*10,occupancy:60-i*10,volume:6-i,rain:0}));
  const a=core.analyse(rows);
  assert.equal(a.n,6);
  assert.equal(a.meanSpeed,45);
  assert.equal(a.speedOccupancy,-1);
  assert.equal(a.rainFit,null);
  assert.equal(a.districts.length,2);
  assert.equal(a.wet,0);
  assert.ok(a.findings.length>=2);
});
