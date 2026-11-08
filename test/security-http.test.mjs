import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {Accounts,hasPermission,permissionKeys} from '../server/accounts.mjs';
import {Sessions} from '../server/sessions.mjs';
import {createApp} from '../server/http.mjs';

const password='synthetic-security-admin';
const userPassword='synthetic-security-user';
const originalPermissions=['viewHealth','viewReports','acknowledge','manageShunts','manageDevices','manageBrokers','manageThresholds','manageEmail','manageNotifications'].sort();

async function fixture(){
  const s=new Store(),e=new Engine(s),calls=[],security={state:()=>({areas:[{id:'area-one',name:'Ground floor',mode:'disarmed'}],zones:[{id:'zone-one',name:'Front door',areaId:'area-one'}],actions:[{id:'action-one',topic:'security/private-template',payloadTemplate:'private configured text'}],schedules:[{id:'schedule-one',time:'22:00'}],deliveries:[{id:'delivery-one',status:'uncertain',context:'private payload',error:'Delivery not confirmed'}],devices:[{id:'device-one',name:'Door contact',networkId:'network-one',properties:[{property:'contact',type:'binary',valueOn:false,valueOff:true}],password:'DO NOT EXPOSE DEVICE PASSWORD'}],networks:[{id:'network-one',label:'Zigbee network',enabled:true,connected:true,host:'private-broker.fixture.test',username:'private-broker-user',password:'DO NOT EXPOSE BROKER PASSWORD'}],summary:{armed:0},timezone:'UTC'})};
  for(const method of ['saveArea','removeArea','saveZone','removeZone','saveSchedule','removeSchedule','saveAction','removeAction','command','bypassZone','clearBypass'])security[method]=(...args)=>{calls.push({method,args});return {id:'result-one',name:'Result'};};
  const server=createApp(e,{password,security,securityActions:{stats:()=>({mqttPublications:0})}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url='http://127.0.0.1:'+server.address().port;
  const request=(route,body,cookie,headers={})=>new Promise((resolve,reject)=>{
    const req=http.request(url+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{cookie}:{}),...headers}},res=>{let raw='';res.on('data',chunk=>raw+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(raw),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]});}catch(error){reject(error);}});});
    req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  const login=async(name,pass=userPassword)=>(await request('login',{username:name,password:pass}));
  const admin=await login('admin',password);assert.equal(admin.status,200);
  const create=async(name,permissions)=>{const result=await request('users',{username:name,password:userPassword,role:'viewer',permissions},admin.cookie);assert.equal(result.status,201);return login(name);};
  return {s,e,calls,security,request,admin,create,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));s.close();}};
}

test('existing administrator rows and remembered sessions remain byte-exact while fixed admin access includes Security',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'zigbee-security-legacy-')),file=path.join(folder,'health.db');let s=new Store(file);
  try{
    let accounts=new Accounts(s,{password});const admin=accounts.authenticate('admin',password);
    const limited=accounts.create({username:'legacy-custom',password:userPassword,permissions:['manageBrokers'],enabled:false},'admin');
    s.run('UPDATE users SET permissions=? WHERE id=?',JSON.stringify(originalPermissions),admin.id);
    const sessions=new Sessions(s,accounts),token=sessions.issue(true,accounts.get(admin.id)).token;
    const rows=s.all('SELECT * FROM users ORDER BY id'),remembered=s.all('SELECT * FROM auth_sessions ORDER BY token_hash'),settings=s.all('SELECT * FROM settings ORDER BY key');
    s.close();s=new Store(file);accounts=new Accounts(s,{password:'bootstrap-password-must-be-ignored'});
    const nextSessions=new Sessions(s,accounts),projected=nextSessions.current(token);
    assert.ok(projected);assert.deepEqual(projected.permissions,[...permissionKeys].sort());
    for(const key of ['viewSecurity','controlSecurity','manageSecurity'])assert.equal(hasPermission(projected,key),true);
    assert.deepEqual(s.all('SELECT * FROM users ORDER BY id'),rows);assert.deepEqual(s.all('SELECT * FROM auth_sessions ORDER BY token_hash'),remembered);assert.deepEqual(s.all('SELECT * FROM settings ORDER BY key'),settings);
    assert.deepEqual(accounts.get(limited.id).permissions,['manageBrokers']);assert.equal(accounts.get(limited.id).enabled,false);assert.equal(hasPermission(accounts.get(limited.id),'viewSecurity'),false);
    assert.deepEqual(JSON.parse(s.one('SELECT permissions FROM users WHERE id=?',admin.id).permissions),originalPermissions);
  }finally{s.close();fs.rmSync(folder,{recursive:true,force:true});}
});

test('an explicit save of a legacy administrator persists the complete preset and revokes only that account sessions',()=>{
  const s=new Store();try{
    const accounts=new Accounts(s,{password}),admin=accounts.authenticate('admin',password),other=accounts.create({username:'unchanged-custom',password:userPassword,permissions:['manageBrokers']},'admin');
    s.run('UPDATE users SET permissions=? WHERE id=?',JSON.stringify(originalPermissions),admin.id);
    const sessions=new Sessions(s,accounts),old=sessions.issue(true,accounts.get(admin.id)).token,otherSession=sessions.issue(true,other).token,credential=s.one('SELECT password_salt,password_hash FROM users WHERE id=?',admin.id);
    const updated=accounts.update({id:admin.id,displayName:'Administrator'},'admin');
    assert.deepEqual(updated.permissions,[...permissionKeys].sort());assert.equal(updated.authVersion,admin.authVersion+1);assert.equal(sessions.current(old),null);assert.ok(sessions.current(otherSession));assert.deepEqual(s.one('SELECT password_salt,password_hash FROM users WHERE id=?',admin.id),credential);assert.deepEqual(accounts.get(other.id).permissions,['manageBrokers']);
  }finally{s.close();}
});

