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
import {Keypad} from '../server/keypad.mjs';
import {Kiosk} from '../server/kiosk.mjs';
import {createApp} from '../server/http.mjs';

const password='synthetic-cycle-bypass-password',origin='http://127.0.0.1:18920',reason='Synthetic confirmed open window';
function fixture(file=':memory:'){
  let now=Date.UTC(2026,10,9,4),s=new Store(file),health=new Engine(s,{clock:()=>now}),accounts=new Accounts(s,{password,clock:()=>now}),security=new SecurityEngine(s,{clock:()=>now,timezone:'UTC'}),keypad=new Keypad(s,security,accounts,{clock:()=>now}),kiosk=new Kiosk(keypad,{recognizesOrigin:value=>new URL(value).hostname==='127.0.0.1',clock:()=>now});
  const admin=accounts.list()[0],operator=accounts.create({username:'bypass-controller',password,permissions:['controlSecurity']},'Fixture');
  s.saveNetwork({id:'cycle-network',label:'Fixture network',mode:'zigbee2mqtt',enabled:true,connected:true,connectedAt:now-1000,bridgeState:'online'});
  const a=security.saveArea({name:'House',entryDelaySec:0,exitDelaySec:0},'Fixture'),b=security.saveArea({name:'Garage',entryDelaySec:0,exitDelaySec:0},'Fixture'),zones=[];
  for(const [index,id] of ['shared','inside-a','inside-b','extra-a'].entries()){s.saveDevice({id,networkId:'cycle-network',name:'Fixture '+id,ieee:'0x00124b000000001'+index,availability:'online',inventoryPresent:true});zones.push(security.saveZone({areaIds:id==='shared'?[a.id,b.id]:[id==='inside-b'?b.id:a.id],deviceId:id,property:'contact',value:false,name:'Zone '+id},'Fixture'));security.ingest(id,{contact:true});}
  const report=(id,active)=>{now+=10;security.ingest(id,{contact:!active});};
  const prepare=(ids=[a.id],user=admin)=>keypad.command(user,{action:'prepare_arm_away',areaIds:ids});
  const confirm=(preview,ids=[a.id],user=admin)=>keypad.command(user,{action:'arm_away',areaIds:ids,bypass:{token:preview.preview.token,reason}});
  const enable=(changes={})=>kiosk.configure(admin,{enabled:true,origin,cidrs:['127.0.0.1/32'],allAreas:true,areaIds:[],allowBypassArming:true,...changes});
  return {get s(){return s;},get health(){return health;},get accounts(){return accounts;},get security(){return security;},get keypad(){return keypad;},get kiosk(){return kiosk;},admin,operator,a,b,zones,report,prepare,confirm,enable,advance:ms=>now+=ms,close:()=>s.close(),reopen:()=>{s.close();s=new Store(file);health=new Engine(s,{clock:()=>now});accounts=new Accounts(s,{clock:()=>now});security=new SecurityEngine(s,{clock:()=>now,timezone:'UTC'});keypad=new Keypad(s,security,accounts,{clock:()=>now});kiosk=new Kiosk(keypad,{recognizesOrigin:()=>true,clock:()=>now});}};
}
const rows=f=>({areas:f.s.all('SELECT * FROM security_areas ORDER BY id'),zones:f.s.all('SELECT * FROM security_zones ORDER BY id'),events:f.s.all('SELECT * FROM security_events ORDER BY id'),incidents:f.s.all('SELECT * FROM security_incidents ORDER BY id')});
const prepareForce=(f,areaIds=[f.a.id])=>f.keypad.command(f.admin,{action:'prepare_force_arm_away',areaIds});
const confirmForce=(f,prepared,areaIds=[f.a.id])=>f.keypad.command(f.admin,{action:'force_arm_away',areaIds,bypass:{token:prepared.preview.token}});

