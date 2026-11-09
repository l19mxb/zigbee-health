import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {SecurityEngine} from '../server/security.mjs';
import {Accounts} from '../server/accounts.mjs';
import {Sessions} from '../server/sessions.mjs';
import {createApp} from '../server/http.mjs';

function fixture(){
  const s=new Store();let now=Date.UTC(2026,10,8,4,0,0);
  s.saveNetwork({id:'network',label:'Example network',mode:'zigbee2mqtt',enabled:true,connected:true,connectedAt:now-1000,bridgeState:'online'});
  s.saveDevice({id:'contact',networkId:'network',name:'Shared contact',ieee:'0x00124b0000000001',model:'Example contact',availability:'online',inventoryPresent:true});
  let e=new SecurityEngine(s,{clock:()=>now,timezone:'UTC'});
  const a=e.saveArea({name:'House',entryDelaySec:0,exitDelaySec:0},'tester'),b=e.saveArea({name:'Garage',entryDelaySec:0,exitDelaySec:0},'tester');
  const add=body=>e.saveZone({areaIds:[a.id,b.id],deviceId:'contact',name:'Shared door',property:'contact',value:false,...body},'tester');
  const report=(payload={contact:true})=>{now+=10;e.ingest('contact',payload,{at:now});};
  const command=(area,action)=>e.command(area.id,action,{},'tester');
  const action=area=>e.saveAction({areaId:area.id,name:area.name+' action',kind:'mqtt',networkId:'network',topic:'security/events',enabled:true},'tester');
  return {s,a,b,add,report,command,action,get e(){return e;},advance:ms=>now+=ms,restart:()=>{e=new SecurityEngine(s,{clock:()=>now,timezone:'UTC'});return e;},close:()=>s.close()};
}

test('one shared zone activates every armed member independently and queues each area action once',()=>{
  const f=fixture();try{
    const zone=f.add();f.action(f.a);f.action(f.b);f.report();f.command(f.a,'arm_away');f.command(f.b,'arm_away');f.report({contact:false});f.report({contact:false});
    const incidents=f.e.activeIncidents(),jobs=f.e.queuedActions();
    assert.equal(incidents.length,2);assert.deepEqual(new Set(incidents.map(row=>row.areaId)),new Set([f.a.id,f.b.id]));assert.ok(incidents.every(row=>row.zoneId===zone.id));
    assert.equal(jobs.length,2);assert.deepEqual(new Set(jobs.map(row=>row.context.area)),new Set(['House','Garage']));assert.equal(new Set(jobs.map(row=>row.incidentId)).size,2);
    f.command(f.a,'disarm');assert.equal(f.e.area(f.b.id).mode,'away');assert.equal(f.e.activeIncidents(f.b.id).length,1);
  }finally{f.close();}
});

test('an armed secondary membership is protected when the compatibility primary area is disarmed',()=>{
  const f=fixture();try{
    f.add();f.report();f.command(f.b,'arm_away');f.report({contact:false});
    assert.equal(f.e.activeIncidents(f.a.id).length,0);assert.equal(f.e.activeIncidents(f.b.id).length,1);
    assert.equal(f.e.state().areas.find(area=>area.id===f.b.id).zoneCount,1);
  }finally{f.close();}
});

test('Home exclusion is contextual per area while Away remains protected',()=>{
  const f=fixture();try{
    const zone=f.add({homeBypass:true});f.add({areaIds:[f.a.id],name:'Always protected',property:'tamper',value:true});f.report({contact:true,tamper:false});
    f.command(f.a,'arm_home');f.command(f.b,'arm_away');
    const states=f.e.state().zones.find(row=>row.id===zone.id).areaStates;
    assert.equal(states.find(row=>row.areaId===f.a.id).homeExcluded,true);assert.equal(states.find(row=>row.areaId===f.b.id).homeExcluded,false);
    f.report({contact:false});assert.equal(f.e.activeIncidents(f.a.id).length,0);assert.equal(f.e.activeIncidents(f.b.id).length,1);
  }finally{f.close();}
});

test('each shared membership has its own entry delay and disarming one cancels only its pending entry',()=>{
  const f=fixture();try{
    f.e.saveArea({id:f.a.id,entryDelaySec:5});f.e.saveArea({id:f.b.id,entryDelaySec:20});f.add({type:'entry'});f.report();f.command(f.a,'arm_away');f.command(f.b,'arm_away');f.report({contact:false});
    assert.equal(f.e.area(f.b.id).entryAt-f.e.area(f.a.id).entryAt,15000);f.command(f.a,'disarm');
    assert.equal(f.e.area(f.a.id).entryAt,null);assert.ok(f.e.area(f.b.id).entryAt);f.advance(20000);f.e.tick();
    assert.equal(f.e.activeIncidents(f.a.id).length,0);assert.equal(f.e.activeIncidents(f.b.id).length,1);assert.equal(f.e.area(f.b.id).mode,'away');
  }finally{f.close();}
});

