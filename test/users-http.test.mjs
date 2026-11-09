import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {createApp} from '../server/http.mjs';
import {PushService} from '../server/push.mjs';

const adminPassword='synthetic-admin-password';
const userPassword='synthetic-user-password';
const changedPassword='synthetic-new-password';
const featureKeys=['viewHealth','viewReports','acknowledge','manageShunts','manageDevices','manageBrokers','manageThresholds','manageEmail','manageNotifications'];

async function fixture(){
  const s=new Store(),e=new Engine(s),now=e.now();
  s.saveNetwork({id:'fixture-network',label:'Fixture network',host:'broker.fixture.test',port:1883,protocol:'mqtt',baseTopic:'zigbee2mqtt',enabled:true,connected:true,connectedAt:now-60000,attemptAt:now-60000,bridgeState:'online',username:'fixture-broker-user',password:s.seal('fixture-broker-secret')});
  s.set('email',{enabled:true,host:'smtp.fixture.test',port:587,tlsMode:'starttls',sender:'sender@example.test',recipient:'recipient@example.test',username:'fixture-smtp-user',password:s.seal('fixture-smtp-secret')});
  e.ingest('fixture-network','zigbee2mqtt/bridge/devices',[{ieee_address:'0x0102030405060708',friendly_name:'Fixture sensor',type:'EndDevice',power_source:'Battery'}]);
  const device=s.devices()[0];
  for(const [id,restored] of [['fixture-alarm',null],['fixture-restored-alarm',now-1000]])s.run('INSERT INTO incidents(id,device_id,network_id,category,priority,opened_at,restored_at,description) VALUES(?,?,?,?,?,?,?,?)',id,device.id,device.networkId,'offline','critical',now-60000,restored,'Fixture offline alarm');
  const sent=[],push=new PushService(e,{send:async(...args)=>{sent.push(args);return {statusCode:201};}});
  const server=createApp(e,{password:adminPassword,push});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url='http://127.0.0.1:'+server.address().port;
  const request=(route,body,cookie,headers={})=>new Promise((resolve,reject)=>{
    const request=http.request(url+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{cookie}:{}),...headers}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
      response.on('end',()=>{try{const contentType=response.headers['content-type']||'',raw=Buffer.concat(chunks).toString();resolve({status:response.statusCode,body:contentType.includes('application/json')?JSON.parse(raw):raw,contentType,cookie:response.headers['set-cookie']?.[0]});}catch(error){reject(error);}});
    });
    request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));
  });
  const login=async(username,password=userPassword,rememberMe=false,extra={})=>{
    const response=await request('login',{username,password,rememberMe,...extra});
    return {...response,session:response.cookie?.split(';')[0]};
  };
  const admin=await login('admin',adminPassword);
  assert.equal(admin.status,200);
  const create=async(username,role='viewer',extra={})=>{
    const response=await request('users',{username,displayName:'Fixture '+username,role,password:userPassword,...extra},admin.session);
    assert.equal(response.status,201,JSON.stringify(response.body));
    return response.body.user;
  };
  return {s,e,url,request,login,create,admin,device,push,sent,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await push.close();s.close();}};
}

function subscription(suffix){const key=crypto.createECDH('prime256v1');key.generateKeys();return {endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-users-'+suffix,keys:{p256dh:key.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')}};}
const canonicalHeaders={Host:'health.fixture.test',Origin:'https://health.fixture.test'};
const pushSettings={enabled:true,recovery:true,includeDeviceNames:false,publicOrigin:'https://health.fixture.test'};

function assertSafeUser(user){
  assert.equal(typeof user.id,'string');assert.equal(typeof user.username,'string');
  const encoded=JSON.stringify(user);
  assert.doesNotMatch(encoded,/password|salt|token_hash|credential_tag|encryptionKey/i);
  for(const secret of [adminPassword,userPassword,changedPassword])assert.ok(!encoded.includes(secret));
}