test('Security-only readers can inspect sanitized device candidates without health, broker, SMTP or action configuration',async()=>{
  const f=await fixture();try{
    assert.equal((await f.request('security')).status,401);
    const viewer=await f.create('health-viewer',['viewHealth','viewReports']);assert.equal((await f.request('security',undefined,viewer.cookie)).status,403);
    const reader=await f.create('security-reader',['viewSecurity']),state=await f.request('security',undefined,reader.cookie);
    assert.equal(state.status,200);assert.equal(state.body.areas[0].name,'Ground floor');assert.equal(state.body.devices[0].name,'Door contact');assert.equal(state.body.devices[0].properties[0].property,'contact');
    assert.deepEqual(state.body.actions,[]);assert.deepEqual(state.body.schedules,[]);assert.equal(state.body.deliveries[0].context,undefined);
    assert.equal(state.body.candidates,undefined);assert.equal(state.body.eligibleDevices,undefined);
    assert.deepEqual(state.body.devices[0].properties,[{property:'contact',type:'binary'}]);
    const encoded=JSON.stringify(state.body);for(const text of ['private-broker.fixture.test','private-broker-user','DO NOT EXPOSE','private configured text','private payload'])assert.equal(encoded.includes(text),false,text);
    const health=await f.request('state',undefined,reader.cookie);assert.deepEqual(health.body.devices,[]);assert.deepEqual(health.body.networks,[]);assert.deepEqual(health.body.alarms,[]);assert.equal(health.body.permissions.viewHealth,false);assert.equal(health.body.permissions.viewSecurity,true);
    assert.equal((await f.request('network-log?network=network-one',undefined,reader.cookie)).status,403);
  }finally{await f.close();}
});

test('view, control and configuration permissions are independently enforced and audit actors cannot be forged',async()=>{
  const f=await fixture();try{
    const reader=await f.create('security-reader',['viewSecurity']),controller=await f.create('security-controller',['controlSecurity']),manager=await f.create('security-manager',['manageSecurity']);
    const controls=[['security/command',{areaId:'area-one',action:'arm_away',reason:'Leaving'}],['security/bypass',{id:'zone-one',durationMin:60,reason:'Maintenance'}],['security/clear-bypass',{id:'zone-one'}]];
    const configs=[['security/areas',{name:'Ground floor'}],['security/zones',{name:'Door'}],['security/schedules',{name:'Night arm'}],['security/actions',{name:'Alert'}],['security/remove-area',{id:'area-one'}],['security/remove-zone',{id:'zone-one'}],['security/remove-schedule',{id:'schedule-one'}],['security/remove-action',{id:'action-one'}]];
    for(const [route,body] of [...controls,...configs])assert.equal((await f.request(route,body,reader.cookie)).status,403,route);
    for(const [route,body] of configs)assert.equal((await f.request(route,body,controller.cookie)).status,403,route);
    for(const [route,body] of controls)assert.equal((await f.request(route,body,manager.cookie)).status,403,route);
    for(const [route,body] of controls)assert.equal((await f.request(route,{...body,actor:'admin'},controller.cookie)).status,200,route);
    for(const [route,body] of configs)assert.ok([200,201].includes((await f.request(route,{...body,actor:'admin'},manager.cookie)).status),route);
    assert.deepEqual(f.calls.find(call=>call.method==='command').args,['area-one','arm_away',{reason:'Leaving'},'security-controller']);
    for(const call of f.calls.filter(call=>call.method!=='command'&&call.method!=='bypassZone'&&call.method!=='clearBypass'))assert.equal(call.args.at(-1),'security-manager',call.method);
    const flags=(await f.request('state',undefined,controller.cookie)).body.permissions;assert.equal(flags.viewSecurity,true);assert.equal(flags.controlSecurity,true);assert.equal(flags.manageSecurity,false);assert.equal(flags.viewHealth,false);
  }finally{await f.close();}
});

test('Security writes retain cross-origin protection and disabled users cannot use a stale session',async()=>{
  const f=await fixture();try{
    const controller=await f.create('security-controller',['controlSecurity']);
    assert.equal((await f.request('security/command',{areaId:'area-one',action:'disarm'},controller.cookie,{Origin:'https://other.fixture.test'})).status,403);assert.equal(f.calls.length,0);
    const users=(await f.request('users',undefined,f.admin.cookie)).body.users,target=users.find(user=>user.username==='security-controller');
    assert.equal((await f.request('users/update',{id:target.id,enabled:false},f.admin.cookie)).status,200);
    assert.equal((await f.request('security',undefined,controller.cookie)).status,401);assert.equal((await f.request('security/command',{areaId:'area-one',action:'disarm'},controller.cookie)).status,401);assert.equal(f.calls.length,0);
    assert.equal((await f.request('health')).body.mqttPublications,0);
  }finally{await f.close();}
});
