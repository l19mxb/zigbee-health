import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {Accounts} from '../server/accounts.mjs';
import {SecurityEngine} from '../server/security.mjs';
import {Keypad,KeypadError} from '../server/keypad.mjs';
import {createApp} from '../server/http.mjs';

const password='synthetic-keypad-password';
function fixture(file=':memory:'){
  let now=Date.UTC(2026,10,8,8),s=new Store(file),health=new Engine(s,{clock:()=>now}),accounts=new Accounts(s,{password,clock:()=>now});
  const admin=accounts.list()[0],operator=accounts.create({username:'keypad-operator',password,permissions:['controlSecurity']},'Fixture'),wall=accounts.create({username:'keypad-wall',password,permissions:['viewSecurity']},'Fixture');
  s.saveNetwork({id:'keypad-network',label:'Fixture network',mode:'zigbee2mqtt',enabled:true,connected:true,connectedAt:now-1000,bridgeState:'online'});
  for(const id of ['one','two'])s.saveDevice({id,networkId:'keypad-network',name:'Fixture contact '+id,ieee:id==='one'?'0x00124b0000000001':'0x00124b0000000002',availability:'online',inventoryPresent:true});
  let security=new SecurityEngine(s,{clock:()=>now,timezone:'UTC'}),keypad=new Keypad(s,security,accounts,{clock:()=>now});
  const one=security.saveArea({name:'House',entryDelaySec:0,exitDelaySec:0},'Fixture'),two=security.saveArea({name:'Garage',entryDelaySec:0,exitDelaySec:0},'Fixture');
  const zones=[security.saveZone({areaId:one.id,deviceId:'one',property:'contact',value:false,name:'House contact'},'Fixture'),security.saveZone({areaId:two.id,deviceId:'two',property:'contact',value:false,name:'Garage contact'},'Fixture')];
  const normal=()=>{now+=10;security.ingest('one',{contact:true});security.ingest('two',{contact:true});};normal();
  const pin=(user=operator,value='0471',areaIds=[one.id])=>keypad.saveUser(admin,{id:user.id,operation:'set',pin:value,areaIds});
  const arm=()=>{normal();for(const area of [one,two])security.command(area.id,'arm_away',{},'Fixture');};
  return {get s(){return s;},get health(){return health;},get accounts(){return accounts;},get security(){return security;},get keypad(){return keypad;},admin,operator,wall,one,two,zones,pin,arm,normal,advance:ms=>now+=ms,close:()=>s.close(),reopen:()=>{s.close();s=new Store(file);health=new Engine(s,{clock:()=>now});accounts=new Accounts(s,{clock:()=>now});security=new SecurityEngine(s,{clock:()=>now,timezone:'UTC'});keypad=new Keypad(s,security,accounts,{clock:()=>now});}};
}

test('keypad startup adds only empty security tables and leaves existing users, grants, sessions, settings and schema exact',()=>{
  const s=new Store(),health=new Engine(s),accounts=new Accounts(s,{password}),security=new SecurityEngine(s);
  try{
    const before={schema:s.all("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"),users:s.all('SELECT * FROM users'),settings:s.all('SELECT * FROM settings'),sessions:s.all('SELECT * FROM auth_sessions')},key=Buffer.from(s.encryptionKey);
    new Keypad(s,security,accounts);new Keypad(s,security,accounts);
    assert.deepEqual(s.all("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'security_keypad_%' ORDER BY name"),before.schema);assert.deepEqual(s.all('SELECT * FROM users'),before.users);assert.deepEqual(s.all('SELECT * FROM settings'),before.settings);assert.deepEqual(s.all('SELECT * FROM auth_sessions'),before.sessions);assert.deepEqual(s.encryptionKey,key);
    for(const table of ['security_keypad_pins','security_keypad_access','security_keypad_throttle'])assert.equal(s.one('SELECT count(*) n FROM '+table).n,0);
  }finally{s.close();}
});