test('administrator migration, user creation and role identities are available without credential material',async()=>{
  const f=await fixture();try{
    assert.equal((await f.request('users')).status,401);
    assertSafeUser(f.admin.body.user);assert.equal(f.admin.body.user.username,'admin');assert.equal(f.admin.body.user.role,'admin');
    const initial=await f.request('users',undefined,f.admin.session);
    assert.equal(initial.status,200);assert.deepEqual(initial.body.roles,['admin','operator','viewer']);assert.equal(initial.body.users.length,1);assertSafeUser(initial.body.users[0]);
    const created=await f.create('operator-one','operator');assertSafeUser(created);
    const operator=await f.login('operator-one');assert.equal(operator.status,200);assert.equal(operator.body.user.id,created.id);assertSafeUser(operator.body.user);
    const state=await f.request('state',undefined,operator.session);
    assert.equal(state.body.currentUser.username,'operator-one');assert.equal(state.body.permissions.configure,false);assert.equal(state.body.permissions.manageUsers,false);assert.equal(state.body.permissions.operateAlarms,true);
    for(const key of ['viewHealth','viewReports','acknowledge','manageShunts'])assert.equal(state.body.permissions[key],true,key);
    const adminState=await f.request('state',undefined,f.admin.session);
    for(const key of [...featureKeys,'configure','manageUsers','operateAlarms'])assert.equal(adminState.body.permissions[key],true,key);
    assert.equal((await f.request('users',{username:'operator-one',password:userPassword,role:'viewer'},f.admin.session)).status,400);
    assert.equal((await f.request('users',{username:'invalid user',password:userPassword,role:'viewer'},f.admin.session)).status,400);
    assert.equal((await f.request('users',{username:'short-password',password:'short',role:'viewer'},f.admin.session)).status,400);
    assert.equal((await f.request('users',{username:'invalid-role',password:userPassword,role:'owner'},f.admin.session)).status,400);
  }finally{await f.close();}
});

test('viewers can inspect health and reports, with broker and mail configuration redacted',async()=>{
  const f=await fixture();try{
    const viewer=await f.create('viewer-one'),operator=await f.create('operator-one','operator');
    const hidden=await f.create('hidden-permission-user');
    assert.equal((await f.request('users/update',{id:hidden.id,permissions:['viewHealth']},f.admin.session)).status,200);
    for(const user of [viewer,operator]){
      const signedIn=await f.login(user.username),state=await f.request('state',undefined,signedIn.session);
      assert.equal(state.status,200);assertSafeUser(state.body.currentUser);
      assert.equal(state.body.currentUser.role,user.role);assert.equal(state.body.permissions.operateAlarms,user.role==='operator');
      assert.deepEqual(state.body.email,{enabled:true});
      const network=state.body.networks[0];assert.equal(network.label,'Fixture network');
      for(const field of ['host','port','protocol','baseTopic','username','password','passwordSet','topicFilters'])assert.ok(!Object.hasOwn(network,field),field+' should not be disclosed');
      assert.deepEqual(state.body.traffic,{});
      assert.ok(!state.body.events.some(event=>event.type==='permissions_changed'));
      for(const secret of ['broker.fixture.test','fixture-broker-user','smtp.fixture.test','sender@example.test','recipient@example.test','fixture-smtp-user','hidden-permission-user'])assert.ok(!JSON.stringify(state.body).includes(secret));
      assert.equal((await f.request('report?device='+encodeURIComponent(f.device.id),undefined,signedIn.session)).status,200);
      assert.equal((await f.request('users',undefined,signedIn.session)).status,403);
      assert.equal((await f.request('network-log?network=fixture-network',undefined,signedIn.session)).status,403);
    }
    const adminState=await f.request('state',undefined,f.admin.session);
    assert.equal(adminState.body.networks[0].host,'broker.fixture.test');assert.equal(adminState.body.email.recipient,'recipient@example.test');
    assert.ok(adminState.body.events.some(event=>event.type==='permissions_changed'&&event.message.includes('hidden-permission-user')));
    assert.equal((await f.request('network-log?network=fixture-network',undefined,f.admin.session)).status,200);
  }finally{await f.close();}
});