test('an exit delay rechecks its own shared zone without changing an already armed area',()=>{
  const f=fixture();try{
    f.e.saveArea({id:f.a.id,exitDelaySec:10});f.add();f.report();f.command(f.a,'arm_away');f.command(f.b,'arm_away');f.report({contact:false});f.advance(10000);f.e.tick();
    assert.equal(f.e.area(f.a.id).mode,'disarmed');assert.equal(f.e.area(f.a.id).targetMode,null);assert.equal(f.e.area(f.b.id).mode,'away');assert.equal(f.e.activeIncidents(f.b.id).length,1);
  }finally{f.close();}
});

test('zone configuration and membership removal require every affected area disarmed',()=>{
  const f=fixture();try{
    const zone=f.add();f.report();f.command(f.b,'arm_away');
    for(const operation of [()=>f.e.saveZone({id:zone.id,name:'Changed'}),()=>f.e.saveZone({id:zone.id,areaIds:[f.a.id]}),()=>f.e.removeZone(zone.id),()=>f.e.removeArea(f.a.id)])assert.throws(operation,/Disarm/);
    f.command(f.b,'disarm');const updated=f.e.saveZone({id:zone.id,areaIds:[f.a.id]});assert.deepEqual(updated.areaIds,[f.a.id]);
    assert.throws(()=>f.command(f.b,'arm_away'),/Add an enabled zone/);
    f.add({areaIds:[f.b.id],name:'Garage tamper',property:'tamper',value:true});f.report({contact:true,tamper:false});f.command(f.b,'arm_away');
    assert.throws(()=>f.e.saveZone({id:zone.id,areaIds:[f.a.id,f.b.id]}),/Disarm/);f.command(f.b,'disarm');
    f.report();f.command(f.a,'arm_away');assert.throws(()=>f.e.saveZone({id:zone.id,areaIds:[f.b.id]}),/Disarm/);
  }finally{f.close();}
});

test('membership validation is atomic and overlapping detector duplicates are rejected',()=>{
  const f=fixture();try{
    const zone=f.add({areaIds:[f.a.id]});const before=f.s.all('SELECT * FROM security_zone_areas');
    for(const areaIds of [[],null,[f.a.id,f.a.id],['missing'],[3],Array(65).fill(f.a.id)])assert.throws(()=>f.e.saveZone({id:zone.id,areaIds}));
    assert.throws(()=>f.e.saveZone({id:zone.id,areaIds:[f.a.id],areaId:f.b.id}));assert.deepEqual(f.s.all('SELECT * FROM security_zone_areas'),before);
    const other=f.add({areaIds:[f.b.id]});assert.throws(()=>f.e.saveZone({id:zone.id,areaIds:[f.a.id,f.b.id]}),/already a zone/);
    f.e.removeZone(other.id);assert.deepEqual(f.e.saveZone({id:zone.id,areaIds:[f.a.id,f.b.id]}).areaIds,[f.a.id,f.b.id]);
    assert.throws(()=>f.add({areaIds:[f.b.id]}),/already a zone/);
  }finally{f.close();}
});

test('a legacy browser changing zone fields preserves shared memberships until it explicitly moves the primary area',()=>{
  const f=fixture();try{
    const zone=f.add();const renamed=f.e.saveZone({id:zone.id,areaId:f.a.id,name:'Renamed from older browser'});
    assert.deepEqual(renamed.areaIds,[f.a.id,f.b.id]);assert.equal(renamed.name,'Renamed from older browser');
    assert.deepEqual(f.e.saveZone({id:zone.id,areaId:f.b.id}).areaIds,[f.b.id]);
    assert.deepEqual(f.e.saveZone({id:zone.id,areaIds:[f.a.id,f.b.id]}).areaIds,[f.a.id,f.b.id]);
    assert.deepEqual(f.e.saveZone({id:zone.id,areaIds:[f.a.id]}).areaIds,[f.a.id]);
  }finally{f.close();}
});

