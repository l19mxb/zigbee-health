import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {seedDemo} from '../server/demo.mjs';
import {createApp} from '../server/http.mjs';

async function fixture(password=''){const s=new Store(),e=new Engine(s,{demo:true});seedDemo(e);const server=createApp(e,{password});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;return{s,e,url,server,async close(){server.closeAllConnections();await new Promise(r=>server.close(r));s.close();}};}
const post=(url,data,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
test('LAN hosting refuses an unprotected admin interface',()=>{const s=new Store(),e=new Engine(s);assert.throws(()=>createApp(e,{host:'0.0.0.0'}),/APP_PASSWORD/);s.close();});
test('password gate, cookie login and logout work',async()=>{const f=await fixture('a-strong-test-password');try{assert.equal((await fetch(f.url+'/api/state')).status,401);assert.equal((await post(f.url+'/api/login',{password:'wrong'})).status,401);const login=await post(f.url+'/api/login',{password:'a-strong-test-password'});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];assert.equal((await fetch(f.url+'/api/state',{headers:{cookie}})).status,200);await post(f.url+'/api/logout',{}, {cookie});assert.equal((await fetch(f.url+'/api/state',{headers:{cookie}})).status,401);}finally{await f.close();}});
test('cross-origin writes are blocked and settings validate server-side',async()=>{const f=await fixture();try{assert.equal((await post(f.url+'/api/thresholds',{retentionDays:30},{Origin:'https://untrusted.example'})).status,403);assert.equal((await post(f.url+'/api/thresholds',{retentionDays:-1})).status,400);assert.equal((await post(f.url+'/api/thresholds',{retentionDays:120})).status,200);assert.equal((await (await fetch(f.url+'/api/state')).json()).thresholds.retentionDays,120);}finally{await f.close();}});
test('simulation cannot enable real broker or SMTP connections',async()=>{const f=await fixture();try{assert.equal((await post(f.url+'/api/networks',{label:'Real',host:'mqtt.example.test',enabled:true})).status,400);assert.equal((await post(f.url+'/api/email',{enabled:true})).status,400);assert.equal((await (await fetch(f.url+'/api/health')).json()).mqttPublications,0);}finally{await f.close();}});
test('report endpoints return recorded data and operator actions persist in the audit',async()=>{const f=await fixture();try{const x=await (await fetch(f.url+'/api/state')).json(),i=x.alarms.find(i=>!i.ack_at);assert.equal((await post(f.url+'/api/alarms/acknowledge',{ids:[i.id],note:'Reviewing'})).status,200);const report=await (await fetch(f.url+'/api/report?device='+encodeURIComponent(i.device_id)+'&days=7')).json();assert.ok(report.samples.length>0);assert.ok(report.events.some(e=>e.type==='acknowledged'));const csv=await fetch(f.url+'/api/report.csv?device='+encodeURIComponent(i.device_id));assert.equal(csv.status,200);assert.match(csv.headers.get('content-type'),/text\/csv/);assert.match(await csv.text(),/Reviewing/);assert.equal((await fetch(f.url+'/api/report?device=missing')).status,400);}finally{await f.close();}});


test('lifecycle HTTP operations require authentication and same-origin requests',async()=>{
  const f=await fixture('a-strong-test-password');try{
    const id=f.s.devices()[0].id,body={id,reason:'Discarded'};
    assert.equal((await post(f.url+'/api/devices/retire',body)).status,401);
    const login=await post(f.url+'/api/login',{password:'a-strong-test-password'}),cookie=login.headers.get('set-cookie').split(';')[0];
    assert.equal((await post(f.url+'/api/devices/retire',body,{cookie,Origin:'https://untrusted.example'})).status,403);
    assert.equal((await post(f.url+'/api/devices/retire',body,{cookie})).status,200);
    assert.equal(f.e.snapshot().devices.find(d=>d.id===id).status,'retired');
    assert.equal((await post(f.url+'/api/devices/delete-history',{id,reason:'Erase'},{cookie})).status,400);
    assert.equal((await post(f.url+'/api/devices/delete-history',{id,reason:'Erase',confirmName:f.s.device(id).name,confirmation:'DELETE HISTORY'},{cookie})).status,200);
    assert.equal((await post(f.url+'/api/devices/restore',{id,reason:'Reinstalled'},{cookie})).status,200);
    assert.equal(f.s.device(id).lastLiveAt,null);
  }finally{await f.close();}
});
test('record-link endpoints preserve independent reports and support audited unlinking',async()=>{
  const f=await fixture();try{
    const [source,target]=f.s.devices();await post(f.url+'/api/devices/retire',{id:source.id,reason:'Replaced'});
    const response=await post(f.url+'/api/devices/link',{sourceId:source.id,targetId:target.id,kind:'replacement',reason:'New hardware'});
    assert.equal(response.status,200);const {result}=await response.json();
    const report=await (await fetch(f.url+'/api/report?device='+encodeURIComponent(target.id))).json();
    assert.equal(report.links[0].device.id,source.id);assert.equal(report.timezone,'UTC');
    assert.equal((await post(f.url+'/api/devices/unlink',{id:result.id,reason:'Corrected'})).status,200);
    assert.equal(f.e.report(target.id).links.length,0);assert.ok(f.s.device(source.id).retiredAt);
  }finally{await f.close();}
});
