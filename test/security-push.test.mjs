import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {Accounts,securityPushRecipients} from '../server/accounts.mjs';
import {SecurityEngine} from '../server/security.mjs';
import {PushService} from '../server/push.mjs';
import {SecurityActions} from '../server/security-actions.mjs';
import {createApp} from '../server/http.mjs';

const password='synthetic-security-push-password';
function subscription(name){const key=crypto.createECDH('prime256v1');key.generateKeys();return {endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-security-'+name,keys:{p256dh:key.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')}};}
function fixture(){
  let now=Date.UTC(2026,10,8,1);const s=new Store(),e=new Engine(s,{clock:()=>now}),accounts=new Accounts(s,{password,clock:()=>now}),owner=accounts.list()[0],sent=[];
  s.saveNetwork({id:'network',label:'Fixture network',host:'broker.example.test',port:1883,protocol:'mqtt',mode:'zigbee2mqtt',enabled:true,connected:true,connectedAt:now-1000,bridgeState:'online'});
  s.saveDevice({id:'contact',networkId:'network',name:'Fixture physical contact',ieee:'0x00124b0000000001',availability:'online',inventoryPresent:true});
  let security=new SecurityEngine(s,{clock:()=>now,timezone:'UTC'});
  const push=new PushService(e,{send:async(...args)=>sent.push(args)}),actions=new SecurityActions(s,{push}),config={enabled:true,recovery:true,includeDeviceNames:false,publicOrigin:'https://health.example.test'};
  push.configure(config,'Fixture');
  const area=security.saveArea({name:'Fixture protected area',entryDelaySec:0,exitDelaySec:0},'Fixture'),zone=security.saveZone({areaId:area.id,name:'Fixture door zone',deviceId:'contact',property:'contact',value:false,type:'instant'},'Fixture');
  const browser=(name='phone',user=owner)=>{const sub=subscription(name),id=push.subscribe(sub,name,user.username,user.id).id;return {id,sub,user};};
  const first=browser();
  const report=value=>{now+=10;security.ingest('contact',{contact:value},{at:now});};
  const add=(ids=[first.id],extra={})=>security.saveAction({areaId:area.id,name:'Phone Security alert',kind:'push',subscriptionIds:ids,enabled:true,...extra},'Fixture');
  const trigger=()=>{report(true);security.command(area.id,'arm_away',{},'Fixture');report(false);return security.activeIncidents()[0];};
  const deliver=()=>security.deliver((action,context,job)=>actions.send(action,context,job));
  return {s,e,accounts,owner,push,actions,config,area,zone,first,sent,browser,add,trigger,report,deliver,get security(){return security;},advance:ms=>now+=ms,restart:()=>{security=new SecurityEngine(s,{clock:()=>now,timezone:'UTC'});return security;},close:()=>s.close()};
}

test('push actions require explicit eligible Security browser IDs and no SMTP configuration',()=>{
  const f=fixture();try{
    const action=f.add();assert.equal(action.kind,'push');assert.deepEqual(action.subscriptionIds,[f.first.id]);assert.equal(f.s.get('email')?.enabled,undefined);
    const healthUser=f.accounts.create({username:'health-only',password,permissions:['viewHealth']},'Fixture'),healthBrowser=f.browser('health-browser',healthUser);
    for(const ids of [[],[f.first.id,f.first.id],['unknown'],[healthBrowser.id],Array(33).fill(f.first.id)])assert.throws(()=>f.add(ids),/browsers/);
    assert.equal(f.security.actions().length,1);
    assert.deepEqual(securityPushRecipients(f.s),[{id:f.first.id,label:'phone'}]);
  }finally{f.close();}
});

test('a fresh armed activation snapshots selected recipients and sends each browser exactly once',async()=>{
  const f=fixture();try{
    const second=f.browser('second-phone');f.add([f.first.id,second.id]);const incident=f.trigger();
    const before=f.s.all('SELECT * FROM security_push_deliveries');assert.equal(before.length,2);assert.ok(before.every(row=>row.status==='queued'&&row.owner_id===f.owner.id&&row.endpoint_hash));
    f.browser('enrolled-after-incident');await f.deliver();await f.deliver();f.report(false);await f.deliver();
    assert.equal(f.sent.length,2);for(const [,encoded,options] of f.sent){const payload=JSON.parse(encoded);assert.equal(payload.title,'Zigbee Security');assert.equal(payload.url,'/?security='+incident.id);assert.equal(payload.tag,'zh-security-'+incident.id);assert.ok(!encoded.includes('Fixture protected area')&&!encoded.includes('Fixture door zone'));assert.equal(options.urgency,'high');assert.equal(options.TTL,300);}
    assert.ok(f.s.all('SELECT status FROM security_push_deliveries').every(row=>row.status==='accepted'));
    const result=f.security.state().deliveries[0];assert.equal(result.kind,'push');assert.equal(result.results.length,2);assert.ok(result.results.every(row=>row.label&&row.status==='accepted'));
  }finally{f.close();}
});