test('removing an area detaches a shared zone without deleting its other membership or detector settings',()=>{
  const f=fixture();try{
    const zone=f.add({type:'entry'});
    f.s.run('UPDATE security_zones SET json=? WHERE id=?',JSON.stringify({...f.e.zone(zone.id),freshnessMin:45}),zone.id);
    f.e.removeArea(f.a.id);const remaining=f.e.zone(zone.id);
    assert.equal(remaining.id,zone.id);assert.equal(remaining.deviceId,zone.deviceId);assert.equal(remaining.freshnessMin,45);assert.equal(remaining.type,'entry');assert.equal(remaining.areaId,f.b.id);assert.deepEqual(remaining.areaIds,[f.b.id]);
    assert.equal(f.e.state().areas[0].zoneCount,1);assert.equal(f.s.get('securityReadingTimeoutMin'),null);
    f.e.removeArea(f.b.id);assert.equal(f.e.zone(zone.id),null);assert.deepEqual(f.s.all('SELECT * FROM security_zone_areas'),[]);
    assert.equal(f.e.readingTimeoutMin(),45);assert.equal(f.s.get('securityReadingTimeoutMin'),45);
  }finally{f.close();}
});

test('a shared bypass applies to all memberships, cancels both entry delays and expires without a manufactured activation',()=>{
  const f=fixture();try{
    f.e.saveArea({id:f.a.id,entryDelaySec:30});f.e.saveArea({id:f.b.id,entryDelaySec:60});const zone=f.add({type:'entry'});f.report();f.command(f.a,'arm_away');f.command(f.b,'arm_away');f.report({contact:false});
    const bypass=f.e.bypassZone(zone.id,{durationMin:1,reason:'Shared maintenance'},'tester');assert.ok(bypass.areaStates.every(view=>view.bypassed));assert.equal(f.e.area(f.a.id).entryAt,null);assert.equal(f.e.area(f.b.id).entryAt,null);
    f.advance(60000);f.e.tick();f.report({contact:false});assert.equal(f.e.activeIncidents().length,0);assert.equal(f.e.area(f.a.id).entryAt,null);assert.equal(f.e.area(f.b.id).entryAt,null);
    f.report();f.report({contact:false});assert.ok(f.e.area(f.a.id).entryAt);assert.ok(f.e.area(f.b.id).entryAt);
  }finally{f.close();}
});

test('acknowledgement, reset and queued output suppression remain scoped to each area',()=>{
  const f=fixture();try{
    const zone=f.add();f.action(f.a);f.action(f.b);f.report();f.command(f.a,'arm_away');f.command(f.b,'arm_away');f.report({contact:false});
    f.command(f.a,'disarm');f.command(f.b,'disarm');assert.throws(()=>f.e.saveZone({id:zone.id,areaIds:[f.a.id]}),/alarm memory/);
    f.report();f.command(f.a,'acknowledge');f.command(f.a,'reset');
    assert.equal(f.e.activeIncidents(f.a.id).length,0);assert.equal(f.e.activeIncidents(f.b.id).length,1);assert.equal(f.e.activeIncidents(f.b.id)[0].ackAt,null);
    assert.equal(f.e.queuedActions().length,1);assert.equal(f.e.queuedActions()[0].context.areaId,f.b.id);
  }finally{f.close();}
});

test('legacy single-area migration adds memberships without rewriting any existing row, user or remembered session',()=>{
  const f=fixture();try{
    const accounts=new Accounts(f.s,{password:'synthetic-upgrade-password'}),admin=accounts.authenticate('admin','synthetic-upgrade-password');
    f.s.run('UPDATE users SET permissions=? WHERE id=?',JSON.stringify(['viewHealth','viewReports','acknowledge','manageShunts','manageDevices','manageBrokers','manageThresholds','manageEmail','manageNotifications']),admin.id);
    const sessions=new Sessions(f.s,accounts),token=sessions.issue(true,accounts.get(admin.id)).token;
    const zone=f.add({areaIds:[f.a.id]});const legacy={...f.e.zone(zone.id)};delete legacy.areaIds;f.s.run('UPDATE security_zones SET json=? WHERE id=?',JSON.stringify(legacy),zone.id);
    f.e.saveSchedule({areaId:f.a.id,name:'Disabled schedule',time:'22:00',timezone:'UTC',days:[0],mode:'away',enabled:false});f.e.saveAction({areaId:f.a.id,name:'Disabled action',networkId:'network',topic:'security/events',enabled:false});f.report();
    f.s.db.exec('DROP TABLE security_zone_areas');
    const tables=f.s.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(row=>row.name);
    const snapshot=()=>Object.fromEntries(tables.map(name=>[name,f.s.all('SELECT * FROM '+name+' ORDER BY rowid')]));
    const before=snapshot(),key=Buffer.from(f.s.encryptionKey);f.restart();
    assert.deepEqual(snapshot(),before);assert.deepEqual(f.s.encryptionKey,key);assert.deepEqual(f.e.zone(zone.id).areaIds,[f.a.id]);assert.equal(f.e.zone(zone.id).areaId,f.a.id);assert.ok(sessions.current(token));
    assert.equal(f.s.all('SELECT * FROM security_zone_areas').length,1);f.restart();assert.deepEqual(snapshot(),before);assert.equal(f.s.all('SELECT * FROM security_zone_areas').length,1);
    const candidate=f.e.state().devices[0];assert.equal(candidate.ieee,'0x00124b0000000001');assert.equal(candidate.model,'Example contact');
  }finally{f.close();}
});