test('PIN storage is salted, key-bound, unique across disabled users and never exposed through settings',()=>{
  const f=fixture();try{
    f.pin();const row=f.s.one('SELECT * FROM security_keypad_pins');assert.equal(row.lookup_tag,f.keypad.tag('0471'));assert.match(row.salt,/^[a-f0-9]{32}$/);assert.match(row.hash,/^[a-f0-9]{64}$/);assert.equal(Object.hasOwn(row,'pin'),false);assert.notEqual(row.hash,'0471');assert.notEqual(row.lookup_tag,'0471');
    const beforeSettings=f.s.all('SELECT * FROM security_keypad_access');f.accounts.update({id:f.operator.id,enabled:false},'Fixture');assert.throws(()=>f.pin(f.wall,'0471',[f.two.id]),/cannot be used/);assert.deepEqual(f.s.all('SELECT * FROM security_keypad_access'),beforeSettings);
    const dto=f.keypad.settings(f.operator.id,{admin:true});assert.equal(dto.pinSet,true);for(const key of ['lookup_tag','salt','hash','pin'])assert.equal(Object.hasOwn(dto,key),false);
    f.keypad.saveUser(f.admin,{id:f.operator.id,operation:'remove'});assert.equal(f.pin(f.wall,'0471',[f.two.id]).pinSet,true);
  }finally{f.close();}
});

test('new nonadministrator PIN assignments default to none while administrators retain all areas',()=>{
  const f=fixture();try{
    assert.deepEqual(f.keypad.settings(f.operator.id).areaIds,[]);assert.equal(f.keypad.settings(f.operator.id).pinSet,false);
    const admin=f.keypad.saveUser(f.admin,{id:f.admin.id,operation:'set',pin:'5902',areaIds:[]});assert.equal(admin.allAreas,true);assert.deepEqual(new Set(admin.areaIds),new Set([f.one.id,f.two.id]));assert.equal(f.s.one('SELECT count(*) n FROM security_keypad_access WHERE user_id=?',f.admin.id).n,0);
  }finally{f.close();}
});

test('own PIN changes require current password without rewriting login/password/session rows',()=>{
  const f=fixture();try{
    const old=f.s.one('SELECT * FROM users WHERE id=?',f.operator.id),sessionRows=f.s.all('SELECT * FROM auth_sessions');
    assert.throws(()=>f.keypad.saveOwn(f.operator,{operation:'set',pin:'1029',currentPassword:'wrong-password'}),/Current password/);
    assert.equal(f.keypad.saveOwn(f.operator,{operation:'set',pin:'1029',currentPassword:password}).pinSet,true);assert.deepEqual(f.s.one('SELECT * FROM users WHERE id=?',f.operator.id),old);assert.deepEqual(f.s.all('SELECT * FROM auth_sessions'),sessionRows);
    assert.throws(()=>f.keypad.saveOwn(f.wall,{operation:'set',pin:'1028',currentPassword:password}),/control access/);assert.throws(()=>f.keypad.saveOwn(f.operator,{operation:'remove',pin:'1029',currentPassword:password}),/Do not include/);
    f.keypad.saveOwn(f.operator,{operation:'remove',currentPassword:password});assert.equal(f.keypad.settings(f.operator.id).pinSet,false);
  }finally{f.close();}
});

test('PIN format, area assignments and duplicate failures are validated atomically',()=>{
  const f=fixture();try{
    for(const pin of [1234,'123','12345','12a4',' 1234','１２３４',null])assert.throws(()=>f.pin(f.operator,pin),/four-digit/);
    for(const ids of [['missing'],[f.one.id,f.one.id],null])assert.throws(()=>f.pin(f.operator,'0471',ids),/valid areas/);
    f.pin();f.keypad.saveUser(f.admin,{id:f.wall.id,operation:'save',areaIds:[f.one.id]});const before=f.s.all('SELECT * FROM security_keypad_access ORDER BY user_id');assert.throws(()=>f.pin(f.wall,'0471',[f.two.id]),/cannot be used/);assert.deepEqual(f.s.all('SELECT * FROM security_keypad_access ORDER BY user_id'),before);
    assert.throws(()=>f.keypad.saveUser(f.operator,{id:f.wall.id,operation:'save',areaIds:[f.two.id]}),/Administrator/);
  }finally{f.close();}
});