test('Security lock-screen details require the existing global privacy opt-in',async()=>{
  const f=fixture();try{f.push.configure({...f.config,includeDeviceNames:true},'Fixture');f.add();f.trigger();await f.deliver();const body=JSON.parse(f.sent[0][1]).body;assert.match(body,/Fixture protected area/);assert.match(body,/Fixture door zone/);}finally{f.close();}
});

test('acknowledging and disarming an already-raised intrusion retain its queued Security alert',async()=>{
  const f=fixture();try{f.add();f.trigger();f.security.command(f.area.id,'acknowledge',{},'Fixture');f.security.command(f.area.id,'disarm',{},'Fixture');await f.deliver();assert.equal(f.sent.length,1);assert.equal(f.security.area(f.area.id).mode,'disarmed');}finally{f.close();}
});

test('resetting a disarmed 24-hour button alarm retains its queued Security push',async()=>{
  const f=fixture();try{
    f.security.saveZone({id:f.zone.id,type:'24hour',property:'action',value:'single',silent:true},'Fixture');
    f.add();f.security.ingest('contact',{action:'single'});
    const [alarm]=f.security.activeIncidents(f.area.id);
    assert.equal(alarm.mode,'disarmed');assert.equal(alarm.zoneType,'24hour');
    f.security.command(f.area.id,'acknowledge',{},'Fixture');
    f.security.command(f.area.id,'reset',{},'Fixture');
    assert.deepEqual(f.security.activeIncidents(f.area.id),[]);
    await f.deliver();await f.deliver();
    assert.equal(f.sent.length,1);
    const payload=JSON.parse(f.sent[0][1]);
    assert.equal(payload.body,'A security alarm was triggered. Open Security to review.');
    assert.equal(payload.url,'/?security='+alarm.id);
  }finally{f.close();}
});

test('reset, expiry, action changes and action removal permanently suppress unsent recipients',async()=>{
  for(const operation of ['reset','expiry','change','remove']){const f=fixture();try{
    const action=f.add();f.trigger();
    if(operation==='expiry')f.advance(300001);
    else{f.security.command(f.area.id,'disarm',{},'Fixture');if(operation==='reset'){f.security.command(f.area.id,'acknowledge',{},'Fixture');f.report(true);f.security.command(f.area.id,'reset',{},'Fixture');}if(operation==='change')f.security.saveAction({id:action.id,name:'Changed action'},'Fixture');if(operation==='remove')f.security.removeAction(action.id,'Fixture');}
    await f.deliver();assert.equal(f.sent.length,0,operation);assert.ok(f.s.all('SELECT status FROM security_push_deliveries').every(row=>row.status==='suppressed'),operation);
  }finally{f.close();}}
});

test('removing Security access then restoring it cannot replay its queued alerts',async()=>{
  const f=fixture();try{
    const user=f.accounts.create({username:'both-features',password,permissions:['viewHealth','viewSecurity']},'Fixture'),browser=f.browser('feature-phone',user);f.add([browser.id]);f.trigger();
    f.accounts.update({id:user.id,permissions:['viewHealth']},'Fixture');assert.equal(f.s.one('SELECT disabled_at FROM push_subscriptions WHERE id=?',browser.id).disabled_at,null);assert.equal(f.s.one('SELECT status FROM security_push_deliveries').status,'suppressed');
    f.accounts.update({id:user.id,permissions:['viewHealth','viewSecurity']},'Fixture');await f.deliver();assert.equal(f.sent.length,0);
  }finally{f.close();}
});

test('removing Health while retaining Security preserves registration and suppresses only health work',async()=>{
  const f=fixture();try{
    const user=f.accounts.create({username:'mixed-viewer',password,permissions:['viewHealth','viewSecurity']},'Fixture'),browser=f.browser('mixed-phone',user);f.add([browser.id]);f.trigger();
    f.s.run("INSERT INTO push_outbox VALUES('queued-health',NULL,?,'test',0,?,'queued',NULL,NULL)",browser.id,f.e.now());
    f.accounts.update({id:user.id,permissions:['viewSecurity']},'Fixture');assert.equal(f.s.one('SELECT disabled_at FROM push_subscriptions WHERE id=?',browser.id).disabled_at,null);assert.equal(f.s.one('SELECT status FROM push_outbox').status,'suppressed');assert.equal(f.s.one('SELECT status FROM security_push_deliveries').status,'queued');
    assert.equal(f.push.accountActive({user_id:user.id},'viewHealth'),false);assert.equal(f.push.accountActive({user_id:user.id},'viewSecurity'),true);await f.deliver();assert.equal(f.sent.length,1);
  }finally{f.close();}
});

