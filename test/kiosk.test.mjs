import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {Accounts} from '../server/accounts.mjs';
import {SecurityEngine} from '../server/security.mjs';
import {Keypad} from '../server/keypad.mjs';
import {Kiosk,kioskCidr,kioskPeer} from '../server/kiosk.mjs';
import {createApp} from '../server/http.mjs';

const password='synthetic-kiosk-password',origin='http://127.0.0.1:18920';
function fixture(){
  let now=Date.UTC(2026,10,9,1);const s=new Store(),health=new Engine(s,{clock:()=>now}),accounts=new Accounts(s,{password,clock:()=>now}),admin=accounts.list()[0],operator=accounts.create({username:'kiosk-operator',password,permissions:['controlSecurity']},'Fixture');
  s.saveNetwork({id:'kiosk-network',label:'Fixture broker',host:'10.44.0.10',port:1883,password:s.seal('fixture-broker-secret'),mode:'zigbee2mqtt',enabled:true,connected:true,connectedAt:now-1000,bridgeState:'online'});
  const security=new SecurityEngine(s,{clock:()=>now,timezone:'UTC'}),keypad=new Keypad(s,security,accounts,{clock:()=>now}),kiosk=new Kiosk(keypad,{recognizesOrigin:value=>['127.0.0.1','10.44.0.10'].includes(new URL(value).hostname),clock:()=>now}),areas=[],zones=[];
  for(let index=0;index<3;index++){const id='kiosk-device-'+index;s.saveDevice({id,networkId:'kiosk-network',name:'Fixture contact '+index,ieee:'0x00124b000000000'+index,availability:'online',inventoryPresent:true});const area=security.saveArea({name:'Area '+index,entryDelaySec:0,exitDelaySec:0},'Fixture');areas.push(area);zones.push(security.saveZone({areaId:area.id,deviceId:id,property:'contact',value:false,name:'Zone '+index},'Fixture'));security.ingest(id,{contact:true});}
  const enable=(changes={})=>kiosk.configure(admin,{enabled:true,origin,cidrs:['127.0.0.1/32'],allAreas:false,areaIds:[areas[0].id],...changes});
  const pin=(areaIds=[areas[0].id,areas[1].id],value='0471')=>keypad.saveUser(admin,{id:operator.id,operation:'set',pin:value,areaIds});
  return {s,health,accounts,admin,operator,security,keypad,kiosk,areas,zones,enable,pin,advance:ms=>now+=ms,close:()=>s.close()};
}
function requestShape({host='127.0.0.1:18920',peer='::ffff:127.0.0.1',encrypted=false,headers={},rawHeaders}={}){return {headers:{host,...headers},rawHeaders:rawHeaders||['Host',host],socket:{remoteAddress:peer,encrypted}};}

test('kiosk construction and disabled reads add no settings, accounts, sessions, grants or schema',()=>{
  const f=fixture();try{const changes=f.s.one('SELECT total_changes() n').n,settings=f.s.all('SELECT * FROM settings'),users=f.s.all('SELECT * FROM users'),schema=f.s.all('SELECT * FROM sqlite_master ORDER BY name');new Kiosk(f.keypad);assert.equal(f.kiosk.settings(f.admin).enabled,false);assert.equal(f.s.get('kioskSettings'),null);assert.throws(()=>f.kiosk.gate(requestShape()),error=>error.statusCode===403);assert.deepEqual(f.s.all('SELECT * FROM settings'),settings);assert.deepEqual(f.s.all('SELECT * FROM users'),users);assert.deepEqual(f.s.all('SELECT * FROM auth_sessions'),[]);assert.deepEqual(f.s.all('SELECT * FROM sqlite_master ORDER BY name'),schema);assert.equal(f.s.one('SELECT total_changes() n').n,changes);}finally{f.close();}
});