test('Force Arm previews known open zones and applies only per-area cycle bypasses with a fixed audit reason',()=>{
  const f=fixture();try{
    f.report('inside-a',true);
    assert.equal(f.keypad.state(f.admin).canForceArm,true);
    assert.throws(()=>f.keypad.command(f.admin,{action:'arm_away',areaIds:[f.a.id]}),/not ready/);
    const before=rows(f),prepared=prepareForce(f,[f.a.id,f.b.id]);
    assert.equal(prepared.action,'prepare_force_arm_away');assert.deepEqual(rows(f),before);
    assert.deepEqual(prepared.preview.areas.find(area=>area.id===f.a.id).blockingZones,[{id:f.zones[1].id,name:'Zone inside-a',status:'active',trouble:null}]);
    assert.deepEqual(prepared.preview.areas.find(area=>area.id===f.b.id).blockingZones,[]);
    const result=confirmForce(f,prepared,[f.a.id,f.b.id]);assert.equal(result.action,'force_arm_away');
    assert.deepEqual(f.security.area(f.a.id).cycleBypass.zoneIds,[f.zones[1].id]);assert.equal(f.security.area(f.b.id).mode,'away');
    assert.equal(Object.hasOwn(f.security.area(f.b.id),'cycleBypass'),false);assert.deepEqual(rows(f).zones,before.zones);
    const audit=f.security.state().events.find(event=>event.type==='cycle_bypass_armed');
    assert.equal(audit.actor,f.admin.username);assert.match(audit.message,/Reason: Force Arm: bypass known open zones$/);
    f.security.command(f.a.id,'disarm',{},'Fixture');assert.equal(Object.hasOwn(f.security.area(f.a.id),'cycleBypass'),false);
  }finally{f.close();}
});

test('Force Arm rejects mixed open and trouble blockers including an active status carrying trouble',()=>{
  for(const condition of ['offline','unknown','active-with-trouble']){
    const f=fixture();try{
      f.report('shared',true);
      if(condition==='offline')f.s.saveDevice({...f.s.device('inside-a'),availability:'offline'});
      if(condition==='unknown')f.security.readings.delete('inside-a');
      if(condition==='active-with-trouble'){
        f.report('inside-a',true);const view=f.security.zoneView.bind(f.security);
        f.security.zoneView=(zone,...args)=>{const value=view(zone,...args);return zone.id===f.zones[1].id?{...value,trouble:'Synthetic active detector trouble'}:value;};
      }
      const before=rows(f);assert.throws(()=>prepareForce(f),/only bypasses known open zones/);
      assert.deepEqual(rows(f),before);assert.equal(f.keypad.armPreviews.size,0);
      const manual=f.prepare();assert.equal(manual.preview.areas[0].blockingZones.length,2);
      assert.equal(f.confirm(manual).action,'arm_away');assert.equal(f.security.area(f.a.id).cycleBypass.zoneIds.length,2);
    }finally{f.close();}
  }
});

test('Force Arm requires at least one open blocker and one protected zone in each selected area',()=>{
  const f=fixture();try{
    assert.throws(()=>prepareForce(f,[f.a.id,f.b.id]),/use Arm away/);
    for(const id of ['shared','inside-a','extra-a'])f.report(id,true);
    const before=rows(f);assert.throws(()=>prepareForce(f,[f.a.id,f.b.id]),/must remain protected/);
    assert.deepEqual(rows(f),before);
  }finally{f.close();}
});

test('Force Arm requires its own preview token and rejects a caller-supplied audit reason',()=>{
  const f=fixture();try{
    f.report('shared',true);const before=rows(f);
    assert.throws(()=>f.keypad.command(f.admin,{action:'force_arm_away',areaIds:[f.a.id]}),/Review the open zones/);
    const manual=f.prepare();assert.throws(()=>confirmForce(f,manual),/expired or changed/);
    assert.equal(f.keypad.armPreviews.has(manual.preview.token),false);
    const forced=prepareForce(f);assert.throws(()=>f.confirm(forced),/expired or changed/);
    assert.equal(f.keypad.armPreviews.has(forced.preview.token),false);
    const replacement=prepareForce(f);
    assert.throws(()=>f.keypad.command(f.admin,{action:'force_arm_away',areaIds:[f.a.id],bypass:{token:replacement.preview.token,reason:'Override'}}),/Unknown keypad field/);
    assert.deepEqual(rows(f),before);
  }finally{f.close();}
});