test('losing both categories disables registrations and does not silently restore them',async()=>{
  const f=fixture();try{
    const user=f.accounts.create({username:'security-viewer',password,permissions:['viewSecurity']},'Fixture'),browser=f.browser('viewer-phone',user);f.add([browser.id]);f.trigger();
    f.accounts.update({id:user.id,permissions:[]},'Fixture');assert.ok(f.s.one('SELECT disabled_at FROM push_subscriptions WHERE id=?',browser.id).disabled_at);f.accounts.update({id:user.id,permissions:['viewSecurity']},'Fixture');await f.deliver();assert.equal(f.sent.length,0);assert.ok(f.s.one('SELECT disabled_at FROM push_subscriptions WHERE id=?',browser.id).disabled_at);
  }finally{f.close();}
});

test('disabling the global master between awaited recipients suppresses all remaining work',async()=>{
  const f=fixture();try{
    const second=f.browser('second-master-phone');f.add([f.first.id,second.id]);f.trigger();f.push.send=async(...args)=>{f.sent.push(args);f.push.configure({...f.config,enabled:false},'Fixture');};
    await f.deliver();assert.equal(f.sent.length,1);assert.deepEqual(f.s.all('SELECT status FROM security_push_deliveries').map(row=>row.status).sort(),['accepted','suppressed']);f.push.configure(f.config,'Fixture');await f.deliver();assert.equal(f.sent.length,1);
  }finally{f.close();}
});

test('permission removal and restoration between health sends cannot resurrect a suppressed queued job',async()=>{
  const f=fixture();try{
    const user=f.accounts.create({username:'health-security',password,permissions:['viewHealth','viewSecurity']},'Fixture'),one=f.browser('health-one',user),two=f.browser('health-two',user);
    for(const [index,browser] of [one,two].entries())f.s.run("INSERT INTO push_outbox VALUES(?,NULL,?,'test',0,?,'queued',NULL,NULL)",'health-'+index,browser.id,f.e.now());
    f.push.send=async(...args)=>{f.sent.push(args);f.accounts.update({id:user.id,permissions:['viewSecurity']},'Fixture');f.accounts.update({id:user.id,permissions:['viewHealth','viewSecurity']},'Fixture');};
    await f.push.deliver();assert.equal(f.sent.length,1);assert.deepEqual(f.s.all('SELECT status FROM push_outbox ORDER BY id').map(row=>row.status),['accepted','suppressed']);
  }finally{f.close();}
});

test('aged Security alerts use only their remaining five-minute push lifetime',async()=>{
  const f=fixture();try{f.add();f.trigger();f.advance(290000);await f.deliver();assert.equal(f.sent.length,1);assert.equal(f.sent[0][2].TTL,10);}finally{f.close();}
});

test('changing a queued recipient owner or endpoint identity cannot retarget an old alarm',async()=>{
  for(const field of ['user_id','endpoint_hash']){const f=fixture();try{
    f.add();f.trigger();f.s.run('UPDATE push_subscriptions SET '+field+'=? WHERE id=?',field==='user_id'?'different-owner':'different-endpoint',f.first.id);await f.deliver();assert.equal(f.sent.length,0,field);assert.equal(f.s.one('SELECT status FROM security_push_deliveries').status,'suppressed');
  }finally{f.close();}}
});

test('provider failures and expired browser registrations get one durable attempt without retries',async()=>{
  for(const statusCode of [410,503]){const f=fixture();try{
    let attempts=0;f.push.send=async()=>{attempts++;throw Object.assign(Error('private provider response'),{statusCode});};f.add();f.trigger();await f.deliver();await f.deliver();assert.equal(attempts,1);assert.equal(f.s.one('SELECT status FROM security_push_deliveries').status,statusCode===410?'expired':'uncertain');assert.equal(f.security.state().deliveries[0].status,'uncertain');assert.equal(JSON.stringify(f.push.status(f.owner.id,true)).includes('private provider response'),false);
  }finally{f.close();}}
});

test('restarts suppress queued Security push and retain in-progress uncertainty without replay',async()=>{
  for(const status of ['queued','delivering']){const f=fixture();try{
    f.add();f.trigger();if(status==='delivering')f.s.run("UPDATE security_push_deliveries SET status='delivering'");f.restart();await f.deliver();assert.equal(f.sent.length,0);assert.equal(f.s.one('SELECT status FROM security_push_deliveries').status,status==='queued'?'suppressed':'uncertain');
  }finally{f.close();}}
});