test('kiosk settings require an enabled real administrator and explicit valid private origins, CIDRs and scopes',()=>{
  const f=fixture();try{
    assert.throws(()=>f.kiosk.settings(f.operator),error=>error.statusCode===403);assert.throws(()=>f.kiosk.configure({id:'local-preview',role:'admin'},{}),error=>error.statusCode===403);
    for(const value of ['https://public.example.test','http://8.8.8.8:18920','http://localhost:18920','http://2130706433:18920','http://127.000.0.1:18920','http://127.0.0.1:18920/','http://user@127.0.0.1:18920','http://127.0.0.1:18920?x=1','http://127.0.0.1:18920#x','http://10.45.0.1:18920'])assert.throws(()=>f.enable({origin:value}),/origin|host/i);
    for(const cidrs of [[],['0.0.0.0/0'],['172.0.0.0/8'],['192.168.0.0/15'],['8.8.8.0/24'],['::1/128'],['127.0.0.1/32','127.0.0.1/32']])assert.throws(()=>f.enable({cidrs}));
    assert.throws(()=>f.enable({areaIds:[]}),/areas/);assert.throws(()=>f.enable({areaIds:['missing']}),/valid areas/);assert.throws(()=>f.enable({extra:true}),/settings/);assert.equal(f.s.get('kioskSettings'),null);
    const result=f.enable({cidrs:['10.44.0.17/24','127.0.0.1/32']});assert.deepEqual(result.cidrs,['10.44.0.0/24','127.0.0.1/32']);assert.equal(result.areas.length,3);
  }finally{f.close();}
});

test('private CIDR validation cannot cover public space and peer checks normalize only canonical IPv4-mapped peers',()=>{
  for(const [input,expected] of [['10.1.2.3/8','10.0.0.0/8'],['172.31.8.9/12','172.16.0.0/12'],['192.168.4.5/16','192.168.0.0/16'],['127.0.0.1/8','127.0.0.0/8']])assert.equal(kioskCidr(input),expected);
  for(const input of ['10.0.0.0/7','172.16.0.0/11','192.168.0.0/15','127.0.0.0/7','10.1.1.1/33','010.0.0.0/8','169.254.0.0/16'])assert.throws(()=>kioskCidr(input));
  for(const address of ['127.0.0.1','::ffff:127.0.0.1','10.44.0.3','::ffff:10.44.0.3'])assert.ok(kioskPeer(address));for(const address of ['::1','8.8.8.8','::ffff:8.8.8.8','2130706433','127.0.0.1.evil',null])assert.equal(kioskPeer(address),null);
});

test('gate requires exact raw Host, port, actual scheme and trusted actual peer',()=>{
  const f=fixture();try{f.enable();assert.equal(f.kiosk.gate(requestShape()).enabled,true);
    for(const changes of [{host:'localhost:18920'},{host:'127.0.0.1'},{host:'127.0.0.1:18921'},{host:'127.0.0.1.:18920'},{host:'2130706433:18920'},{host:'0x7f000001:18920'},{host:'127.000.0.1:18920'},{host:'127.0.0.1:18920@public.example.test'},{encrypted:true},{peer:'8.8.8.8'},{peer:'::ffff:8.8.8.8'},{peer:'10.44.0.3'},{peer:'::1'},{headers:{origin:'http://public.example.test'}},{rawHeaders:['Host','127.0.0.1:18920','Host','127.0.0.1:18920']}])assert.throws(()=>f.kiosk.gate(requestShape(changes)),error=>error.statusCode===403);
    f.enable({origin:'https://127.0.0.1:18920'});assert.throws(()=>f.kiosk.gate(requestShape()),error=>error.statusCode===403);assert.equal(f.kiosk.gate(requestShape({encrypted:true})).enabled,true);
  }finally{f.close();}
});

test('proxy and forwarding headers are denied by presence even for trusted private peers',()=>{
  const f=fixture();try{f.enable();for(const name of ['forwarded','Forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-forwarded-test','XForwardedAnything','CF-Connecting-IP','cf-ray','CfConnectingIp','cf','via','x-real-ip','true-client-ip','x-client-ip','x-envoy-external-address','x-original-host'])assert.throws(()=>f.kiosk.gate(requestShape({headers:{[name]:''}})),error=>error.statusCode===403);}finally{f.close();}
});

test('command gate requires matching Origin, JSON and same-origin Fetch-Site before PIN work',()=>{
  const f=fixture();try{f.enable();const headers={origin,'content-type':'application/json','sec-fetch-site':'same-origin'};assert.equal(f.kiosk.gate(requestShape({headers}),{post:true}).enabled,true);
    for(const patch of [{origin:undefined},{origin:'https://127.0.0.1:18920'},{origin:'null'},{'content-type':'text/plain'},{'content-type':'application/x-www-form-urlencoded'},{'sec-fetch-site':'cross-site'},{'sec-fetch-site':'same-site'},{'sec-fetch-site':'none'}])assert.throws(()=>f.kiosk.gate(requestShape({headers:{...headers,...patch}}),{post:true}),error=>[403,415].includes(error.statusCode));assert.equal(f.s.one('SELECT count(*) n FROM security_keypad_throttle').n,0);
  }finally{f.close();}
});