test('the server rejects viewer operations and all lower-role configuration or account administration',async()=>{
  const f=await fixture();try{
    const users=[await f.create('viewer-one'),await f.create('operator-one','operator')];
    const configBefore=JSON.stringify({thresholds:f.e.thresholds(),email:f.s.get('email'),networks:f.s.networks(),device:f.s.device(f.device.id)});
    const adminRequests=[
      ['users',{username:'forged-admin',role:'admin',password:userPassword}],
      ['users/update',{id:users[0].id,role:'admin',enabled:true}],
      ['users/reset-password',{id:f.admin.body.user.id,password:changedPassword}],
      ['users/revoke-sessions',{id:f.admin.body.user.id}],
      ['thresholds',{retentionDays:7}],['device',{id:f.device.id,room:'Unauthorised room'}],
      ['networks',{id:'fixture-network',label:'Unauthorised network',host:'other.fixture.test',port:1883,protocol:'mqtt',baseTopic:'zigbee2mqtt',enabled:true}],
      ['email',{enabled:false}],['push/settings',{enabled:false}],
      ['devices/retire',{id:f.device.id,reason:'Unauthorised retirement'}],
      ['devices/restore',{id:f.device.id,reason:'Unauthorised restore'}],
      ['devices/delete-history',{id:f.device.id,reason:'Unauthorised deletion',confirmName:f.device.name,confirmation:'DELETE HISTORY'}],
      ['devices/link',{sourceId:f.device.id,targetId:'another-device',kind:'replacement',reason:'Unauthorised link'}],
      ['devices/unlink',{id:'a-link',reason:'Unauthorised unlink'}]
    ];
    for(const user of users){
      const signedIn=await f.login(user.username,userPassword,false,{role:'admin',id:f.admin.body.user.id});
      assert.equal(signedIn.body.user.role,user.role);
      for(const [route,body] of adminRequests){const result=await f.request(route,{...body,actor:'admin',role:body.role||'admin'},signedIn.session);assert.equal(result.status,403,user.role+' '+route);}
      assert.equal((await f.request('state',undefined,signedIn.session)).body.currentUser.role,user.role);
    }
    const signedIn=await f.login('viewer-one');
    for(const [route,body] of [
      ['alarms/acknowledge',{ids:['fixture-alarm'],note:'Forged acknowledgement'}],
      ['alarms/process',{id:'fixture-restored-alarm'}],
      ['alarms/process-all',{}],
      ['shunts',{scopeType:'device',scopeId:f.device.id,durationMin:60,reason:'Forged shunt'}],
      ['shunts/cancel',{id:'some-shunt'}]
    ])assert.equal((await f.request(route,body,signedIn.session)).status,403,route);
    assert.equal(f.s.one('SELECT ack_at FROM incidents WHERE id=?','fixture-alarm').ack_at,null);
    assert.equal(f.s.one('SELECT processed_at FROM incidents WHERE id=?','fixture-restored-alarm').processed_at,null);
    assert.equal(f.s.all('SELECT * FROM shunts').length,0);
    assert.equal(JSON.stringify({thresholds:f.e.thresholds(),email:f.s.get('email'),networks:f.s.networks(),device:f.s.device(f.device.id)}),configBefore);
    assert.equal((await f.request('users',undefined,f.admin.session)).body.users.length,3);
  }finally{await f.close();}
});

test('operator acknowledgement, restored processing and shunting use the authenticated username in audit records',async()=>{
  const f=await fixture();try{
    await f.create('operator-one','operator');const operator=await f.login('operator-one');
    assert.equal((await f.request('alarms/acknowledge',{ids:['fixture-alarm'],note:'Operator inspected sensor',actor:'admin'},operator.session)).status,200);
    assert.equal(f.s.one('SELECT ack_by FROM incidents WHERE id=?','fixture-alarm').ack_by,'operator-one');
    assert.equal((await f.request('alarms/process',{id:'fixture-restored-alarm',note:'Operator checked recovery',actor:'admin'},operator.session)).status,200);
    const shunt=await f.request('shunts',{scopeType:'device',scopeId:f.device.id,durationMin:60,reason:'Operator replacing battery',actor:'admin'},operator.session);
    assert.equal(shunt.status,201);assert.equal(shunt.body.actor,'operator-one');
    assert.equal((await f.request('shunts/cancel',{id:shunt.body.id,actor:'admin'},operator.session)).status,200);
    for(const type of ['acknowledged','processed','shunt_created','shunt_cancelled']){
      const events=f.s.all('SELECT * FROM events WHERE type=?',type);assert.equal(events.length,1);assert.equal(events[0].actor,'operator-one');
    }
  }finally{await f.close();}
});

test('operator bulk processing is server-selected and retries do not process or audit an alarm twice',async()=>{
  const f=await fixture();
  try{
    const route='alarms/process-all';
    assert.equal((await f.request(route,{})).status,401);
    await f.create('operator-one','operator');
    const operator=await f.login('operator-one');
    assert.equal((await f.request(route,{ids:['fixture-alarm'],actor:'admin'},operator.session)).status,400);
    const first=await f.request(route,{},operator.session);
    assert.equal(first.status,200);
    assert.deepEqual(first.body,{processed:1});
    const retry=await f.request(route,{},operator.session);
    assert.equal(retry.status,200);
    assert.deepEqual(retry.body,{processed:0});
    const state=await f.request('state',undefined,operator.session);
    assert.deepEqual(state.body.alarms.map(alarm=>alarm.id),['fixture-alarm']);
    assert.deepEqual(f.s.all("SELECT incident_id,actor FROM events WHERE type='processed'").map(event=>({...event})),[
      {incident_id:'fixture-restored-alarm',actor:'operator-one'}
    ]);
  }finally{await f.close();}
});