test('Security preview is own-only, rate limited, clearly labelled and never arms or raises an intrusion',async()=>{
  const f=fixture();try{
    const before=f.security.areas();assert.equal((await f.push.securityTest(f.first.id,f.owner.id)).status,'accepted');const payload=JSON.parse(f.sent[0][1]);assert.equal(payload.title,'Security notification test');assert.match(payload.body,/no alarm was triggered/);assert.equal(payload.url,'/?security=test');assert.equal(f.sent[0][2].urgency,'high');assert.deepEqual(f.security.areas(),before);assert.equal(f.security.activeIncidents().length,0);assert.equal(f.security.queuedActions().length,0);await assert.rejects(f.push.securityTest(f.first.id,f.owner.id),/one minute/);
    const other=f.accounts.create({username:'other-security',password,permissions:['viewSecurity']},'Fixture'),browser=f.browser('other-phone',other);await assert.rejects(f.push.securityTest(browser.id,f.owner.id),/not found/);assert.equal(f.sent.length,1);
  }finally{f.close();}
});

test('Security DTOs and personal histories never disclose encrypted subscriptions or push keys',async()=>{
  const f=fixture();try{
    f.add();f.trigger();await f.deliver();const encoded=JSON.stringify({security:f.security.state(),push:f.push.status(f.owner.id,true)}),pair=f.s.get('pushVapid');for(const secret of [f.first.sub.endpoint,f.first.sub.keys.p256dh,f.first.sub.keys.auth,pair.privateKey,f.s.unseal(pair.privateKey)])assert.equal(encoded.includes(secret),false);
    assert.equal(f.push.status(f.owner.id,true).subscriptions[0].owned,true);assert.deepEqual(f.push.status(f.owner.id,true).supports,{health:true,security:true});assert.equal(f.push.status(f.owner.id,true).securityDeliveries[0].status,'accepted');
  }finally{f.close();}
});

test('real HTTP permissions allow Security-only enrolment and own preview while keeping setup lists private',async()=>{
  const f=fixture();let server;
  try{
    const securityUser=f.accounts.create({username:'security-reader',password,permissions:['viewSecurity']},'Fixture'),healthUser=f.accounts.create({username:'health-reader',password,permissions:['viewHealth']},'Fixture'),manager=f.accounts.create({username:'security-manager',password,permissions:['manageSecurity']},'Fixture');
    server=createApp(f.e,{password,security:f.security,push:f.push,securityActions:f.actions});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const request=(route,body,cookie,origin='https://health.example.test')=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/api/'+route,method:body===undefined?'GET':'POST',headers:{Host:'health.example.test',Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})}},res=>{let raw='';res.on('data',part=>raw+=part);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw),cookie:res.headers['set-cookie']?.[0].split(';')[0]}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
    const reader=await request('login',{username:securityUser.username,password}),health=await request('login',{username:healthUser.username,password}),setup=await request('login',{username:manager.username,password}),admin=await request('login',{username:'admin',password});
    const candidate=subscription('security-only-http'),enrolled=await request('push/subscribe',{subscription:candidate,label:'Security-only phone'},reader.cookie);assert.equal(enrolled.status,201);
    const status=await request('push',undefined,reader.cookie);assert.deepEqual(status.body.supports,{health:false,security:true});assert.equal(status.body.subscriptions.length,1);assert.equal(status.body.subscriptions[0].owned,true);
    assert.equal((await request('security/push-test',{subscriptionId:enrolled.body.id},reader.cookie)).body.status,'accepted');assert.equal((await request('security/push-test',{subscriptionId:enrolled.body.id},admin.cookie)).status,400);assert.equal((await request('security/push-test',{subscriptionId:f.first.id},health.cookie)).status,403);
    const readerState=(await request('security',undefined,reader.cookie)).body;assert.equal(readerState.securityPushRecipients,undefined);assert.equal(readerState.securityPushSettings,undefined);const setupState=(await request('security',undefined,setup.cookie)).body;assert.equal(setupState.securityPushRecipients.length,2);assert.deepEqual(Object.keys(setupState.securityPushRecipients[0]).sort(),['id','label']);assert.deepEqual(setupState.securityPushSettings,{enabled:true,includeDeviceNames:false});
    assert.equal((await request('push/settings',f.config,reader.cookie)).status,403);assert.equal((await request('push/subscribe',{subscription:subscription('cross-origin'),label:'Not enrolled'},reader.cookie,'https://other.example.test')).status,403);
    assert.equal(f.security.activeIncidents().length,0);assert.equal(f.sent.length,1);
  }finally{server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));f.close();}
});