test('Force Arm rechecks trouble at confirmation and again when applying the cycle bypass',()=>{
  const f=fixture();try{
    f.report('shared',true);let prepared=prepareForce(f);
    f.security.readings.delete('shared');const before=rows(f);
    assert.throws(()=>confirmForce(f,prepared),/only bypasses known open zones/);
    assert.deepEqual(rows(f),before);assert.equal(f.keypad.armPreviews.has(prepared.preview.token),false);
    f.report('shared',true);prepared=prepareForce(f);
    const arm=f.security.armWithCycleBypass.bind(f.security);
    f.security.armWithCycleBypass=(...args)=>{f.s.saveDevice({...f.s.device('shared'),availability:'offline'});return arm(...args);};
    assert.throws(()=>confirmForce(f,prepared),/only bypasses known open zones/);
    assert.deepEqual(rows(f),before);assert.equal(f.s.device('shared').availability,'online');
    assert.equal(f.keypad.armPreviews.has(prepared.preview.token),false);
  }finally{f.close();}
});

test('Force Arm keeps signed-in control grants and the kiosk opt-in and selected-area scope',()=>{
  const f=fixture();try{
    f.report('shared',true);const viewer=f.accounts.create({username:'force-arm-reader',password,permissions:['viewSecurity']},'Fixture');
    assert.equal(f.keypad.state(viewer).canForceArm,false);
    assert.throws(()=>f.keypad.command(viewer,{action:'prepare_force_arm_away',areaIds:[f.a.id]}),error=>error.statusCode===403);
    f.enable({allowBypassArming:false});assert.equal(f.kiosk.state().canForceArm,false);
    assert.throws(()=>f.kiosk.command({action:'prepare_force_arm_away',all:true}),error=>error.statusCode===403);
    f.enable({allAreas:false,areaIds:[f.a.id]});assert.equal(f.kiosk.state().canForceArm,true);
    assert.throws(()=>f.kiosk.command({action:'prepare_force_arm_away',areaIds:[f.a.id,f.b.id]}),error=>error.statusCode===403);
    const prepared=f.kiosk.command({action:'prepare_force_arm_away',all:true});assert.equal(prepared.action,'prepare_force_arm_away');
    const result=f.kiosk.command({action:'force_arm_away',all:true,bypass:{token:prepared.preview.token}});
    assert.equal(result.action,'force_arm_away');assert.deepEqual(result.areaIds,[f.a.id]);assert.equal(f.security.area(f.b.id).mode,'disarmed');
    assert.equal(result.areas[0].cycleBypassCount,1);assert.equal(Object.hasOwn(result.areas[0],'cycleBypass'),false);
    assert.equal(f.security.state().events.find(event=>event.type==='cycle_bypass_armed').actor,'Local kiosk');
  }finally{f.close();}
});

test('bypass preview is opaque, read-only, caller-bound and lists exact blockers with remaining protection',()=>{
  const f=fixture();try{f.report('shared',true);const before=rows(f),changes=f.s.one('SELECT total_changes() n').n,schema=f.s.all('SELECT * FROM sqlite_master ORDER BY name'),users=f.s.all('SELECT * FROM users');f.s.db.exec('PRAGMA query_only=ON');const result=f.prepare();assert.equal(result.action,'prepare_arm_away');assert.match(result.preview.token,/^[a-f0-9]{64}$/);assert.equal(result.preview.expiresAt,f.keypad.now()+120000);assert.deepEqual(result.preview.areas,[{id:f.a.id,name:'House',blockingZones:[{id:f.zones[0].id,name:'Zone shared',status:'active',trouble:null}],protectedZoneCount:2}]);for(const secret of [f.admin.id,f.admin.username,'cycle-network','deviceId','authVersion','cycleBypass','password'])assert.equal(JSON.stringify(result).includes(secret),false,secret);assert.deepEqual(rows(f),before);assert.deepEqual(f.s.all('SELECT * FROM sqlite_master ORDER BY name'),schema);assert.deepEqual(f.s.all('SELECT * FROM users'),users);assert.equal(f.s.one('SELECT total_changes() n').n,changes);}finally{f.close();}
});