test('disabled users, role changes, password reset and explicit revocation invalidate normal and remembered sessions',async()=>{
  for(const operation of ['disable','role','reset','revoke']){
    const f=await fixture();try{
      const target=await f.create('target-user'),normal=await f.login(target.username),remembered=await f.login(target.username,userPassword,true);
      assert.match(remembered.cookie,/Max-Age=2592000/);
      const [route,body]=operation==='disable'?['users/update',{id:target.id,enabled:false}]:operation==='role'?['users/update',{id:target.id,role:'operator'}]:operation==='reset'?['users/reset-password',{id:target.id,password:changedPassword}]:['users/revoke-sessions',{id:target.id}];
      assert.equal((await f.request(route,body,f.admin.session)).status,200,operation);
      for(const session of [normal.session,remembered.session])assert.equal((await f.request('state',undefined,session)).status,401,operation);
      assert.equal((await f.request('state',undefined,f.admin.session)).status,200);
      if(operation==='disable'){
        assert.equal((await f.login(target.username)).status,401);
        assert.equal((await f.request('users/update',{id:target.id,enabled:true},f.admin.session)).status,200);
        assert.equal((await f.login(target.username)).status,200);
        assert.equal((await f.request('state',undefined,remembered.session)).status,401);
      }else if(operation==='reset'){
        assert.equal((await f.login(target.username)).status,401);
        assert.equal((await f.login(target.username,changedPassword)).status,200);
      }else if(operation==='role')assert.equal((await f.login(target.username)).body.user.role,'operator');
      else assert.equal((await f.login(target.username)).status,200);
    }finally{await f.close();}
  }
});

test('self-service password change checks the old password and signs out every session of only that user',async()=>{
  const f=await fixture();try{
    const target=await f.create('viewer-one'),normal=await f.login(target.username),remembered=await f.login(target.username,userPassword,true);
    assert.equal((await f.request('account/password',{currentPassword:'wrong-password',newPassword:changedPassword},normal.session)).status,400);
    assert.equal((await f.request('state',undefined,normal.session)).status,200);
    const changed=await f.request('account/password',{currentPassword:userPassword,newPassword:changedPassword,role:'admin',id:f.admin.body.user.id},normal.session);
    assert.equal(changed.status,200);assert.match(changed.cookie,/Max-Age=0/);
    for(const session of [normal.session,remembered.session])assert.equal((await f.request('state',undefined,session)).status,401);
    assert.equal((await f.request('state',undefined,f.admin.session)).status,200);
    assert.equal((await f.login(target.username)).status,401);
    const newLogin=await f.login(target.username,changedPassword);assert.equal(newLogin.status,200);assert.equal(newLogin.body.user.role,'viewer');
    assert.equal((await f.login('admin',adminPassword)).status,200);
    const event=f.s.one('SELECT * FROM events WHERE type=?','password_changed');assert.equal(event.actor,target.username);
    assert.ok(!JSON.stringify(event).includes(changedPassword));assert.ok(!JSON.stringify(event).includes(userPassword));
  }finally{await f.close();}
});

test('the final enabled administrator cannot be disabled or demoted, and account writes retain same-origin protection',async()=>{
  const f=await fixture();try{
    const id=f.admin.body.user.id;
    for(const change of [{enabled:false},{role:'viewer'}]){
      const rejected=await f.request('users/update',{id,...change},f.admin.session);
      assert.equal(rejected.status,400);assert.match(rejected.body.error,/at least one enabled administrator/i);
    }
    assert.equal((await f.request('users',{username:'cross-origin',password:userPassword,role:'admin'},f.admin.session,{Origin:'https://untrusted.example.test'})).status,403);
    assert.equal((await f.request('users',undefined,f.admin.session)).body.users.length,1);
    const replacement=await f.create('admin-two','admin'),second=await f.login(replacement.username);
    assert.equal((await f.request('users/update',{id,role:'operator'},second.session)).status,200);
    assert.equal((await f.request('state',undefined,f.admin.session)).status,401);
    const original=await f.login('admin',adminPassword);assert.equal(original.body.user.role,'operator');
    assert.equal((await f.request('users/update',{id:replacement.id,enabled:false},second.session)).status,400);
    assert.equal((await f.request('users',undefined,original.session)).status,403);
  }finally{await f.close();}
});