test('Arm Away uses authenticated control permission without a PIN or PIN area assignment',()=>{
  const f=fixture();try{
    assert.throws(()=>f.keypad.command(f.wall,{action:'arm_away',areaIds:[f.one.id]}),/control access/);
    assert.throws(()=>f.keypad.command(f.operator,{action:'arm_away',areaIds:[f.one.id],pin:'0471'}),/does not require/);
    const result=f.keypad.command(f.operator,{action:'arm_away',all:true});assert.deepEqual(new Set(result.areaIds),new Set([f.one.id,f.two.id]));assert.equal(f.security.area(f.one.id).mode,'away');assert.equal(f.security.area(f.two.id).mode,'away');
  }finally{f.close();}
});

test('arming a mixed selection blocks all areas if any area is unready, already armed or disabled',()=>{
  for(const condition of ['open','unknown','armed','disabled']){const f=fixture();try{
    if(condition==='open')f.security.ingest('two',{contact:false});if(condition==='unknown')f.security.readings.delete('two');if(condition==='armed')f.security.command(f.two.id,'arm_away',{},'Fixture');if(condition==='disabled')f.security.saveArea({id:f.two.id,enabled:false},'Fixture');
    const before=f.s.all('SELECT * FROM security_areas ORDER BY id'),events=f.s.all('SELECT * FROM security_events');assert.throws(()=>f.keypad.command(f.operator,{action:'arm_away',areaIds:[f.one.id,f.two.id]}));assert.deepEqual(f.s.all('SELECT * FROM security_areas ORDER BY id'),before);assert.deepEqual(f.s.all('SELECT * FROM security_events'),events);assert.ok(f.security.zones().every(zone=>zone.bypassAt===null));
  }finally{f.close();}}
});

test('a read-only wall session may disarm with an enabled authorized control user PIN',()=>{
  const f=fixture();try{
    f.pin();f.arm();const result=f.keypad.command(f.wall,{action:'disarm',areaIds:[f.one.id],pin:'0471'});assert.deepEqual(result.areaIds,[f.one.id]);assert.equal(f.security.area(f.one.id).mode,'disarmed');assert.equal(f.security.area(f.two.id).mode,'away');assert.equal(result.pin,undefined);
    const event=f.security.state().events.find(event=>event.type==='area_disarmed');assert.equal(event.actor,f.operator.username);assert.match(event.message,/keypad-wall/);assert.equal(event.message.includes('0471'),false);
  }finally{f.close();}
});

test('explicit mixed authorized and unauthorized areas reject the whole disarm without silently intersecting',()=>{
  const f=fixture();try{
    f.pin();f.arm();const before=f.s.all('SELECT * FROM security_areas ORDER BY id');assert.throws(()=>f.keypad.command(f.wall,{action:'disarm',areaIds:[f.one.id,f.two.id],pin:'0471'}),/does not permit/);assert.deepEqual(f.s.all('SELECT * FROM security_areas ORDER BY id'),before);
    const result=f.keypad.command(f.wall,{action:'disarm',all:true,pin:'0471'});assert.deepEqual(result.areaIds,[f.one.id]);assert.equal(f.security.area(f.two.id).mode,'away');
  }finally{f.close();}
});

test('disabled, permission-revoked, changed and removed PINs cannot authorize disarm',()=>{
  for(const condition of ['disabled','permission','changed','removed']){const f=fixture();try{
    f.pin();f.arm();if(condition==='disabled')f.accounts.update({id:f.operator.id,enabled:false},'Fixture');if(condition==='permission')f.accounts.update({id:f.operator.id,permissions:['viewSecurity']},'Fixture');if(condition==='changed')f.keypad.saveUser(f.admin,{id:f.operator.id,operation:'set',pin:'6280'});if(condition==='removed')f.keypad.saveUser(f.admin,{id:f.operator.id,operation:'remove'});
    assert.throws(()=>f.keypad.command(f.wall,{action:'disarm',areaIds:[f.one.id],pin:'0471'}),/does not permit/);assert.equal(f.security.area(f.one.id).mode,'away');
  }finally{f.close();}}
});