test('kiosk state allowlists scoped display data and cannot expose users, PIN settings, brokers, history or credentials',()=>{
  const f=fixture();try{f.pin();f.enable();const changes=f.s.one('SELECT total_changes() n').n;f.s.db.exec('PRAGMA query_only = ON');const state=f.kiosk.state();assert.deepEqual(Object.keys(state).sort(),['areas','armingRevision','canArm','canBypassArm','kiosk','now','readOnly','timezone']);assert.equal(state.areas.length,1);assert.equal(state.areas[0].id,f.areas[0].id);assert.equal(state.canArm,true);assert.equal(state.readOnly,false);assert.equal(state.canBypassArm,false);assert.equal(state.areas[0].canArmAway,true);
    for(const secret of [f.admin.id,f.operator.id,f.operator.username,'0471','fixture-broker-secret','10.44.0.10','kiosk-network','kiosk-device-0',f.areas[1].id,f.zones[1].id,'ownPin','cycleId','armedAt','pendingZoneId','createdAt','authVersion','schedules','actions','events','networks','subscriptions'])assert.equal(JSON.stringify(state).includes(secret),false,secret);assert.equal(f.s.one('SELECT total_changes() n').n,changes);
  }finally{f.close();}
});

test('anonymous Arm Away retains readiness, scope and all-or-none protections with Local kiosk audit identity',()=>{
  const f=fixture();try{f.enable({areaIds:[f.areas[0].id,f.areas[1].id]});assert.throws(()=>f.kiosk.command({action:'arm_away',areaIds:[f.areas[0].id,f.areas[2].id]}),error=>error.statusCode===403);f.security.ingest('kiosk-device-1',{contact:false});const before=f.s.all('SELECT * FROM security_areas ORDER BY id');assert.throws(()=>f.kiosk.command({action:'arm_away',all:true}),/not ready/);assert.deepEqual(f.s.all('SELECT * FROM security_areas ORDER BY id'),before);f.security.ingest('kiosk-device-1',{contact:true});const result=f.kiosk.command({action:'arm_away',all:true});assert.deepEqual(new Set(result.areaIds),new Set([f.areas[0].id,f.areas[1].id]));assert.equal(f.security.area(f.areas[2].id).mode,'disarmed');const events=f.security.state().events.filter(event=>event.type==='area_armed');assert.equal(events.length,2);assert.ok(events.every(event=>event.actor==='Local kiosk'));assert.equal(JSON.stringify(result).includes('kiosk-operator'),false);assert.equal(f.s.all('SELECT * FROM auth_sessions').length,0);
  }finally{f.close();}
});

test('PIN disarm requires exact dual scope while all disarms only the PIN and kiosk intersection',()=>{
  const f=fixture();try{f.pin();f.enable({areaIds:[f.areas[1].id,f.areas[2].id]});for(const area of f.areas)f.security.command(area.id,'arm_away',{},'Fixture');const before=f.s.all('SELECT * FROM security_areas ORDER BY id');
    for(const ids of [[f.areas[0].id,f.areas[1].id],[f.areas[1].id,f.areas[2].id]])assert.throws(()=>f.kiosk.command({action:'disarm',areaIds:ids,pin:'0471'}),/does not permit/);assert.deepEqual(f.s.all('SELECT * FROM security_areas ORDER BY id'),before);
    const result=f.kiosk.command({action:'disarm',all:true,pin:'0471'});assert.deepEqual(result.areaIds,[f.areas[1].id]);assert.equal(f.security.area(f.areas[0].id).mode,'away');assert.equal(f.security.area(f.areas[2].id).mode,'away');const event=f.security.state().events.find(event=>event.type==='area_disarmed');assert.equal(event.actor,f.operator.username);assert.match(event.message,/Local kiosk/);assert.equal(JSON.stringify(result).includes(f.operator.username),false);
  }finally{f.close();}
});