test('confirmed cycle bypass protects shared zones in other armed areas and leaves global bypass and edge state untouched',()=>{
  const f=fixture();try{
    f.report('shared',true);assert.throws(()=>f.keypad.command(f.admin,{action:'arm_away',areaIds:[f.a.id]}),/not ready/);const preview=f.prepare(),edges=JSON.stringify([...f.security.edges]),global=f.s.one('SELECT * FROM security_zones WHERE id=?',f.zones[0].id);f.confirm(preview);assert.equal(JSON.stringify([...f.security.edges]),edges);assert.deepEqual(f.s.one('SELECT * FROM security_zones WHERE id=?',f.zones[0].id),global);
    const view=f.keypad.state(f.admin).areas.find(area=>area.id===f.a.id);assert.equal(view.cycleBypassCount,1);assert.deepEqual(view.cycleBypasses,[{id:f.zones[0].id,name:'Zone shared'}]);assert.equal(view.zoneIssues[0].status,'active');assert.equal(view.zoneIssues[0].manualBypassed,false);assert.equal(view.zoneIssues[0].cycleBypassed,true);
    f.report('shared',false);f.security.command(f.b.id,'arm_away',{},'Fixture');f.report('shared',true);assert.equal(f.security.activeIncidents(f.a.id).length,0);assert.equal(f.security.activeIncidents(f.b.id).length,1);assert.equal(f.security.zoneView(f.security.zone(f.zones[0].id),f.security.area(f.a.id)).cycleBypassed,true);assert.equal(f.security.zoneView(f.security.zone(f.zones[0].id),f.security.area(f.b.id)).cycleBypassed,false);
  }finally{f.close();}
});

test('mixed ready and blocked selections arm atomically and disarming one area clears only its cycle bypass',()=>{
  const f=fixture();try{f.report('inside-a',true);const preview=f.prepare([f.a.id,f.b.id]);assert.equal(preview.preview.areas.find(area=>area.id===f.b.id).blockingZones.length,0);f.confirm(preview,[f.a.id,f.b.id]);assert.equal(f.security.area(f.a.id).mode,'away');assert.equal(f.security.area(f.b.id).mode,'away');assert.equal(f.security.areaView(f.security.area(f.a.id)).cycleBypassCount,1);assert.equal(f.security.areaView(f.security.area(f.b.id)).cycleBypassCount,0);
    f.security.command(f.a.id,'disarm',{},'Fixture');assert.equal(Object.hasOwn(f.security.area(f.a.id),'cycleBypass'),false);assert.equal(f.security.area(f.b.id).mode,'away');assert.throws(()=>f.security.command(f.a.id,'arm_away',{},'Fixture'),/not ready/);
  }finally{f.close();}
});

test('offline and unknown blockers require explicit confirmation while raw trouble remains visible after bypass',()=>{
  for(const condition of ['offline','unknown']){const f=fixture();try{if(condition==='offline')f.s.saveDevice({...f.s.device('shared'),availability:'offline'});else f.security.readings.delete('shared');const preview=f.prepare();assert.equal(preview.preview.areas[0].blockingZones[0].status,condition==='offline'?'trouble':'unknown');f.confirm(preview);const area=f.keypad.state(f.admin).areas.find(area=>area.id===f.a.id);assert.equal(area.zoneTroubleCount,1);assert.equal(area.zoneIssues[0].status,condition==='offline'?'trouble':'unknown');assert.equal(area.zoneIssues[0].cycleBypassed,true);assert.equal(area.mode,'away');}finally{f.close();}}
});

test('disabled, empty, already armed, alarm-memory and fully blocked areas cannot be bypass-armed',()=>{
  for(const condition of ['disabled','empty','armed','alarm','all-faults']){const f=fixture();try{
    if(condition==='disabled')f.security.saveArea({id:f.a.id,enabled:false},'Fixture');if(condition==='empty')for(const zone of f.security.zones().filter(zone=>zone.areaIds.includes(f.a.id)))f.security.saveZone({id:zone.id,enabled:false},'Fixture');if(condition==='armed')f.security.command(f.a.id,'arm_away',{},'Fixture');if(condition==='alarm'){f.security.command(f.a.id,'arm_away',{},'Fixture');f.report('shared',true);f.security.command(f.a.id,'disarm',{},'Fixture');}if(condition==='all-faults'){for(const id of ['shared','inside-a','extra-a'])f.report(id,true);}const before=rows(f);assert.throws(()=>f.prepare());assert.deepEqual(rows(f),before);
  }finally{f.close();}}
});