test('browser enrollment is owned by the signed-in user and push status hides other users registrations and deliveries',async()=>{
  const f=await fixture();try{
    const viewer=await f.create('viewer-one'),operator=await f.create('operator-one','operator');
    const viewerLogin=await f.login(viewer.username),operatorLogin=await f.login(operator.username);
    assert.equal((await f.request('push/settings',pushSettings,f.admin.session)).status,200);
    const viewerSub=subscription('viewer'),operatorSub=subscription('operator');
    assert.equal((await f.request('push/subscribe',{subscription:viewerSub,label:'Wrong origin'},viewerLogin.session)).status,400);
    const own=await f.request('push/subscribe',{subscription:viewerSub,label:'Viewer browser',userId:operator.id,role:'admin'},viewerLogin.session,canonicalHeaders);
    const other=await f.request('push/subscribe',{subscription:operatorSub,label:'Operator browser',userId:viewer.id,role:'admin'},operatorLogin.session,canonicalHeaders);
    assert.equal(own.status,201,JSON.stringify(own.body));assert.equal(other.status,201,JSON.stringify(other.body));
    assert.equal(f.s.one('SELECT user_id FROM push_subscriptions WHERE id=?',own.body.id).user_id,viewer.id);
    assert.equal(f.s.one('SELECT user_id FROM push_subscriptions WHERE id=?',other.body.id).user_id,operator.id);
    for(const [signedIn,id] of [[viewerLogin,own.body.id],[operatorLogin,other.body.id]]){
      const status=await f.request('push',undefined,signedIn.session);assert.equal(status.status,200);
      assert.deepEqual(status.body.subscriptions.map(row=>row.id),[id]);
      assert.ok(status.body.deliveries.length>0);assert.ok(status.body.deliveries.every(row=>row.subscription_id===id));
      const encoded=JSON.stringify(status.body);
      for(const sub of [viewerSub,operatorSub])for(const secret of [sub.endpoint,sub.keys.p256dh,sub.keys.auth])assert.ok(!encoded.includes(secret));
    }
    const all=await f.request('push',undefined,f.admin.session);
    assert.deepEqual(new Set(all.body.subscriptions.map(row=>row.id)),new Set([own.body.id,other.body.id]));
    assert.equal(all.body.deliveries.length,4);assert.equal(f.sent.length,0,'Enrollment must not replay existing alarms');
    const audited=f.s.all("SELECT actor FROM events WHERE type='push_browser_enabled'").map(row=>row.actor);
    assert.deepEqual(audited,['viewer-one','operator-one']);
  }finally{await f.close();}
});

test('a user cannot test, remove, or claim another browser registration, while an admin can remove it',async()=>{
  const f=await fixture();try{
    const viewer=await f.create('viewer-one'),operator=await f.create('operator-one','operator');
    const viewerLogin=await f.login(viewer.username),operatorLogin=await f.login(operator.username);
    assert.equal((await f.request('push/settings',pushSettings,f.admin.session)).status,200);
    const sub=subscription('owner');
    const enrolled=await f.request('push/subscribe',{subscription:sub,label:'Owned browser'},viewerLogin.session,canonicalHeaders);
    assert.equal(enrolled.status,201);const id=enrolled.body.id;
    for(const route of ['push/test','push/remove']){
      const denied=await f.request(route,{id,userId:viewer.id,admin:true,role:'admin'},operatorLogin.session);
      assert.equal(denied.status,400);assert.match(denied.body.error,/not found/i);
    }
    const claim=await f.request('push/subscribe',{subscription:sub,label:'Claimed browser',userId:viewer.id},operatorLogin.session,canonicalHeaders);
    assert.equal(claim.status,400);assert.match(claim.body.error,/another user/i);
    assert.equal(f.s.one('SELECT user_id FROM push_subscriptions WHERE id=?',id).user_id,viewer.id);assert.equal(f.sent.length,0);
    const tested=await f.request('push/test',{id,userId:operator.id},viewerLogin.session);
    assert.equal(tested.status,200);assert.equal(tested.body.status,'accepted');assert.equal(f.sent.length,1);
    assert.equal(f.sent[0][0].endpoint,sub.endpoint);assert.equal(JSON.parse(f.sent[0][1]).tag,'zigbee-health-test');
    assert.equal((await f.request('push',undefined,operatorLogin.session)).body.deliveries.length,0);
    assert.equal((await f.request('push/remove',{id},f.admin.session)).status,200);
    assert.equal((await f.request('push',undefined,viewerLogin.session)).body.subscriptions.length,0);
    assert.equal((await f.request('push',undefined,f.admin.session)).body.subscriptions.length,0);
    assert.equal(f.s.one("SELECT actor FROM events WHERE type='push_browser_removed'").actor,'admin');
  }finally{await f.close();}
});