test('kiosk and authenticated PIN attempts share persistent global budget, including generic rejection audit',()=>{
  const f=fixture();try{f.pin();f.enable();for(let index=0;index<3;index++)assert.throws(()=>f.kiosk.command({action:'disarm',all:true,pin:'9998'}),/does not permit/);for(let index=0;index<2;index++)assert.throws(()=>f.keypad.command(f.operator,{action:'disarm',all:true,pin:'9998'}),/does not permit/);assert.throws(()=>new Kiosk(f.keypad,{recognizesOrigin:()=>true}).command({action:'disarm',all:true,pin:'0471'}),error=>error.statusCode===429);assert.equal(f.s.one("SELECT failures FROM security_keypad_throttle WHERE scope='pin'").failures,5);assert.equal(f.security.state().events.find(event=>event.type==='keypad_pin_rejected'&&event.actor==='Local kiosk').message,'Keypad disarm attempt rejected');
  }finally{f.close();}
});

test('disabled, revoked, reassigned and removed PIN owners cannot disarm kiosk areas',()=>{
  for(const condition of ['disabled','permission','assignment','removed']){const f=fixture();try{f.pin();f.enable();f.security.command(f.areas[0].id,'arm_away',{},'Fixture');if(condition==='disabled')f.accounts.update({id:f.operator.id,enabled:false},'Fixture');if(condition==='permission')f.accounts.update({id:f.operator.id,permissions:['viewSecurity']},'Fixture');if(condition==='assignment')f.keypad.saveUser(f.admin,{id:f.operator.id,operation:'save',areaIds:[f.areas[1].id]});if(condition==='removed')f.keypad.saveUser(f.admin,{id:f.operator.id,operation:'remove'});assert.throws(()=>f.kiosk.command({action:'disarm',areaIds:[f.areas[0].id],pin:'0471'}),/does not permit/);assert.equal(f.security.area(f.areas[0].id).mode,'away');}finally{f.close();}}
});

test('kiosk multi-area database failure rolls back all area state and audit records',()=>{
  const f=fixture();try{f.enable({allAreas:true,areaIds:[]});const before=f.s.all('SELECT * FROM security_areas ORDER BY id'),events=f.s.all('SELECT * FROM security_events ORDER BY id'),command=f.security.command.bind(f.security);f.security.command=(id,...args)=>{const result=command(id,...args);if(id===f.areas[1].id)throw Error('Synthetic kiosk failure');return result;};assert.throws(()=>f.kiosk.command({action:'arm_away',all:true}),/Synthetic kiosk failure/);assert.deepEqual(f.s.all('SELECT * FROM security_areas ORDER BY id'),before);assert.deepEqual(f.s.all('SELECT * FROM security_events ORDER BY id'),events);}finally{f.close();}
});

test('kiosk request rate accounting is bounded and independent of persistent PIN budget',()=>{
  const f=fixture();try{f.enable();for(let index=0;index<30;index++)f.kiosk.gate(requestShape({headers:{origin,'content-type':'application/json'}}),{post:true,rate:true});assert.throws(()=>f.kiosk.gate(requestShape({headers:{origin,'content-type':'application/json'}}),{post:true,rate:true}),error=>error.statusCode===429&&error.retryAfter===60);assert.equal(f.s.one('SELECT count(*) n FROM security_keypad_throttle').n,0);f.advance(60001);assert.equal(f.kiosk.gate(requestShape({headers:{origin,'content-type':'application/json'}}),{post:true,rate:true}).enabled,true);assert.equal(f.kiosk.rates.size,1);}finally{f.close();}
});