test('fresh blocker, configuration, schedule and cycle changes invalidate a one-shot preview without writes',()=>{
  for(const condition of ['extra-fault','restored','unknown','zone-config','reading-timeout','schedule','cycle','manual-bypass']){const f=fixture();try{
    f.report('shared',true);const preview=f.prepare();
    if(condition==='reading-timeout')f.security.saveSettings({readingTimeoutMin:60,expectedReadingTimeoutMin:10080},'Fixture');
    if(condition==='extra-fault')f.report('inside-a',true);if(condition==='restored')f.report('shared',false);if(condition==='unknown')f.security.readings.delete('shared');if(condition==='zone-config')f.security.saveZone({id:f.zones[0].id,name:'Changed zone'},'Fixture');if(condition==='schedule')f.security.saveSchedule({name:'Changed schedule',areaId:f.a.id,days:[0],time:'12:00',mode:'away',enabled:false},'Fixture');if(condition==='cycle'){f.report('shared',false);f.security.command(f.a.id,'arm_away',{},'Fixture');f.security.command(f.a.id,'disarm',{},'Fixture');f.report('shared',true);}if(condition==='manual-bypass')f.security.bypassZone(f.zones[0].id,{durationMin:null,reason:'Synthetic maintenance'},'Fixture');const before=rows(f);assert.throws(()=>f.confirm(preview),/changed|review/i);assert.deepEqual(rows(f),before);assert.throws(()=>f.confirm(preview),/expired or changed/);
  }finally{f.close();}}
});

test('expired, mismatched-area and invalid-reason previews are consumed while another caller cannot use them',()=>{
  const f=fixture();try{f.report('shared',true);let preview=f.prepare();assert.throws(()=>f.confirm(preview,[f.a.id],f.operator),/expired or changed/);assert.equal(f.keypad.armPreviews.has(preview.preview.token),true);f.advance(120000);assert.throws(()=>f.confirm(preview),/expired or changed/);assert.equal(f.keypad.armPreviews.has(preview.preview.token),false);
    preview=f.prepare();assert.throws(()=>f.confirm(preview,[f.a.id,f.b.id]),/expired or changed/);assert.equal(f.keypad.armPreviews.has(preview.preview.token),false);preview=f.prepare();assert.throws(()=>f.keypad.command(f.admin,{action:'arm_away',areaIds:[f.a.id],bypass:{token:preview.preview.token,reason:''}}),/reason/);assert.throws(()=>f.confirm(preview),/expired or changed/);
  }finally{f.close();}
});

test('permission removal and restoration cannot revive a preview under the same user ID',()=>{
  const f=fixture();try{f.report('shared',true);const preview=f.prepare([f.a.id],f.operator);f.accounts.update({id:f.operator.id,permissions:['viewSecurity']},'Fixture');assert.throws(()=>f.confirm(preview,[f.a.id],f.operator),/control access/);f.accounts.update({id:f.operator.id,permissions:['controlSecurity']},'Fixture');assert.throws(()=>f.confirm(preview,[f.a.id],f.operator),/expired or changed/);assert.equal(f.security.area(f.a.id).mode,'disarmed');}finally{f.close();}
});

test('kiosk bypass capability defaults false for legacy settings without rewriting their stored bytes',()=>{
  const f=fixture();try{const legacy={enabled:true,origin,cidrs:['127.0.0.1/32'],allAreas:true,areaIds:[]};f.s.set('kioskSettings',legacy);const raw=f.s.one("SELECT value FROM settings WHERE key='kioskSettings'").value,changes=f.s.one('SELECT total_changes() n').n;f.report('shared',true);const afterReport=f.s.one('SELECT total_changes() n').n;assert.equal(f.kiosk.config().allowBypassArming,false);assert.equal(f.kiosk.state().canBypassArm,false);assert.throws(()=>f.kiosk.command({action:'prepare_arm_away',areaIds:[f.a.id]}),/not enabled/);assert.equal(f.s.one("SELECT value FROM settings WHERE key='kioskSettings'").value,raw);assert.equal(f.s.one('SELECT total_changes() n').n,afterReport);assert.ok(afterReport>=changes);}finally{f.close();}
});

