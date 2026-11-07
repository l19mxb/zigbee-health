import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateRequestDetails} from 'web-push';
import {Store,defaults} from '../server/store.mjs';
import {Engine,deviceId} from '../server/engine.mjs';
import {PushService,validatePublicOrigin,validateSubscription} from '../server/push.mjs';

function subscription(suffix='one'){const key=crypto.createECDH('prime256v1');key.generateKeys();return {endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-'+suffix,keys:{p256dh:key.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')}};}
function fixture(){
  let now=1794000000000;const s=new Store(),e=new Engine(s,{clock:()=>now}),sent=[];
  s.set('thresholds',{...defaults,faultDelaySec:0,recoveryDelaySec:0});
  s.saveNetwork({id:'a',label:'Synthetic network',enabled:true,connected:true,connectedAt:now-1,bridgeState:'online',baseTopic:'zigbee2mqtt'});
  e.ingest('a','zigbee2mqtt/bridge/devices',[{ieee_address:'0x0000000000000001',friendly_name:'Synthetic sensor',power_source:'Battery'}]);
  const p=new PushService(e,{send:async(...args)=>sent.push(args)}),config={enabled:true,recovery:true,includeDeviceNames:false,publicOrigin:'https://health.example.test'};
  p.configure(config,'Test');const sub=subscription(),id=p.subscribe(sub,'Synthetic Android','Test').id;
  const state=battery=>e.ingest('a','zigbee2mqtt/Synthetic sensor',{battery,linkquality:150});
  const tick=()=>{e.tick();p.queue();};
  return{s,e,p,sent,sub,id,config,state,tick,device:deviceId('a','0x0000000000000001'),advance:ms=>now+=ms,incident:()=>s.one("SELECT * FROM incidents WHERE category='battery' ORDER BY opened_at DESC LIMIT 1"),close:()=>s.close()};
}
test('push endpoints reject arbitrary servers and malformed keys; public origin is HTTPS root only',()=>{
  const sub=subscription();assert.equal(validateSubscription(sub).endpoint,sub.endpoint);
  for(const endpoint of ['http://fcm.googleapis.com/x','https://127.0.0.1/x','https://fcm.googleapis.com.evil.test/x','https://user:pass@fcm.googleapis.com/x','https://fcm.googleapis.com:444/x'])assert.throws(()=>validateSubscription({...sub,endpoint}));
  assert.throws(()=>validateSubscription({...sub,keys:{p256dh:'bad',auth:'bad'}}));
  assert.equal(validatePublicOrigin('https://health.example.test/'),'https://health.example.test');
  for(const value of ['http://health.example.test','https://health.example.test/path','https://health.example.test/?x=1','https://x:y@health.example.test'])assert.throws(()=>validatePublicOrigin(value));
});
test('actual Web Push encryption produces an encrypted request locally; secrets never appear in status',()=>{
  const f=fixture();try{
    const pair=f.s.get('pushVapid'),body=JSON.stringify({body:'Synthetic alarm'}),request=generateRequestDetails(f.sub,body,{vapidDetails:{subject:f.config.publicOrigin+'/',publicKey:pair.publicKey,privateKey:f.s.unseal(pair.privateKey)}});
    assert.equal(request.headers['Content-Encoding'],'aes128gcm');assert.ok(Buffer.isBuffer(request.body));assert.ok(!request.body.includes(Buffer.from(body)));
    const status=JSON.stringify(f.p.status());for(const secret of [f.sub.endpoint,f.sub.keys.auth,f.sub.keys.p256dh,f.s.unseal(pair.privateKey),pair.privateKey])assert.ok(!status.includes(secret));
    assert.ok(!f.s.one('SELECT json FROM push_subscriptions').json.includes(f.sub.endpoint));
  }finally{f.close();}
});
test('each browser receives one future fault and one accepted-fault recovery, with generic lock screen text',async()=>{
  const f=fixture();try{f.state(10);f.tick();await f.p.deliver();f.tick();await f.p.deliver();assert.equal(f.sent.length,1);assert.ok(!f.sent[0][1].includes('Synthetic sensor'));assert.equal(f.sent[0][2].TTL,300);f.state(40);f.tick();await f.p.deliver();assert.equal(f.sent.length,2);assert.match(JSON.parse(f.sent[1][1]).title,/Restored/);}finally{f.close();}
});
test('new browser enrolment does not replay active alarms or their recoveries',async()=>{
  const f=fixture();try{f.state(10);f.tick();await f.p.deliver();f.p.subscribe(subscription('two'),'Second browser','Test');f.tick();await f.p.deliver();assert.equal(f.sent.length,1);f.state(40);f.tick();await f.p.deliver();assert.equal(f.sent.length,2);f.state(10);f.tick();await f.p.deliver();assert.equal(f.sent.length,4);}finally{f.close();}
});
test('acknowledgement, shunts, retirement and source loss suppress pending device push',async()=>{
  for(const action of ['ack','shunt','retire','source']){const f=fixture();try{f.state(10);f.tick();const i=f.incident();if(action==='ack')f.e.acknowledge([i.id],'Test');if(action==='shunt')f.e.shunt({scopeType:'device',scopeId:f.device,durationMin:null,reason:'Synthetic maintenance'},'Test');if(action==='retire')f.e.retireDevice({id:f.device,reason:'Synthetic retirement'},'Test');if(action==='source')f.e.connection('a',false);await f.p.deliver();assert.equal(f.sent.length,0,action);assert.equal(f.s.one("SELECT status FROM push_outbox WHERE kind='alarm'").status,'suppressed');}finally{f.close();}}
});
test('shunt expiry creates one new notification generation',async()=>{
  const f=fixture();try{f.state(10);f.tick();await f.p.deliver();f.e.shunt({scopeType:'device',scopeId:f.device,category:'battery',durationMin:1,reason:'Synthetic maintenance'},'Test');f.advance(61000);f.tick();await f.p.deliver();f.tick();await f.p.deliver();assert.equal(f.sent.length,2);assert.equal(f.incident().rearm,1);}finally{f.close();}
});
test('provider expiry disables that browser; ambiguous delivery is retained without automatic retry',async()=>{
  for(const statusCode of [410,503]){const f=fixture();try{let attempts=0;f.p.send=async()=>{attempts++;throw Object.assign(Error('untrusted provider detail'),{statusCode});};f.state(10);f.tick();await f.p.deliver();f.tick();await f.p.deliver();assert.equal(attempts,1);assert.equal(f.s.one('SELECT status FROM push_outbox').status,statusCode===410?'expired':'uncertain');assert.equal(!!f.s.one('SELECT disabled_at FROM push_subscriptions').disabled_at,statusCode===410);assert.ok(!JSON.stringify(f.p.status()).includes('untrusted provider detail'));}finally{f.close();}}
});
test('old queued pushes expire; origin changes disable subscriptions and suppress pending work',async()=>{
  const f=fixture();try{f.state(10);f.tick();f.advance(300001);await f.p.deliver();assert.equal(f.sent.length,0);f.p.configure({...f.config,publicOrigin:'https://new-health.example.test'},'Test');assert.ok(f.p.status().subscriptions[0].disabled_at);f.tick();await f.p.deliver();assert.equal(f.sent.length,0);}finally{f.close();}
});
test('explicit test is rate limited; browser removal deletes only its subscription and deliveries',async()=>{
  const f=fixture();try{assert.equal((await f.p.test(f.id)).status,'accepted');await assert.rejects(f.p.test(f.id),/one minute/);const other=f.p.subscribe(subscription('two'),'Other','Test').id;f.p.remove(f.id,'Test');assert.equal(f.p.status().subscriptions.length,1);assert.equal(f.p.status().subscriptions[0].id,other);assert.equal(f.p.status().deliveries.length,0);}finally{f.close();}
});
test('push subscriptions, encryption keys and interrupted attempts survive database migration/reopen',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zh-push-')),file=path.join(dir,'health.db');let s;
  try{s=new Store(file);const e=new Engine(s),p=new PushService(e);s.set('email',{enabled:true,password:s.seal('synthetic-mail-secret')});p.configure({enabled:true,recovery:true,includeDeviceNames:false,publicOrigin:'https://health.example.test'},'Test');const sub=subscription(),id=p.subscribe(sub,'Android','Test').id,key=s.get('pushVapid').publicKey;s.run("INSERT INTO push_outbox VALUES('interrupted',NULL,?,'test',0,?,'delivering',NULL,NULL)",id,Date.now());s.close();s=new Store(file);assert.equal(s.get('pushVapid').publicKey,key);assert.equal(s.unseal(s.get('email').password),'synthetic-mail-secret');assert.equal(s.one('SELECT status FROM push_outbox').status,'uncertain');assert.equal(JSON.parse(s.unseal(s.one('SELECT json FROM push_subscriptions').json)).endpoint,sub.endpoint);}finally{s?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('shutdown waits for the current push and leaves remaining work queued for the next start',async()=>{
  const f=fixture();try{f.p.subscribe(subscription('two'),'Second browser','Test');f.state(10);f.tick();let release,started;const began=new Promise(r=>started=r);f.p.send=()=>new Promise(resolve=>{release=resolve;started();});const delivery=f.p.deliver();await began;let closed=false;const closing=f.p.close().then(()=>closed=true);assert.equal(closed,false);release();await Promise.all([delivery,closing]);assert.equal(f.s.one("SELECT count(*) n FROM push_outbox WHERE status='accepted'").n,1);assert.equal(f.s.one("SELECT count(*) n FROM push_outbox WHERE status='queued'").n,1);}finally{f.close();}
});
