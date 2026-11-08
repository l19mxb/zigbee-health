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
      response.on('end',()=>{try{resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(chunks)),cookie:response.headers['set-cookie']?.[0]});}catch(error){reject(error);}});
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
    assert.equal(state.body.currentUser.username,'operator-one');assert.deepEqual(state.body.permissions,{configure:false,manageUsers:false,operateAlarms:true});
    const adminState=await f.request('state',undefined,f.admin.session);
    assert.deepEqual(adminState.body.permissions,{configure:true,manageUsers:true,operateAlarms:true});
    assert.equal((await f.request('users',{username:'operator-one',password:userPassword,role:'viewer'},f.admin.session)).status,400);
    assert.equal((await f.request('users',{username:'invalid user',password:userPassword,role:'viewer'},f.admin.session)).status,400);
    assert.equal((await f.request('users',{username:'short-password',password:'short',role:'viewer'},f.admin.session)).status,400);
    assert.equal((await f.request('users',{username:'invalid-role',password:userPassword,role:'owner'},f.admin.session)).status,400);
  }finally{await f.close();}
});

test('viewers can inspect health and reports, with broker and mail configuration redacted',async()=>{
  const f=await fixture();try{
    const viewer=await f.create('viewer-one'),operator=await f.create('operator-one','operator');
    for(const user of [viewer,operator]){
      const signedIn=await f.login(user.username),state=await f.request('state',undefined,signedIn.session);
      assert.equal(state.status,200);assertSafeUser(state.body.currentUser);
      assert.equal(state.body.currentUser.role,user.role);assert.equal(state.body.permissions.operateAlarms,user.role==='operator');
      assert.deepEqual(state.body.email,{enabled:true});
      const network=state.body.networks[0];assert.equal(network.label,'Fixture network');
      for(const field of ['host','port','protocol','baseTopic','username','password','passwordSet','topicFilters'])assert.ok(!Object.hasOwn(network,field),field+' should not be disclosed');
      assert.deepEqual(state.body.traffic,{});
      for(const secret of ['broker.fixture.test','fixture-broker-user','smtp.fixture.test','sender@example.test','recipient@example.test','fixture-smtp-user'])assert.ok(!JSON.stringify(state.body).includes(secret));
      assert.equal((await f.request('report?device='+encodeURIComponent(f.device.id),undefined,signedIn.session)).status,200);
      assert.equal((await f.request('users',undefined,signedIn.session)).status,403);
      assert.equal((await f.request('network-log?network=fixture-network',undefined,signedIn.session)).status,403);
    }
    const adminState=await f.request('state',undefined,f.admin.session);
    assert.equal(adminState.body.networks[0].host,'broker.fixture.test');assert.equal(adminState.body.email.recipient,'recipient@example.test');
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