test('shared memberships survive restart while cached activations and armed modes retain existing safeguards',()=>{
  const f=fixture();try{
    const zone=f.add();f.report();f.command(f.a,'arm_away');f.command(f.b,'arm_away');f.restart();
    assert.deepEqual(f.e.zone(zone.id).areaIds,[f.a.id,f.b.id]);assert.equal(f.e.area(f.a.id).mode,'away');assert.equal(f.e.area(f.b.id).mode,'away');
    f.e.ingest('contact',{contact:false},{retain:true});assert.equal(f.e.activeIncidents().length,0);f.report({contact:false});assert.equal(f.e.activeIncidents().length,2);
    f.restart();f.report({contact:false});assert.equal(f.e.activeIncidents().length,2);
  }finally{f.close();}
});

test('candidate search exposes only a syntactically valid IEEE identity',()=>{
  const f=fixture();try{
    assert.equal(f.e.state().devices[0].ieee,'0x00124b0000000001');
    const device=f.s.device('contact');device.ieee='private-untrusted-value';f.s.saveDevice(device);
    assert.equal(f.e.state().devices[0].ieee,'');assert.equal(JSON.stringify(f.e.state().devices).includes('private-untrusted-value'),false);
  }finally{f.close();}
});

test('authenticated HTTP shared-zone saves round-trip memberships and area states while invalid or unauthorized changes are atomic',async()=>{
  const f=fixture(),password='synthetic-shared-zone-password',server=createApp(new Engine(f.s),{security:f.e,password});
  const request=(route,body,cookie)=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/api/'+route,method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{cookie}:{})}},res=>{
      let raw='';res.on('data',chunk=>raw+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(raw),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]});}catch(error){reject(error);}});
    });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const admin=await request('login',{username:'admin',password});assert.equal(admin.status,200);
    const created=await request('security/zones',{areaIds:[f.a.id,f.b.id],deviceId:'contact',name:'HTTP shared door',property:'contact',value:false},admin.cookie);
    assert.equal(created.status,201);assert.deepEqual(created.body.zone.areaIds,[f.a.id,f.b.id]);assert.equal(created.body.zone.areaStates.length,2);
    const state=await request('security',undefined,admin.cookie);assert.equal(state.status,200);assert.deepEqual(state.body.zones[0].areaIds,[f.a.id,f.b.id]);assert.deepEqual(state.body.zones[0].areaStates.map(view=>view.areaId),[f.a.id,f.b.id]);assert.equal(state.body.devices[0].ieee,'0x00124b0000000001');
    const before=f.s.all('SELECT * FROM security_zones'),memberships=f.s.all('SELECT * FROM security_zone_areas');
    const invalid=await request('security/zones',{id:created.body.zone.id,areaIds:[]},admin.cookie);assert.equal(invalid.status,400);assert.deepEqual(f.s.all('SELECT * FROM security_zones'),before);assert.deepEqual(f.s.all('SELECT * FROM security_zone_areas'),memberships);
    const account=await request('users',{username:'shared-reader',password,permissions:['viewSecurity']},admin.cookie);assert.equal(account.status,201);
    const reader=await request('login',{username:'shared-reader',password});assert.equal(reader.status,200);
    const read=await request('security',undefined,reader.cookie);assert.equal(read.status,200);assert.equal(read.body.zones[0].areaStates.length,2);assert.equal(read.body.devices[0].ieee,'0x00124b0000000001');
    assert.equal((await request('security/zones',{id:created.body.zone.id,areaIds:[f.a.id]},reader.cookie)).status,403);assert.deepEqual(f.s.all('SELECT * FROM security_zones'),before);assert.deepEqual(f.s.all('SELECT * FROM security_zone_areas'),memberships);
  }finally{server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));f.close();}
});