test('disabling a browser owner stops queued delivery and re-enabling the account does not re-enable its browser',async()=>{
  const f=await fixture();try{
    const viewer=await f.create('viewer-one'),viewerLogin=await f.login(viewer.username);
    assert.equal((await f.request('push/settings',pushSettings,f.admin.session)).status,200);
    const sub=subscription('disabled-owner'),enrolled=await f.request('push/subscribe',{subscription:sub,label:'Viewer browser'},viewerLogin.session,canonicalHeaders);
    assert.equal(enrolled.status,201);const id=enrolled.body.id;
    // An already queued test exercises the delivery race between queuing and disabling an account.
    f.s.run("INSERT INTO push_outbox VALUES('fixture-queued-test',NULL,?,'test',0,?,'queued',NULL,NULL)",id,f.e.now());
    assert.equal((await f.request('users/update',{id:viewer.id,enabled:false},f.admin.session)).status,200);
    await f.push.deliver();assert.equal(f.sent.length,0);
    assert.equal(f.s.one('SELECT status FROM push_outbox WHERE id=?','fixture-queued-test').status,'suppressed');
    assert.ok(f.s.one('SELECT disabled_at FROM push_subscriptions WHERE id=?',id).disabled_at);
    assert.equal((await f.request('push/test',{id},f.admin.session)).status,400);
    assert.equal((await f.request('users/update',{id:viewer.id,enabled:true},f.admin.session)).status,200);
    const signedIn=await f.login(viewer.username),status=await f.request('push',undefined,signedIn.session);
    assert.equal(status.body.subscriptions[0].id,id);assert.ok(status.body.subscriptions[0].disabled_at);
    assert.equal((await f.request('push/test',{id},signedIn.session)).status,400);assert.equal(f.sent.length,0);
    const enabled=await f.request('push/subscribe',{subscription:sub,label:'Viewer browser'},signedIn.session,canonicalHeaders);
    assert.equal(enabled.status,201);assert.equal(enabled.body.id,id);
    // Respect the one-minute explicit-test throttle from the formerly queued test.
    const resumedAt=f.e.now();f.e.clock=()=>resumedAt+61000;
    const tested=await f.request('push/test',{id},signedIn.session);
    assert.equal(tested.status,200,JSON.stringify(tested.body));assert.equal(tested.body.status,'accepted');assert.equal(f.sent.length,1);
  }finally{await f.close();}
});

test('a viewer with broker management can inspect traffic and save brokers while other administration remains denied',async()=>{
  const f=await fixture();try{
    const permissions=['viewHealth','manageBrokers'],viewer=await f.create('broker-manager','viewer',{permissions});
    assert.deepEqual(new Set(viewer.permissions),new Set(permissions));
    const signedIn=await f.login(viewer.username),state=await f.request('state',undefined,signedIn.session);
    assert.equal(state.body.currentUser.role,'viewer');assert.equal(state.body.permissions.manageBrokers,true);assert.equal(state.body.permissions.manageUsers,false);
    assert.equal(state.body.networks[0].host,'broker.fixture.test');assert.equal(state.body.networks[0].username,'fixture-broker-user');
    assert.equal((await f.request('network-log?network=fixture-network',undefined,signedIn.session)).status,200);
    assert.equal((await f.request('networks',{id:'fixture-network',label:'Updated by broker manager',host:'broker.fixture.test',port:1883,protocol:'mqtt',baseTopic:'zigbee2mqtt',enabled:true,username:'fixture-broker-user',role:'admin'},signedIn.session)).status,200);
    assert.equal(f.s.network('fixture-network').label,'Updated by broker manager');assert.equal(f.s.unseal(f.s.network('fixture-network').password),'fixture-broker-secret');
    assert.equal(f.s.one("SELECT actor FROM events WHERE type='network_settings_changed'").actor,'broker-manager');
    assert.equal((await f.request('users',undefined,signedIn.session)).status,403);
    assert.equal((await f.request('users/update',{id:viewer.id,role:'admin',permissions:featureKeys},signedIn.session)).status,403);
    assert.equal((await f.request('email',{enabled:false},signedIn.session)).status,403);
    assert.equal((await f.request('thresholds',{retentionDays:7},signedIn.session)).status,403);
    assert.equal((await f.request('device',{id:f.device.id,room:'Not allowed'},signedIn.session)).status,403);
    assert.equal((await f.request('push/settings',{...pushSettings,enabled:false},signedIn.session)).status,403);
    assert.equal((await f.request('report?device='+encodeURIComponent(f.device.id),undefined,signedIn.session)).status,403);
    assert.equal((await f.request('report.csv?device='+encodeURIComponent(f.device.id),undefined,signedIn.session)).status,403);
    assert.equal(f.s.get('email').enabled,true);assert.equal(f.e.thresholds().retentionDays,90);
  }finally{await f.close();}
});