test('a valid low-scope PIN does not reset the installation-wide guessing budget',()=>{
  const f=fixture();try{
    f.pin();for(let i=0;i<5;i++){assert.throws(()=>f.keypad.command(f.wall,{action:'disarm',all:true,pin:'9998'}),/does not permit/);if(i<4)f.keypad.command(f.wall,{action:'disarm',all:true,pin:'0471'});}
    const row=f.s.one("SELECT * FROM security_keypad_throttle WHERE scope='pin'");assert.equal(row.failures,5);assert.throws(()=>f.keypad.command(f.wall,{action:'disarm',all:true,pin:'0471'}),error=>error instanceof KeypadError&&error.statusCode===429&&error.retryAfter===60);
    f.advance(60001);f.keypad.command(f.wall,{action:'disarm',all:true,pin:'0471'});assert.equal(f.s.one("SELECT failures FROM security_keypad_throttle WHERE scope='pin'").failures,5);
    assert.throws(()=>f.keypad.command(f.wall,{action:'disarm',all:true,pin:'9998'}));assert.equal(f.s.one("SELECT failures FROM security_keypad_throttle WHERE scope='pin'").failures,6);
    f.advance(1800001);assert.throws(()=>f.keypad.command(f.wall,{action:'disarm',all:true,pin:'9998'}));assert.equal(f.s.one("SELECT failures FROM security_keypad_throttle WHERE scope='pin'").failures,1);
  }finally{f.close();}
});

test('the global PIN throttle and key-bound credential remain effective across a persisted reopen',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zigbee-keypad-restart-'));let f;
  try{
    f=fixture(path.join(dir,'health.db'));f.pin();f.arm();for(let i=0;i<5;i++)assert.throws(()=>f.keypad.command(f.wall,{action:'disarm',all:true,pin:'9998'}));const pins=f.s.all('SELECT * FROM security_keypad_pins');f.reopen();assert.deepEqual(f.s.all('SELECT * FROM security_keypad_pins'),pins);assert.throws(()=>f.keypad.command(f.wall,{action:'disarm',all:true,pin:'0471'}),error=>error.statusCode===429);f.advance(60001);assert.equal(f.keypad.command(f.wall,{action:'disarm',all:true,pin:'0471'}).ok,true);
  }finally{f?.close();const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('zigbee-keypad-restart-'));fs.rmSync(resolved,{recursive:true,force:true});}
});

test('own-password verification for PIN setup is persistently rate limited and successful setup clears only its own scope',()=>{
  const f=fixture();try{
    for(let i=0;i<5;i++)assert.throws(()=>f.keypad.saveOwn(f.operator,{operation:'set',pin:'1029',currentPassword:'wrong'}),/Current password/);
    const reopened=new Keypad(f.s,f.security,f.accounts,{clock:()=>f.health.now()});assert.throws(()=>reopened.saveOwn(f.operator,{operation:'set',pin:'1029',currentPassword:password}),error=>error.statusCode===429);f.advance(60001);assert.equal(reopened.saveOwn(f.operator,{operation:'set',pin:'1029',currentPassword:password}).pinSet,true);assert.equal(f.s.one('SELECT * FROM security_keypad_throttle WHERE scope=?','setup:'+f.operator.id),undefined);
  }finally{f.close();}
});

test('nested transaction savepoints preserve outer work when a caught inner operation fails',()=>{
  const s=new Store();try{s.transaction(()=>{s.set('outer',true);try{s.transaction(()=>{s.set('inner',true);throw Error('Synthetic inner failure');});}catch{}s.set('after',true);});assert.equal(s.get('outer'),true);assert.equal(s.get('inner'),null);assert.equal(s.get('after'),true);assert.equal(s.transactionDepth,0);}finally{s.close();}
});

test('a database error after either multi-area operation rolls back every area and audit record',()=>{
  for(const action of ['arm_away','disarm']){const f=fixture();try{
    f.pin(f.admin,'5902');if(action==='disarm')f.arm();const beforeAreas=f.s.all('SELECT * FROM security_areas ORDER BY id'),beforeEvents=f.s.all('SELECT * FROM security_events ORDER BY id'),readings=[...f.security.readings],command=f.security.command.bind(f.security);
    f.security.command=(id,...args)=>{const result=command(id,...args);if(id===f.two.id)throw Error('Synthetic database failure after second command');return result;};
    assert.throws(()=>f.keypad.command(f.admin,{action,areaIds:[f.one.id,f.two.id],...(action==='disarm'?{pin:'5902'}:{})}),/Synthetic database failure/);assert.deepEqual(f.s.all('SELECT * FROM security_areas ORDER BY id'),beforeAreas);assert.deepEqual(f.s.all('SELECT * FROM security_events ORDER BY id'),beforeEvents);assert.deepEqual([...f.security.readings],readings);assert.equal(f.s.transactionDepth,0);
  }finally{f.close();}}
});