test('kiosk preview binds opt-in, complete configuration and scope; disable and restore never revives it',()=>{
  for(const change of ['flag','scope','origin','cidrs','disable-restore']){const f=fixture();try{f.enable();f.report('shared',true);const preview=f.kiosk.command({action:'prepare_arm_away',areaIds:[f.a.id]});if(change==='flag')f.enable({allowBypassArming:false});if(change==='scope')f.enable({allAreas:false,areaIds:[f.b.id]});if(change==='origin')f.enable({origin:'http://127.0.0.1:18921'});if(change==='cidrs')f.enable({cidrs:['127.0.0.0/8']});if(change==='disable-restore'){f.enable({enabled:false});f.enable();}const before=rows(f);assert.throws(()=>f.kiosk.command({action:'arm_away',areaIds:[f.a.id],bypass:{token:preview.preview.token,reason}}));assert.deepEqual(rows(f),before);assert.equal(f.security.area(f.a.id).mode,'disarmed');}finally{f.close();}}
});

test('kiosk bypass confirmation and PIN disarm retain assigned-area scope and sanitized responses',()=>{
  const f=fixture();try{f.keypad.saveUser(f.admin,{id:f.operator.id,operation:'set',pin:'0471',areaIds:[f.a.id]});f.enable();f.report('shared',true);const preview=f.kiosk.command({action:'prepare_arm_away',all:true}),result=f.kiosk.command({action:'arm_away',all:true,bypass:{token:preview.preview.token,reason}});for(const area of result.areas){assert.equal(area.cycleBypassCount,1);assert.equal(area.zoneIssues[0].cycleBypassed,true);}for(const secret of [f.operator.username,reason,'cycleBypass"','authVersion'])assert.equal(JSON.stringify(result).includes(secret),false,secret);
    const disarmed=f.kiosk.command({action:'disarm',all:true,pin:'0471'});assert.deepEqual(disarmed.areaIds,[f.a.id]);assert.equal(Object.hasOwn(f.security.area(f.a.id),'cycleBypass'),false);assert.equal(f.security.area(f.b.id).mode,'away');assert.equal(f.security.areaView(f.security.area(f.b.id)).cycleBypassCount,1);
  }finally{f.close();}
});

test('multi-area bypass failure rolls back every area and audit entry and consumes the preview',()=>{
  const f=fixture();try{f.report('shared',true);const preview=f.prepare([f.a.id,f.b.id]),before=rows(f),edges=JSON.stringify([...f.security.edges]),arm=f.security.armWithCycleBypass.bind(f.security);let calls=0;f.security.armWithCycleBypass=(...args)=>{const result=arm(...args);if(++calls===2)throw Error('Synthetic second-area failure');return result;};assert.throws(()=>f.confirm(preview,[f.a.id,f.b.id]),/Synthetic second-area failure/);assert.deepEqual(rows(f),before);assert.equal(JSON.stringify([...f.security.edges]),edges);assert.equal(f.keypad.armPreviews.has(preview.preview.token),false);}finally{f.close();}
});