test('custom feature checkboxes override an operator role preset at the API boundary',async()=>{
  const f=await fixture();try{
    const operator=await f.create('limited-operator','operator',{permissions:['viewHealth']}),signedIn=await f.login(operator.username);
    const state=await f.request('state',undefined,signedIn.session);
    assert.deepEqual(state.body.currentUser.permissions,['viewHealth']);assert.ok(state.body.alarms.length>0);assert.ok(state.body.devices.length>0);
    assert.equal(state.body.permissions.viewHealth,true);assert.equal(state.body.permissions.acknowledge,false);assert.equal(state.body.permissions.manageShunts,false);assert.equal(state.body.permissions.viewReports,false);
    for(const [route,body] of [
      ['alarms/acknowledge',{ids:['fixture-alarm'],permissions:featureKeys,role:'admin'}],
      ['alarms/process',{id:'fixture-restored-alarm'}],
      ['shunts',{scopeType:'device',scopeId:f.device.id,durationMin:60,reason:'Not granted'}],
      ['shunts/cancel',{id:'a-shunt'}]
    ])assert.equal((await f.request(route,body,signedIn.session)).status,403,route);
    for(const route of ['report?device='+encodeURIComponent(f.device.id),'report.csv?device='+encodeURIComponent(f.device.id),'network-log?network=fixture-network','users'])assert.equal((await f.request(route,undefined,signedIn.session)).status,403,route);
    assert.equal(f.s.one('SELECT ack_at FROM incidents WHERE id=?','fixture-alarm').ack_at,null);assert.equal(f.s.all('SELECT * FROM shunts').length,0);
  }finally{await f.close();}
});

test('an account with no feature access receives minimal state and can still manage its own password',async()=>{
  const f=await fixture();try{
    const user=await f.create('no-feature-user','operator',{permissions:[]}),signedIn=await f.login(user.username),state=await f.request('state',undefined,signedIn.session);
    assert.equal(state.status,200);assert.equal(state.body.currentUser.id,user.id);assert.deepEqual(state.body.currentUser.permissions,[]);
    for(const key of featureKeys)assert.equal(state.body.permissions[key],false,key);
    for(const key of ['devices','alarms','shunts','events','links','networks','deliveries'])assert.deepEqual(state.body[key],[],key);
    for(const secret of ['broker.fixture.test','smtp.fixture.test','sender@example.test','recipient@example.test','Fixture sensor'])assert.ok(!JSON.stringify(state.body).includes(secret));
    assert.equal((await f.request('report?device='+encodeURIComponent(f.device.id),undefined,signedIn.session)).status,403);
    assert.equal((await f.request('report.csv?device='+encodeURIComponent(f.device.id),undefined,signedIn.session)).status,403);
    assert.equal((await f.request('network-log?network=fixture-network',undefined,signedIn.session)).status,403);
    assert.equal((await f.request('users',undefined,signedIn.session)).status,403);
    assert.equal((await f.request('push',undefined,signedIn.session)).status,200);
    assert.equal((await f.request('push/settings',pushSettings,signedIn.session)).status,403);
    assert.equal((await f.request('push/settings',pushSettings,f.admin.session)).status,200);
    assert.equal((await f.request('push/subscribe',{subscription:subscription('no-features'),label:'Not permitted'},signedIn.session,canonicalHeaders)).status,403);
    assert.equal((await f.request('push/test',{id:'another-browser'},signedIn.session)).status,403);
    const changed=await f.request('account/password',{currentPassword:userPassword,newPassword:changedPassword},signedIn.session);
    assert.equal(changed.status,200);assert.equal((await f.request('state',undefined,signedIn.session)).status,401);
    const relogged=await f.login(user.username,changedPassword);assert.equal(relogged.status,200);assert.deepEqual(relogged.body.user.permissions,[]);
  }finally{await f.close();}
});