test('corrupt credential records fail closed with a generic disarm rejection',()=>{
  const f=fixture();try{f.pin();f.s.run('UPDATE security_keypad_pins SET salt=?,hash=?','bad','bad');assert.throws(()=>f.keypad.command(f.wall,{action:'disarm',all:true,pin:'0471'}),/does not permit/);}finally{f.close();}
});

test('unauthenticated simulation keypad data is display-only and cannot set or use PINs',()=>{
  const s=new Store();try{const health=new Engine(s,{demo:true}),accounts=new Accounts(s),security=new SecurityEngine(s,{demo:true}),keypad=new Keypad(s,security,accounts),preview={id:'local-preview',role:'admin',enabled:true};security.saveArea({name:'Demo area'},'Fixture');const state=keypad.state(preview);assert.equal(state.readOnly,true);assert.equal(state.canArm,false);assert.equal(state.ownPin.configured,false);assert.equal(state.areas.length,1);assert.throws(()=>keypad.command(preview,{action:'arm_away',all:true}),/Security access/);assert.equal(s.one('SELECT count(*) n FROM security_keypad_pins').n,0);}finally{s.close();}
});

test('HTTP keypad routes preserve authentication, ownership, admin controls, origin checks and generic throttled errors',async()=>{
  const f=fixture();let server;
  try{
    f.pin();server=createApp(f.health,{password,security:f.security,keypad:f.keypad});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const request=(route,body,cookie,origin)=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/api/'+route,method:body===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),...(origin?{Origin:origin}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})}},res=>{let raw='';res.on('data',part=>raw+=part);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw),cookie:res.headers['set-cookie']?.[0].split(';')[0],retry:res.headers['retry-after']}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
    assert.equal((await request('keypad')).status,401);const wall=await request('login',{username:f.wall.username,password}),operator=await request('login',{username:f.operator.username,password}),admin=await request('login',{username:'admin',password});
    const readerState=await request('keypad',undefined,wall.cookie);assert.equal(readerState.status,200);assert.equal(readerState.body.canArm,false);assert.equal(readerState.body.areas.length,2);assert.equal((await request('keypad/command',{action:'arm_away',areaIds:[f.one.id]},wall.cookie)).status,403);
    assert.equal((await request('users/keypad?id='+f.operator.id,undefined,wall.cookie)).status,403);assert.equal((await request('users/keypad',{id:f.wall.id,operation:'save',areaIds:[f.one.id]},wall.cookie)).status,403);assert.equal((await request('account/keypad',{operation:'set',pin:'1234',currentPassword:password,id:f.admin.id},operator.cookie)).status,400);
    assert.equal((await request('account/keypad',{operation:'set',pin:'1234',currentPassword:password},operator.cookie,'https://other.example.test')).status,403);
    assert.equal((await request('keypad/command',{action:'arm_away',areaIds:[f.one.id]},operator.cookie)).status,200);assert.equal((await request('keypad/command',{action:'disarm',areaIds:[f.one.id],pin:'0471'},wall.cookie)).status,200);
    const settings=await request('users/keypad?id='+f.operator.id,undefined,admin.cookie);assert.equal(settings.body.pinSet,true);for(const secret of ['lookup_tag','salt','hash','0471'])assert.equal(JSON.stringify(settings.body).includes(secret),false);
    for(let i=0;i<5;i++)assert.equal((await request('keypad/command',{action:'disarm',all:true,pin:'9998'},wall.cookie)).status,403);const blocked=await request('keypad/command',{action:'disarm',all:true,pin:'0471'},wall.cookie);assert.equal(blocked.status,429);assert.equal(blocked.retry,'60');assert.equal(JSON.stringify(blocked.body).includes('0471'),false);
  }finally{server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));f.close();}
});
