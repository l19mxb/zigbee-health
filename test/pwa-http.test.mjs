import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {Store,defaults} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {PushService} from '../server/push.mjs';
import {TopicLog} from '../server/topic-log.mjs';
import {createApp} from '../server/http.mjs';
const password='synthetic-strong-password';
async function fixture(){const s=new Store(),e=new Engine(s),p=new PushService(e,{send:async()=>{}}),logs=new TopicLog(),server=createApp(e,{password,push:p,collectors:{logs,reconcile(){}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;return {s,e,p,logs,server,url,async close(){server.closeAllConnections();await new Promise(r=>server.close(r));s.close();}};}
async function post(f,route,data,headers={}){return new Promise((resolve,reject)=>{const req=http.request(f.url+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json',...headers}},res=>{const parts=[];res.on('data',x=>parts.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:new Headers(Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(','):v]))),json:()=>JSON.parse(Buffer.concat(parts).toString())}));});req.on('error',reject);req.end(JSON.stringify(data));});}
const config={enabled:true,recovery:true,includeDeviceNames:false,publicOrigin:'https://health.example.test'};
test('push APIs are authenticated, enrolment requires the configured HTTPS origin and canonical cookies are Secure',async()=>{
  const f=await fixture();try{
    assert.equal((await fetch(f.url+'/api/push')).status,401);assert.equal((await post(f,'push/settings',config)).status,401);
    const login=await post(f,'login',{password}),cookie=login.headers.get('set-cookie').split(';')[0];assert.ok(!login.headers.get('set-cookie').includes('Secure'));
    assert.equal((await post(f,'push/settings',config,{cookie})).status,200);
    const publicLogin=await post(f,'login',{password},{Host:'health.example.test',Origin:config.publicOrigin});assert.match(publicLogin.headers.get('set-cookie'),/; Secure/);
    const key=crypto.createECDH('prime256v1');key.generateKeys();const sub={endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-http',keys:{p256dh:key.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')}},body={subscription:sub,label:'Synthetic browser'};
    assert.equal((await post(f,'push/subscribe',body,{cookie})).status,400);
    assert.equal((await post(f,'push/subscribe',body,{cookie,Host:'health.example.test',Origin:'https://evil.example.test'})).status,403);
    assert.equal((await post(f,'push/subscribe',body,{cookie,Host:'health.example.test',Origin:config.publicOrigin})).status,201);
    const status=await (await fetch(f.url+'/api/push',{headers:{cookie}})).json();assert.equal(status.subscriptions.length,1);assert.ok(!JSON.stringify(status).includes(sub.endpoint));
    const forged=await post(f,'login',{password},{'X-Forwarded-Proto':'https'});assert.ok(!forged.headers.get('set-cookie').includes('Secure'));
  }finally{await f.close();}
});
test('broker mode validation, live log authorization and mode changes preserve device history',async()=>{
  const f=await fixture();try{
    const login=await post(f,'login',{password}),cookie=login.headers.get('set-cookie').split(';')[0],headers={cookie};
    const broker={label:'Synthetic MQTT',host:'mqtt.example.test',port:1883,protocol:'mqtt',mode:'mqtt',topicFilters:'service/available',enabled:true};
    assert.equal((await post(f,'networks',{...broker,topicFilters:'a/#/invalid'},headers)).status,400);
    const response=await post(f,'networks',broker,headers),{id}=await response.json();assert.equal(response.status,200);assert.deepEqual(f.s.network(id).topicFilters,['service/available']);
    f.e.connection(id,true);f.e.tick();assert.equal(f.e.sourceStatus(f.s.network(id)),'online');
    f.logs.add(id,'service/available',Buffer.from('online'));assert.equal((await fetch(f.url+'/api/network-log?network='+id)).status,401);const log=await (await fetch(f.url+'/api/network-log?network='+id,{headers})).json();assert.equal(log.entries.length,1);assert.equal(log.persistent,false);
    let n=f.s.network(id);n.subscriptionStatus='denied';f.s.saveNetwork(n);f.s.set('thresholds',{...defaults,faultDelaySec:0});f.e.tick();assert.ok(f.s.one("SELECT id FROM incidents WHERE category='subscription'"));
    const z2m={...broker,id,mode:'zigbee2mqtt',baseTopic:'zigbee2mqtt'};assert.equal((await post(f,'networks',z2m,headers)).status,200);assert.equal(f.s.one("SELECT resolution FROM incidents WHERE category='subscription'").resolution,'monitor_mode_changed');
    f.e.ingest(id,'zigbee2mqtt/bridge/devices',[{ieee_address:'0x0000000000000001',friendly_name:'Synthetic device'}]);assert.equal((await post(f,'networks',{...broker,id},headers)).status,400);assert.equal(f.s.devices(id).length,1);
  }finally{await f.close();}
});