test('armed restart retains only selected area cycle bypass; pending exit restart clears it and previews do not survive',()=>{
  for(const pending of [false,true]){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zigbee-cycle-restart-'));let f;try{f=fixture(path.join(dir,'health.db'));if(pending)f.security.saveArea({id:f.a.id,exitDelaySec:30},'Fixture');f.report('shared',true);const preview=f.prepare();f.confirm(preview);const cycle=f.security.area(f.a.id).cycleId,zone=f.s.one('SELECT * FROM security_zones WHERE id=?',f.zones[0].id);f.reopen();const area=f.security.area(f.a.id);assert.deepEqual(f.s.one('SELECT * FROM security_zones WHERE id=?',f.zones[0].id),zone);assert.equal(area.mode,pending?'disarmed':'away');assert.equal(area.cycleId,cycle);assert.equal(Object.hasOwn(area,'cycleBypass'),!pending);assert.equal(f.security.areaView(area).cycleBypassCount,pending?0:1);assert.equal(f.keypad.armPreviews.size,0);assert.equal(f.security.area(f.b.id).mode,'disarmed');}finally{f?.close();const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('zigbee-cycle-restart-'));fs.rmSync(resolved,{recursive:true,force:true});}}
});

test('a new fault during exit delay cancels arming and clears only cycle bypass instead of automatically bypassing it',()=>{
  const f=fixture();try{f.security.saveArea({id:f.a.id,exitDelaySec:30},'Fixture');f.report('shared',true);f.confirm(f.prepare());assert.equal(f.security.areaView(f.security.area(f.a.id)).cycleBypassCount,1);f.report('inside-a',true);const edges=JSON.stringify([...f.security.edges]);f.advance(30001);f.security.tick();const area=f.security.area(f.a.id);assert.equal(area.mode,'disarmed');assert.equal(area.targetMode,null);assert.equal(Object.hasOwn(area,'cycleBypass'),false);assert.equal(JSON.stringify([...f.security.edges]),edges);assert.equal(f.security.zone(f.zones[0].id).bypassAt,null);assert.equal(f.security.zone(f.zones[1].id).bypassAt,null);assert.equal(f.security.activeIncidents().length,0);}finally{f.close();}
});

test('arming revisions are opaque and change on scope-relevant configuration, account authority and kiosk saves',()=>{
  const f=fixture();try{const initial=f.keypad.state(f.operator).armingRevision;assert.match(initial,/^[a-f0-9]{64}$/);assert.equal(f.keypad.state(f.operator).armingRevision,initial);f.security.saveZone({id:f.zones[0].id,operator:'ne',value:true},'Fixture');assert.notEqual(f.keypad.state(f.operator).armingRevision,initial);f.enable();const kioskRevision=f.kiosk.state().armingRevision;f.enable();assert.notEqual(f.kiosk.state().armingRevision,kioskRevision);}finally{f.close();}
});

test('existing HTTP command endpoints enforce preview authority while direct Security rejects bypass fields',async()=>{
  const f=fixture();let server;try{f.report('shared',true);server=createApp(f.health,{password,security:f.security,keypad:f.keypad,kiosk:f.kiosk});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port,local='http://127.0.0.1:'+port;f.enable({origin:local});const request=(route,body,cookie)=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:'/api/'+route,method:'POST',headers:{origin:local,'content-type':'application/json',...(cookie?{cookie}:{})}},res=>{let raw='';res.on('data',part=>raw+=part);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw),cookie:res.headers['set-cookie']?.[0].split(';')[0]}));});req.on('error',reject);req.end(JSON.stringify(body));});
    assert.equal((await request('keypad/command',{action:'prepare_arm_away',areaIds:[f.a.id]})).status,401);const login=await request('login',{username:'admin',password});assert.equal((await request('security/command',{areaId:f.a.id,action:'disarm',actor:'forged-actor'},login.cookie)).status,200);assert.equal(f.security.state().events.find(event=>event.type==='area_disarmed').actor,'admin');for(const bypass of [{bypass:{token:'a'.repeat(64),reason}},{bypassZoneIds:[f.zones[0].id]},{cycleBypass:{zoneIds:[f.zones[0].id]}}])assert.equal((await request('security/command',{areaId:f.a.id,action:'arm_away',actor:'forged-actor',...bypass},login.cookie)).status,400);assert.equal((await request('security/command',{areaId:f.a.id,action:'prepare_arm_away'},login.cookie)).status,400);
    const preview=await request('kiosk/command',{action:'prepare_arm_away',areaIds:[f.a.id]});assert.equal(preview.status,200);assert.equal((await request('kiosk/command',{action:'arm_away',areaIds:[f.a.id],bypass:{token:preview.body.preview.token,reason}})).status,200);assert.equal(f.security.area(f.a.id).mode,'away');assert.equal(f.security.areaView(f.security.area(f.a.id)).cycleBypassCount,1);
  }finally{server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));f.close();}
});