test('feature permission changes revoke existing sessions and new sessions obey the new grants',async()=>{
  const f=await fixture();try{
    const user=await f.create('changed-permissions','viewer'),normal=await f.login(user.username),remembered=await f.login(user.username,userPassword,true);
    assert.equal((await f.request('report?device='+encodeURIComponent(f.device.id),undefined,normal.session)).status,200);
    const updated=await f.request('users/update',{id:user.id,permissions:['viewHealth','acknowledge']},f.admin.session);
    assert.equal(updated.status,200);assert.deepEqual(new Set(updated.body.user.permissions),new Set(['viewHealth','acknowledge']));
    for(const session of [normal.session,remembered.session])assert.equal((await f.request('state',undefined,session)).status,401);
    const current=await f.login(user.username),state=await f.request('state',undefined,current.session);
    assert.equal(state.body.permissions.acknowledge,true);assert.equal(state.body.permissions.viewReports,false);
    assert.equal((await f.request('alarms/acknowledge',{ids:['fixture-alarm'],note:'Custom acknowledgement permission'},current.session)).status,200);
    assert.equal((await f.request('shunts',{scopeType:'device',scopeId:f.device.id,durationMin:60,reason:'Not granted'},current.session)).status,403);
    assert.equal((await f.request('report?device='+encodeURIComponent(f.device.id),undefined,current.session)).status,403);
    assert.equal((await f.request('state',undefined,f.admin.session)).status,200);
    assert.equal((await f.request('users/update',{id:user.id,permissions:['manageUsers']},f.admin.session)).status,400);
    assert.equal((await f.request('users/update',{id:user.id,permissions:'viewHealth'},f.admin.session)).status,400);
  }finally{await f.close();}
});

test('removing health access stops queued push and restoring health access does not silently re-enable a browser',async()=>{
  const f=await fixture();try{
    const user=await f.create('health-revoked','viewer'),signedIn=await f.login(user.username);
    assert.equal((await f.request('push/settings',{...pushSettings,includeDeviceNames:true},f.admin.session)).status,200);
    const sub=subscription('health-revoked'),enrolled=await f.request('push/subscribe',{subscription:sub,label:'Owned browser'},signedIn.session,canonicalHeaders);
    assert.equal(enrolled.status,201);const id=enrolled.body.id;
    f.s.run("INSERT INTO push_outbox VALUES('fixture-health-revoked-test',NULL,?,'test',0,?,'queued',NULL,NULL)",id,f.e.now());
    assert.equal((await f.request('users/update',{id:user.id,permissions:[]},f.admin.session)).status,200);
    assert.equal((await f.request('state',undefined,signedIn.session)).status,401);
    await f.push.deliver();assert.equal(f.sent.length,0);
    assert.equal(f.s.one('SELECT status FROM push_outbox WHERE id=?','fixture-health-revoked-test').status,'suppressed');
    assert.ok(f.s.one('SELECT disabled_at FROM push_subscriptions WHERE id=?',id).disabled_at);
    const limited=await f.login(user.username),status=await f.request('push',undefined,limited.session);
    assert.equal(status.status,200);assert.equal(status.body.subscriptions[0].id,id);assert.ok(status.body.subscriptions[0].disabled_at);
    assert.equal((await f.request('push/test',{id},limited.session)).status,403);
    assert.equal((await f.request('push/subscribe',{subscription:sub,label:'Owned browser'},limited.session,canonicalHeaders)).status,403);
    assert.equal((await f.request('users/update',{id:user.id,permissions:['viewHealth']},f.admin.session)).status,200);
    const restored=await f.login(user.username),restoredStatus=await f.request('push',undefined,restored.session);
    assert.ok(restoredStatus.body.subscriptions[0].disabled_at);assert.equal((await f.request('push/test',{id},restored.session)).status,400);
    await f.push.deliver();assert.equal(f.sent.length,0);
    // Even a user without health access retains control of removing their own registration.
    assert.equal((await f.request('users/update',{id:user.id,permissions:[]},f.admin.session)).status,200);
    const noHealth=await f.login(user.username);
    assert.equal((await f.request('push/remove',{id},noHealth.session)).status,200);
    assert.equal((await f.request('push',undefined,noHealth.session)).body.subscriptions.length,0);
  }finally{await f.close();}
});