test('HTTP kiosk exemptions stay exact, gated and separate from the main authenticated APIs',async()=>{
  const f=fixture();let server;try{
    server=createApp(f.health,{password,security:f.security,keypad:f.keypad,kiosk:f.kiosk});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port,local='http://127.0.0.1:'+port;
    const request=(route,{method='GET',body,headers={}}={})=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:route,method,headers},res=>{let raw='';res.on('data',part=>raw+=part);res.on('end',()=>{let data;try{data=JSON.parse(raw);}catch{data=raw;}resolve({status:res.statusCode,body:data,headers:res.headers});});});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
    assert.equal((await request('/api/kiosk/state')).status,403);for(const method of ['GET','HEAD','POST','OPTIONS'])for(const route of ['/kiosk','/kiosk/'])assert.equal((await request(route,{method})).status,403);f.enable({origin:local});for(const method of ['HEAD','POST','OPTIONS'])for(const route of ['/kiosk','/kiosk/'])assert.equal((await request(route,{method})).status,405);const beforeUsers=f.s.all('SELECT * FROM users'),beforeSessions=f.s.all('SELECT * FROM auth_sessions'),state=await request('/api/kiosk/state');assert.equal(state.status,200);assert.equal(state.headers['set-cookie'],undefined);assert.equal(state.headers['cache-control'],'no-store');assert.equal(state.body.areas.length,1);assert.deepEqual(f.s.all('SELECT * FROM users'),beforeUsers);assert.deepEqual(f.s.all('SELECT * FROM auth_sessions'),beforeSessions);
    for(const route of ['/api/state','/api/security','/api/keypad','/api/users','/api/kiosk/settings','/api/kiosk/state/','/api/kiosk/state/extra','/api/kiosk/command'])assert.equal((await request(route)).status,401,route);
    for(const route of ['/api/kiosk/state','/api/kiosk/command/'])assert.equal((await request(route,{method:'POST',body:{},headers:{'content-type':'application/json',origin:local}})).status,401,route);
    for(const headers of [{'x-forwarded-for':'127.0.0.1'},{'cf-connecting-ip':'127.0.0.1'},{host:'localhost:'+port}])assert.equal((await request('/api/kiosk/state',{headers})).status,403);
    for(const route of ['/x/../api/kiosk/state','http://127.0.0.1:'+port+'/api/kiosk/state'])assert.equal((await request(route)).status,403);
    assert.equal((await request('/api/kiosk/command',{method:'POST',body:{action:'arm_away',all:true},headers:{'content-type':'application/json'}})).status,403);assert.equal((await request('/api/kiosk/command',{method:'POST',body:{action:'arm_away',all:true},headers:{origin:local,'content-type':'text/plain'}})).status,415);
    assert.equal((await request('/api/kiosk/command',{method:'POST',body:{action:'arm_away',all:true},headers:{origin:local,'content-type':'application/json','sec-fetch-site':'same-origin'}})).status,200);assert.equal(f.security.area(f.areas[0].id).mode,'away');assert.equal(f.s.all('SELECT * FROM auth_sessions').length,0);
    const login=await request('/api/login',{method:'POST',body:{username:'admin',password},headers:{'content-type':'application/json'}}),cookie=login.headers['set-cookie'][0].split(';')[0];assert.equal(login.status,200);assert.equal((await request('/api/kiosk/settings',{headers:{cookie}})).status,200);assert.equal((await request('/api/keypad',{headers:{cookie}})).status,200);
  }finally{server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));f.close();}
});

test('HTTP command rechecks disabled settings, origin, CIDRs and scope after a streaming body before PIN or arm dispatch',async()=>{
  for(const change of ['disable','origin','cidrs','scope']){const f=fixture();let server;try{
    server=createApp(f.health,{password,security:f.security,keypad:f.keypad,kiosk:f.kiosk});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port,local='http://127.0.0.1:'+port;f.enable({origin:local});let gated;const seen=new Promise(resolve=>gated=resolve),gate=f.kiosk.gate.bind(f.kiosk);f.kiosk.gate=(req,options)=>{const result=gate(req,options);if(options.rate)gated();return result;};
    const result=new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:'/api/kiosk/command',method:'POST',headers:{origin:local,'content-type':'application/json'}},res=>{let raw='';res.on('data',part=>raw+=part);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));});req.on('error',reject);req.write('{"action":"arm_away","areaIds":[');void seen.then(()=>{const updates=change==='disable'?{enabled:false}:change==='origin'?{origin:'http://127.0.0.1:18921'}:change==='cidrs'?{cidrs:['10.44.0.0/24']}:{areaIds:[f.areas[1].id]};f.enable({origin:local,...updates});req.end(JSON.stringify(f.areas[0].id)+']}');});});const response=await result;assert.equal(response.status,403,change);assert.ok(f.security.areas().every(area=>area.mode==='disarmed'));assert.equal(f.s.one('SELECT count(*) n FROM security_keypad_throttle').n,0);
  }finally{server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));f.close();}}
});
