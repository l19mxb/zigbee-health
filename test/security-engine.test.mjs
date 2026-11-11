import test from 'node:test';
import assert from 'node:assert/strict';
import {Store,defaults} from '../server/store.mjs';
import {SecurityEngine,defaultSecurityPayload} from '../server/security.mjs';

function fixture({demo=false,time=Date.UTC(2026,10,8,0,0,5),entryDelaySec=0,exitDelaySec=0}={}){
  let now=time;const s=new Store();s.set('thresholds',{...defaults});
  s.saveNetwork({id:'net',label:'Example network',mode:'zigbee2mqtt',enabled:true,connected:true,connectedAt:now-1000,bridgeState:'online'});
  for(const [id,name] of [['door','Front door'],['motion','Living room motion']])s.saveDevice({id,networkId:'net',name,ieee:id==='door'?'0x0000000000000001':'0x0000000000000002',availability:'online',inventoryPresent:true,power:'battery'});
  let e=new SecurityEngine(s,{demo,clock:()=>now,timezone:'UTC'});
  const area=e.saveArea({name:'Home',entryDelaySec,exitDelaySec},'tester');
  const door=e.saveZone({areaId:area.id,deviceId:'door',name:'Front door',property:'contact',operator:'eq',value:false,type:'entry'},'tester');
  const motion=e.saveZone({areaId:area.id,deviceId:'motion',name:'Living room',property:'occupancy',value:true,type:'instant',homeBypass:true},'tester');
  const report=(device,payload,options={})=>e.ingest(device,payload,{at:now,...options});
  const normal=()=>{report('door',{contact:true});report('motion',{occupancy:false});};
  const arm=mode=>e.command(area.id,mode==='home'?'arm_home':'arm_away',{},'tester');
  const action=(kind='mqtt')=>e.saveAction({name:kind+' alert',areaId:area.id,kind,enabled:true,networkId:'net',topic:'example/security/events',payloadTemplate:defaultSecurityPayload},'tester');
  return {s,area,door,motion,report,normal,arm,action,get e(){return e;},now:()=>now,advance:ms=>now+=ms,setTime:value=>now=value,restart:()=>{e=new SecurityEngine(s,{demo,clock:()=>now,timezone:'UTC'});return e;},close:()=>s.close()};
}
function tickFor(f,ms){while(ms>0){const step=Math.min(10000,ms);f.advance(step);f.e.tick();ms-=step;}}

test('security startup is additive, empty, and cannot bootstrap accounts or existing configuration',()=>{
  const s=new Store();s.set('custom',{unchanged:true});s.saveNetwork({id:'net',label:'Private broker',password:s.seal('fixture-secret')});
  const tables=s.all("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");const settings=s.all('SELECT * FROM settings');const networks=s.networks();
  const e=new SecurityEngine(s,{clock:()=>1794000000000});assert.equal(e.state().areas.length,0);assert.equal(e.state().actions.length,0);
  assert.deepEqual(s.all("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'security_%' AND name NOT LIKE 'sqlite_%'"),tables);assert.deepEqual(s.all('SELECT * FROM settings'),settings);assert.deepEqual(s.networks(),networks);s.close();
});

test('new areas are disarmed and unknown zones block both arming modes',()=>{const f=fixture();assert.equal(f.e.state().areas[0].mode,'disarmed');assert.equal(f.e.state().zones[0].status,'unknown');assert.throws(()=>f.arm(),/not ready/);assert.throws(()=>f.arm('home'),/not ready/);assert.equal(f.e.activeIncidents().length,0);f.close();});

test('retained, duplicate, invalid and out-of-window reports never establish a baseline or alarm',()=>{const f=fixture();for(const options of [{retain:true},{dup:true},{at:f.now()-60001},{at:f.now()+1001}])f.report('door',{contact:true},options);for(const payload of [null,[],true,'{"contact":true}'])f.report('door',payload);assert.equal(f.e.state().zones[0].known,false);assert.equal(f.s.all('SELECT * FROM security_readings').length,0);f.close();});

test('fresh normal-to-active edge raises one latched incident and one action per arm cycle',()=>{const f=fixture();f.normal();f.action();f.arm();f.advance(100);f.report('door',{contact:false});const incident=f.e.activeIncidents()[0];assert.ok(incident);assert.equal(f.e.queuedActions().length,1);for(let i=0;i<10;i++)f.report('door',{contact:false});f.report('door',{contact:true});f.report('door',{contact:false});assert.equal(f.e.activeIncidents().length,1);assert.equal(f.e.queuedActions().length,1);assert.equal(f.e.state().areas[0].status,'alarm');f.close();});

test('24-hour stateful zones alarm only on a fresh edge and keep independent memory while disarmed',()=>{
  const f=fixture();try{
    f.e.saveZone({id:f.door.id,type:'24hour'});f.action();
    f.report('door',{contact:false},{retain:true});f.report('door',{contact:false},{dup:true});
    f.report('door',{contact:false});f.report('door',{contact:false});
    assert.equal(f.e.activeIncidents().length,0);
    f.report('door',{contact:true});f.restart();
    assert.equal(f.e.activeIncidents().length,0);
    f.advance(10);f.report('door',{contact:false});f.report('door',{contact:false});
    const [alarm]=f.e.activeIncidents();
    assert.equal(f.e.activeIncidents().length,1);
    assert.deepEqual([alarm.zoneType,alarm.silent,alarm.mode,alarm.restoredAt],['24hour',false,'disarmed',null]);
    assert.equal(f.e.queuedActions().length,1);
    const area=()=>f.e.areaView(f.e.requireArea(f.area.id));
    assert.deepEqual([area().status,area().active24HourAlarmCount,area().unacknowledged24HourAlarmCount,area().keypadSiren],['alarm',1,1,true]);
    f.e.command(f.area.id,'disarm',{},'operator');
    assert.equal(area().keypadSiren,true);
    f.e.command(f.area.id,'acknowledge',{},'operator');
    assert.deepEqual([area().active24HourAlarmCount,area().unacknowledged24HourAlarmCount,area().keypadSiren],[1,0,false]);
    assert.throws(()=>f.e.command(f.area.id,'reset',{},'operator'),/Restore/);
    f.restart();f.report('door',{contact:false});
    assert.equal(f.e.activeIncidents().length,1);
    f.advance(10);f.report('door',{contact:true});
    assert.ok(f.e.activeIncidents()[0].restoredAt);
    f.advance(10);f.report('door',{contact:false});
    const incidents=f.e.activeIncidents();
    assert.equal(incidents.length,2);assert.notEqual(incidents[0].cycleId,incidents[1].cycleId);
    assert.deepEqual([area().active24HourAlarmCount,area().unacknowledged24HourAlarmCount,area().keypadSiren],[2,1,true]);
  }finally{f.close();}
});

test('24-hour action buttons accept repeated presses, suppress duplicate samples, and route silent alarms to each enabled area',()=>{
  const f=fixture();try{
    const annex=f.e.saveArea({name:'Annex'}),zone=f.e.saveZone({id:f.motion.id,areaIds:[f.area.id,annex.id],type:'24hour',property:'action',value:'single',silent:true});
    assert.deepEqual([zone.known,zone.active,zone.ready,zone.status,zone.homeBypass],[true,false,true,'normal',false]);
    f.s.set('email',{enabled:true});f.action();f.e.saveAction({name:'Annex email',areaId:annex.id,kind:'email',enabled:true});
    const timestamped=()=>f.report('motion',{action:'single',last_seen:f.now()});
    f.report('motion',{action:'single'},{retain:true});f.report('motion',{action:'single'},{dup:true});
    f.report('motion',{action:'other'});f.report('motion',{action:null});
    assert.equal(f.e.activeIncidents().length,0);
    timestamped();timestamped();
    const first=f.e.activeIncidents();
    assert.equal(first.length,2);assert.equal(first[0].cycleId,first[1].cycleId);
    assert.ok(first.every(incident=>incident.silent&&incident.zoneType==='24hour'&&incident.restoredAt));
    assert.deepEqual(new Set(f.e.queuedActions().map(job=>job.action.kind)),new Set(['mqtt','email']));
    assert.ok(f.e.state().areas.every(area=>area.status==='alarm'&&area.unacknowledged24HourAlarmCount===1&&!area.keypadSiren));
    f.restart();timestamped();
    assert.equal(f.e.activeIncidents().length,2);
    f.advance(10);timestamped();
    f.report('motion',{action:'single'});f.report('motion',{action:'single'});
    assert.equal(f.e.activeIncidents().length,8);
    f.e.saveArea({id:annex.id,enabled:false});
    f.report('motion',{action:'single'});
    assert.equal(f.e.activeIncidents(annex.id).length,4);assert.equal(f.e.activeIncidents(f.area.id).length,5);
    f.s.saveDevice({...f.s.device('motion'),availability:'offline'});
    const unavailable=f.e.zoneState(f.e.zone(zone.id));
    assert.deepEqual([unavailable.known,unavailable.ready,unavailable.status],[false,false,'trouble']);
    f.report('motion',{action:'single'});
    assert.equal(f.e.activeIncidents().length,9);
    f.s.saveDevice({...f.s.device('motion'),availability:'online'});f.normal();
    f.e.command(f.area.id,'acknowledge',{},'operator');
    f.e.command(f.area.id,'reset',{},'operator');
    assert.equal(f.e.activeIncidents(f.area.id).length,0);
    f.report('motion',{action:'single'});
    assert.equal(f.e.activeIncidents(f.area.id).length,1);
    assert.equal(f.e.activeIncidents(annex.id).length,4);
  }finally{f.close();}
});

test('24-hour rules cannot be bypassed and do not determine ordinary arming readiness',()=>{
  const f=fixture();try{
    assert.throws(()=>f.e.saveZone({id:f.motion.id,type:'24hour',homeBypass:true}),/cannot be bypassed in Home/);
    assert.throws(()=>f.e.saveZone({id:f.motion.id,type:'24hour',property:'action',operator:'ne',value:'single'}),/nonempty text value/);
    f.e.bypassZone(f.motion.id,{durationMin:null,reason:'Legacy test bypass'});
    const zone=f.e.saveZone({id:f.motion.id,type:'24hour',silent:true});
    assert.deepEqual([zone.homeBypass,zone.bypassAt,zone.bypassUntil,zone.silent],[false,null,null,true]);
    assert.throws(()=>f.e.bypassZone(zone.id,{durationMin:null,reason:'Test bypass'}),/24-hour zones cannot be bypassed/);
    f.report('door',{contact:true});
    const readiness=f.e.readiness(f.e.requireArea(f.area.id),'away',undefined,{includeBypassCandidates:true});
    assert.deepEqual([readiness.ready,readiness.zoneCount,readiness.alwaysActiveZoneCount,readiness.includedCount],[true,2,1,1]);
    assert.deepEqual(readiness.bypassCandidates.map(item=>item.id),[f.door.id]);
    f.arm('home');
    const armed=f.e.requireArea(f.area.id);
    assert.throws(()=>f.e.bypassZoneForCycle({areaId:armed.id,cycleId:armed.cycleId,zoneId:zone.id}),/no longer included/);
    f.e.command(armed.id,'disarm',{},'operator');
    f.e.saveZone({id:f.door.id,enabled:false});
    assert.throws(()=>f.arm(),/included zone must remain protected/);
    f.report('motion',{occupancy:false});f.report('motion',{occupancy:true});
    assert.equal(f.e.activeIncidents().length,1);
    f.e.saveZone({id:zone.id,type:'instant'});
    assert.equal(Object.hasOwn(f.e.zone(zone.id),'silent'),false);
    assert.equal(f.e.activeIncidents()[0].silent,true);
  }finally{f.close();}
});

test('a 24-hour activation interrupts both exit and entry delays immediately',()=>{
  const f=fixture({exitDelaySec:5,entryDelaySec:20});try{
    const zone=f.e.saveZone({id:f.motion.id,type:'24hour',property:'action',value:'single'});
    f.normal();f.arm();assert.equal(f.e.requireArea(f.area.id).targetMode,'away');
    f.report('motion',{action:'single'});
    let area=f.e.requireArea(f.area.id);
    assert.deepEqual([area.mode,area.targetMode,area.exitAt],['disarmed',null,null]);
    assert.equal(f.e.activeIncidents()[0].zoneId,zone.id);
    assert.equal(f.e.state().events.filter(event=>event.type==='arm_blocked').length,1);
    f.e.command(area.id,'acknowledge',{},'operator');f.e.command(area.id,'reset',{},'operator');
    f.arm();f.advance(5000);f.e.tick();
    f.report('door',{contact:false});assert.ok(f.e.requireArea(area.id).entryAt);
    f.report('motion',{action:'single'});area=f.e.requireArea(area.id);
    assert.deepEqual([area.mode,area.entryAt,area.pendingZoneId],['away',null,null]);
    assert.deepEqual(f.e.activeIncidents().map(incident=>incident.zoneId),[zone.id]);
  }finally{f.close();}
});

test('restore, acknowledge, disarm and reset remain separate and accountable',()=>{const f=fixture();f.normal();f.arm();f.report('door',{contact:false});f.e.command(f.area.id,'acknowledge',{},'operator');assert.ok(f.e.activeIncidents()[0].ackAt);assert.equal(f.e.activeIncidents()[0].ackBy,'operator');assert.equal(f.e.state().areas[0].mode,'away');assert.throws(()=>f.e.command(f.area.id,'reset',{},'operator'),/Disarm/);f.e.command(f.area.id,'disarm',{},'operator');assert.equal(f.e.activeIncidents().length,1);assert.throws(()=>f.e.command(f.area.id,'reset',{},'operator'),/Restore/);f.report('door',{contact:true});f.e.command(f.area.id,'reset',{},'operator');assert.equal(f.e.activeIncidents().length,0);assert.equal(f.e.state().areas[0].status,'disarmed');assert.ok(f.e.state().events.some(event=>event.actor==='operator'&&event.type==='alarm_reset'));f.close();});

test('acknowledging the entire Security stack is atomic and preserves reset history, modes and deliveries',()=>{
  const f=fixture();try{
    f.normal();f.action();f.arm();f.report('door',{contact:false});
    const historical=f.e.activeIncidents()[0].id;
    f.e.command(f.area.id,'acknowledge',{},'original operator');
    f.e.command(f.area.id,'disarm',{},'tester');f.normal();
    f.e.command(f.area.id,'reset',{},'tester');
    f.s.run('UPDATE security_incidents SET ack_at=NULL,ack_by=NULL WHERE id=?',historical);
    const annex=f.e.saveArea({name:'Annex',entryDelaySec:0,exitDelaySec:0},'tester');
    for(const zone of [f.door,f.motion])f.e.saveZone({id:zone.id,areaIds:[f.area.id,annex.id]},'tester');
    f.normal();f.arm();f.e.command(annex.id,'arm_away',{},'tester');
    f.report('motion',{occupancy:true});
    f.e.command(f.area.id,'acknowledge',{},'original operator');
    f.advance(100);f.report('door',{contact:false});
    f.e.command(annex.id,'disarm',{},'tester');
    const incidents=()=>f.s.all('SELECT * FROM security_incidents ORDER BY id').map(row=>({...row}));
    const events=()=>f.s.all('SELECT * FROM security_events ORDER BY id');
    const retained=()=>({
      areas:f.s.all('SELECT * FROM security_areas ORDER BY id'),
      deliveries:f.s.all('SELECT * FROM security_deliveries ORDER BY id'),
      pushDeliveries:f.s.all('SELECT * FROM security_push_deliveries ORDER BY id')
    });
    const before=incidents(),beforeEvents=events(),beforeRetained=retained();
    const event=f.e.event.bind(f.e);
    f.e.event=(type,message,scope)=>{
      const id=event(type,message,scope);
      if(type==='alarm_acknowledged'&&scope.areaId===annex.id)throw Error('Synthetic acknowledgement audit failure');
      return id;
    };
    assert.throws(()=>f.e.acknowledgeAll('stack operator'),/Synthetic acknowledgement audit failure/);
    assert.deepEqual(incidents(),before);assert.deepEqual(events(),beforeEvents);
    f.e.event=event;
    assert.equal(f.e.acknowledgeAll('stack operator'),3);
    assert.deepEqual(incidents(),before.map(row=>row.reset_at===null&&row.ack_at===null?{...row,ack_at:f.now(),ack_by:'stack operator'}:row));
    assert.deepEqual(retained(),beforeRetained);
    const addedEvents=events().slice(beforeEvents.length);
    assert.equal(addedEvents.length,2);
    assert.deepEqual(new Set(addedEvents.map(row=>row.area_id)),new Set([f.area.id,annex.id]));
    assert.ok(addedEvents.every(row=>row.type==='alarm_acknowledged'&&row.actor==='stack operator'));
    f.advance(100);
    assert.equal(f.e.acknowledgeAll('retry operator'),0);
    assert.deepEqual(events().slice(beforeEvents.length),addedEvents);
  }finally{f.close();}
});

test('Home excludes selected internal zones while Away includes them',()=>{const f=fixture();f.normal();f.report('motion',{occupancy:true});assert.equal(f.e.state().areas[0].readyAway,false);assert.equal(f.e.state().areas[0].readyHome,true);f.arm('home');f.report('motion',{occupancy:false});f.report('motion',{occupancy:true});assert.equal(f.e.activeIncidents().length,0);f.report('door',{contact:false});assert.equal(f.e.activeIncidents().length,1);f.close();});

test('arming cannot declare protection when every enabled zone is bypassed or excluded in Home',()=>{const f=fixture();f.normal();f.e.bypassZone(f.door.id,{durationMin:null,reason:'Fixture bypass'},'operator');f.e.bypassZone(f.motion.id,{durationMin:null,reason:'Fixture bypass'},'operator');assert.equal(f.e.state().areas[0].includedCount,0);assert.equal(f.e.state().areas[0].readyAway,false);assert.throws(()=>f.arm(),/remain protected/);f.e.clearBypass(f.door.id,'operator');f.e.clearBypass(f.motion.id,'operator');f.e.saveZone({id:f.door.id,homeBypass:true},'operator');assert.equal(f.e.state().areas[0].readyHome,false);assert.throws(()=>f.arm('home'),/remain protected/);assert.equal(f.e.state().areas[0].mode,'disarmed');f.close();});

test('reset cannot clear an unacknowledged alarm even after disarm and full sensor restore',()=>{const f=fixture();f.normal();f.arm();f.report('door',{contact:false});f.e.command(f.area.id,'disarm',{},'operator');f.report('door',{contact:true});assert.throws(()=>f.e.command(f.area.id,'reset',{},'operator'),/Acknowledge every alarm/);assert.equal(f.e.activeIncidents().length,1);f.e.command(f.area.id,'acknowledge',{},'operator');f.e.command(f.area.id,'reset',{},'operator');assert.equal(f.e.activeIncidents().length,0);f.close();});

test('exit delay checks readiness again and never arms an open zone',()=>{const f=fixture({exitDelaySec:20});f.normal();f.arm();assert.equal(f.e.state().areas[0].status,'exit_delay');f.advance(1000);f.report('door',{contact:false});f.advance(20000);f.e.tick();assert.equal(f.e.state().areas[0].mode,'disarmed');assert.ok(f.e.state().events.some(event=>event.type==='arm_blocked'));assert.equal(f.e.activeIncidents().length,0);f.close();});

test('entry delay gives time to disarm and an instant zone overrides it',()=>{const f=fixture({entryDelaySec:30});f.normal();f.arm();f.report('door',{contact:false});assert.equal(f.e.state().areas[0].status,'entry_delay');assert.equal(f.e.activeIncidents().length,0);f.advance(1000);f.e.command(f.area.id,'disarm',{},'operator');f.advance(40000);f.e.tick();assert.equal(f.e.activeIncidents().length,0);f.report('door',{contact:true});f.arm();f.report('door',{contact:false});f.report('motion',{occupancy:true});assert.equal(f.e.activeIncidents()[0].zoneId,f.motion.id);assert.equal(f.e.state().areas[0].entryAt,null);f.close();});

test('expired entry delay latches the original activation even when the door has closed',()=>{const f=fixture({entryDelaySec:10});f.normal();f.arm();f.report('door',{contact:false});f.advance(1000);f.report('door',{contact:true});f.advance(10000);f.e.tick();assert.equal(f.e.activeIncidents().length,1);assert.ok(f.e.activeIncidents()[0].restoredAt);assert.equal(f.e.state().areas[0].status,'alarm');f.close();});

test('bypasses require reasons, expire once, and active expiry is not a fabricated activation edge',()=>{const f=fixture();f.normal();assert.throws(()=>f.e.bypassZone(f.door.id,{durationMin:1,reason:''},'operator'),/reason/);f.e.bypassZone(f.door.id,{durationMin:1,reason:'Window cleaning'},'operator');f.arm();f.report('door',{contact:false});f.advance(60001);f.e.tick();assert.equal(f.e.state().zones[0].status,'active');assert.equal(f.e.activeIncidents().length,0);f.report('door',{contact:false});assert.equal(f.e.activeIncidents().length,0);f.report('door',{contact:true});f.report('door',{contact:false});assert.equal(f.e.activeIncidents().length,1);assert.equal(f.e.state().events.filter(event=>event.type==='zone_bypass_expired').length,1);f.close();});

test('indefinite bypass survives restart but never changes the actual sensor state',()=>{const f=fixture();f.normal();f.report('door',{contact:false});f.e.bypassZone(f.door.id,{durationMin:null,reason:'Known contact fault'},'operator');f.restart();assert.equal(f.e.state().zones[0].bypassed,true);assert.equal(f.e.state().zones[0].known,false);f.normal();assert.equal(f.e.state().zones[0].active,false);f.e.clearBypass(f.door.id,'operator');assert.equal(f.e.state().zones[0].bypassed,false);f.close();});

test('network, bridge, retirement, inventory and availability faults show trouble without intrusion',()=>{const f=fixture();f.normal();f.arm();for(const mutate of [()=>{const n=f.s.network('net');n.connected=false;f.s.saveNetwork(n);},()=>{const n=f.s.network('net');n.connected=true;n.bridgeState='offline';f.s.saveNetwork(n);},()=>{const n=f.s.network('net');n.bridgeState='online';f.s.saveNetwork(n);const d=f.s.device('door');d.retiredAt=f.now();f.s.saveDevice(d);},()=>{const d=f.s.device('door');d.retiredAt=null;d.inventoryPresent=false;f.s.saveDevice(d);},()=>{const d=f.s.device('door');d.inventoryPresent=true;d.availability='offline';f.s.saveDevice(d);}]){mutate();f.e.tick();f.report('door',{contact:false});assert.equal(f.e.state().zones[0].status,'trouble');assert.equal(f.e.activeIncidents().length,0);}f.close();});

test('the default detector reading expires after seven days even if other telemetry arrives',()=>{
  const f=fixture();
  f.normal();
  f.arm();
  f.advance(7*24*60*60000);
  assert.equal(f.e.zoneView(f.door).known,true);
  f.advance(1);
  f.report('door',{battery:80});
  const reading=f.e.zoneView(f.door);
  assert.equal(reading.known,false);
  assert.equal(reading.observedValue,null);
  assert.equal(f.e.activeIncidents().length,0);
  f.close();
});

test('legacy zone timeouts yield one conservative value without startup writes and remain stable on removal',()=>{
  const f=fixture();
  try{
    const writeLegacy=(zone,changes)=>f.s.run('UPDATE security_zones SET json=? WHERE id=?',JSON.stringify({...f.e.zone(zone.id),...changes}),zone.id);
    writeLegacy(f.door,{freshnessMin:120});
    writeLegacy(f.motion,{freshnessMin:15,enabled:false});
    const settings=f.s.all('SELECT * FROM settings ORDER BY key'),zones=f.s.all('SELECT * FROM security_zones ORDER BY id');
    f.restart();
    const state=f.e.state();
    assert.equal(state.readingTimeoutMin,15);
    assert.ok(state.zones.every(zone=>zone.freshnessMin===15));
    assert.deepEqual(f.s.all('SELECT * FROM settings ORDER BY key'),settings);
    assert.deepEqual(f.s.all('SELECT * FROM security_zones ORDER BY id'),zones);
    const renamed=f.e.saveZone({id:f.door.id,name:'Renamed contact',freshnessMin:60},'tester');
    assert.equal(renamed.freshnessMin,15);
    assert.equal(f.e.zone(f.door.id).freshnessMin,120);
    assert.throws(()=>f.e.saveZone({id:f.door.id,freshnessMin:0},'tester'),/zone reporting timeout/);
    f.normal();f.advance(15*60000+1);
    assert.equal(f.e.zoneState(f.e.zone(f.door.id)).known,false);
    assert.throws(()=>f.arm(),/not ready/);
    f.e.removeZone(f.motion.id,'tester');
    assert.equal(f.s.get('securityReadingTimeoutMin'),15);
    f.restart();
    assert.equal(f.e.readingTimeoutMin(),15);
  }finally{f.close();}
});

test('global timeout changes are blocked throughout arming and preserve alarm memory after disarm',()=>{
  const f=fixture({entryDelaySec:10,exitDelaySec:5});
  try{
    const save=()=>f.e.saveSettings({readingTimeoutMin:120,expectedReadingTimeoutMin:10080},'tester');
    const rejected=()=>{
      assert.equal(f.e.state().canChangeReadingTimeout,false);
      assert.throws(save,/Disarm every area/);
      assert.equal(f.s.get('securityReadingTimeoutMin'),null);
      assert.ok(!f.e.state().events.some(event=>event.type==='reading_timeout_updated'));
    };
    f.normal();f.arm();rejected();
    f.advance(5000);f.e.tick();rejected();
    f.report('door',{contact:false});rejected();
    f.report('motion',{occupancy:true});rejected();
    f.e.command(f.area.id,'disarm',{},'tester');
    const memory=f.e.activeIncidents();
    assert.equal(memory.length,1);
    assert.equal(f.e.state().canChangeReadingTimeout,true);
    assert.deepEqual(save(),{readingTimeoutMin:120});
    assert.equal(f.e.state().readingTimeoutMin,120);
    assert.ok(f.e.state().zones.every(zone=>zone.freshnessMin===120));
    assert.deepEqual(f.e.activeIncidents(),memory);
    assert.equal(f.e.state().events.find(event=>event.type==='reading_timeout_updated').actor,'tester');
  }finally{f.close();}
});

test('explicit invalid or mismatched detector values become unknown rather than a healthy false reading',()=>{const f=fixture();for(const value of [null,'unknown',{},[]]){f.normal();f.report('door',{contact:value});const zone=f.e.state().zones.find(zone=>zone.id===f.door.id);assert.equal(zone.known,false);assert.equal(zone.status,'unknown');assert.equal(zone.active,null);assert.throws(()=>f.arm(),/not ready/);}f.close();});

test('stable armed mode survives restart, retained cached values do nothing, first fresh activation is detected',()=>{const f=fixture();f.normal();f.action();f.arm();f.restart();assert.equal(f.e.state().areas[0].mode,'away');assert.equal(f.e.state().zones[0].known,false);assert.equal(f.e.queuedActions().length,0);f.report('door',{contact:false},{retain:true});assert.equal(f.e.activeIncidents().length,0);f.report('door',{contact:false},{dup:true});assert.equal(f.e.activeIncidents().length,0);f.advance(100);f.report('door',{contact:false});assert.equal(f.e.activeIncidents().length,1);assert.equal(f.e.queuedActions().length,1);f.close();});

test('reconnect keeps area armed and only a genuinely fresh active report causes an intrusion',()=>{const f=fixture();f.normal();f.arm();const n=f.s.network('net');n.connected=false;f.s.saveNetwork(n);f.report('door',{contact:false});assert.equal(f.e.activeIncidents().length,0);f.advance(1000);n.connected=true;n.connectedAt=f.now();f.s.saveNetwork(n);assert.equal(f.e.state().zones[0].known,false);f.report('door',{contact:false},{retain:true});assert.equal(f.e.activeIncidents().length,0);f.report('door',{contact:false});assert.equal(f.e.activeIncidents().length,1);f.close();});

test('restart during exit cancels pending arming, but restart during entry retains a no-output alarm latch',()=>{const f=fixture({entryDelaySec:20,exitDelaySec:10});f.normal();f.action();f.arm();f.restart();assert.equal(f.e.state().areas[0].mode,'disarmed');assert.equal(f.e.state().areas[0].targetMode,null);f.normal();f.arm();f.advance(11000);f.e.tick();f.report('door',{contact:false});assert.ok(f.e.state().areas[0].entryAt);f.restart();assert.equal(f.e.state().areas[0].mode,'away');assert.equal(f.e.activeIncidents().length,1);assert.equal(f.e.queuedActions().length,0);assert.ok(f.e.state().events.some(event=>event.type==='restart_entry_latched'));f.close();});

test('active incident and last live active baseline persist without another output after restart',()=>{const f=fixture();f.normal();f.action();f.arm();f.report('door',{contact:false});const id=f.e.activeIncidents()[0].id;assert.equal(f.e.queuedActions().length,1);f.restart();assert.equal(f.e.activeIncidents()[0].id,id);assert.equal(f.e.queuedActions().length,0);assert.equal(f.e.state().deliveries[0].status,'suppressed');f.report('door',{contact:false});assert.equal(f.e.activeIncidents().length,1);assert.equal(f.e.queuedActions().length,0);f.close();});

test('MQTT and email outputs are claimed durably, accepted once, and unknown outcomes never retry',async()=>{const f=fixture();f.s.set('email',{enabled:true});f.normal();f.action();f.action('email');f.arm();f.report('door',{contact:false});const sent=[];await f.e.deliver(async(action,context)=>{assert.equal(f.e.state().deliveries.find(d=>d.kind===action.kind).status,'delivering');sent.push({action,context});if(action.kind==='mqtt')throw Error('unknown outcome');});await f.e.deliver(async()=>assert.fail('Must never retry'));assert.equal(sent.length,2);assert.equal(sent[0].context.area,'Home');assert.ok(f.e.state().deliveries.some(d=>d.status==='uncertain'));assert.ok(f.e.state().deliveries.some(d=>d.status==='accepted'));f.close();});

test('disarming after an intrusion still sends its alert once; simulated intrusions never send real actions',async()=>{const f=fixture();f.normal();f.action();f.arm();f.report('door',{contact:false});f.e.command(f.area.id,'disarm',{},'operator');let sends=0;await f.e.deliver(async()=>sends++);assert.equal(sends,1);assert.equal(f.e.state().deliveries[0].status,'accepted');await f.e.deliver(async()=>assert.fail('Must send only once'));f.close();const demo=fixture({demo:true});demo.normal();demo.action();demo.arm();demo.report('door',{contact:false});assert.equal(demo.e.activeIncidents().length,1);assert.equal(demo.e.queuedActions().length,0);await demo.e.deliver(async()=>assert.fail('Simulation must not send'));demo.close();});

test('a service restart records in-flight output as uncertain without replay',()=>{const f=fixture();f.normal();f.action();f.arm();f.report('door',{contact:false});const job=f.e.claimAction(f.e.queuedActions()[0].id);assert.equal(job.status,'delivering');f.restart();assert.equal(f.e.state().deliveries[0].status,'uncertain');assert.equal(f.e.queuedActions().length,0);f.close();});

test('armed configuration cannot be changed and devices retain stable identity after rename',()=>{const f=fixture();f.normal();f.arm();assert.throws(()=>f.e.saveArea({id:f.area.id,name:'Changed'},'operator'),/Disarm/);assert.throws(()=>f.e.saveZone({id:f.door.id,name:'Changed'},'operator'),/Disarm/);assert.throws(()=>f.e.removeZone(f.door.id,'operator'),/Disarm/);const d=f.s.device('door');d.name='Renamed entrance';f.s.saveDevice(d);assert.equal(f.e.state().zones[0].deviceId,'door');assert.equal(f.e.state().zones[0].deviceName,'Renamed entrance');f.close();});

test('configuration validates primitive types, unsafe properties, operators, days, topics and templates',()=>{const f=fixture();for(const field of ['constructor','__proto__','contact.__proto__','password','pin','action_code'])assert.throws(()=>f.e.saveZone({areaId:f.area.id,deviceId:'door',property:field,value:true},'operator'));for(const body of [{entryDelaySec:true},{exitDelaySec:-1},{enabled:'true'},{unexpected:1}])assert.throws(()=>f.e.saveArea({name:'Invalid',...body},'operator'));assert.throws(()=>f.e.saveZone({areaId:f.area.id,deviceId:'door',property:'state',operator:'gt',value:'ON'},'operator'));for(const topic of ['example/#','example/+','$SYS/topic','space here','','/example','example/','zigbee2mqtt/door/set','zigbee2mqtt/bridge/request/permit_join'])assert.throws(()=>f.e.saveAction({areaId:f.area.id,name:'Bad',kind:'mqtt',networkId:'net',topic},'operator'));assert.throws(()=>f.e.saveAction({areaId:f.area.id,kind:'mqtt',networkId:'net',topic:'safe',payloadTemplate:'{"secret":"{{password}}"}'},'operator'));assert.throws(()=>f.e.saveSchedule({areaId:f.area.id,time:'25:00'},'operator'));assert.throws(()=>f.e.saveSchedule({areaId:f.area.id,time:'12:00',days:[1,1]},'operator'));assert.throws(()=>f.e.saveSchedule({areaId:f.area.id,time:'12:00',timezone:'Not/AZone'},'operator'));f.close();});

test('cached identifiable last_seen samples and credential-like device fields are not used or disclosed',()=>{const f=fixture();f.normal();f.arm();f.advance(100);f.report('door',{contact:false,last_seen:f.now()-120000});assert.equal(f.e.activeIncidents().length,0);f.report('door',{contact:true,pin:1234,action_code:'private',password:'private',occupancy:false});assert.equal(JSON.stringify(f.e.state()).includes('private'),false);assert.equal(f.e.state().devices.find(d=>d.id==='door').properties.some(p=>p.property==='pin'),false);f.close();});

test('missing timestamps use receipt freshness but explicitly invalid timestamps cannot establish it',()=>{const f=fixture();for(const last_seen of [null,{},[],true,'not-a-date',Infinity])f.report('door',{contact:true,last_seen});assert.equal(f.e.state().zones[0].known,false);assert.equal(f.s.all('SELECT * FROM security_readings').length,0);f.normal();f.arm();for(const last_seen of [null,'invalid',Infinity])f.report('door',{contact:false,last_seen});assert.equal(f.e.activeIncidents().length,0);f.report('door',{contact:false});assert.equal(f.e.activeIncidents().length,1);f.close();});

test('deep, nonfinite or oversized MQTT templates fail before an action is saved',()=>{const f=fixture();let nested={};for(let i=0;i<10;i++)nested={n:nested};for(const payloadTemplate of [JSON.stringify(nested),JSON.stringify({text:'x'.repeat(8200)}),JSON.stringify({items:Array.from({length:513},()=>1)}),'{"__proto__":{"polluted":true}}','{"overflow":1e999}'])assert.throws(()=>f.e.saveAction({areaId:f.area.id,kind:'mqtt',networkId:'net',topic:'example/security',payloadTemplate},'operator'));assert.equal(f.e.actions().length,0);f.close();});

test('expired queued alerts are retained as suppressed and never sent late',async()=>{const f=fixture();f.normal();f.action();f.arm();f.report('door',{contact:false});f.advance(5*60000+1);await f.e.deliver(async()=>assert.fail('Expired output must not send'));assert.equal(f.e.state().deliveries[0].status,'suppressed');assert.match(f.e.state().deliveries[0].error,/expired/);f.close();});

test('property maps are bounded across arbitrary frames while configured detector baselines survive',()=>{const f=fixture();f.normal();for(let frame=0;frame<30;frame++){f.advance(100);f.report('door',Object.fromEntries(Array.from({length:64},(_,i)=>['field'+(frame*64+i),i])));}const state=f.e.state(),properties=state.devices.find(d=>d.id==='door').properties,persisted=JSON.parse(f.s.one('SELECT json FROM security_readings WHERE device_id=?','door').json);assert.ok(properties.length<=128);assert.ok(persisted.values.length<=128);assert.equal(properties.find(p=>p.property==='contact').value,true);assert.equal(persisted.values.find(([p])=>p==='contact')[1].value,true);assert.equal(state.zones.find(z=>z.id===f.door.id).status,'normal');f.close();});

test('oversized previous property history is ignored safely and replaced with a bounded fresh record',()=>{const f=fixture();f.s.run('INSERT INTO security_readings VALUES(?,?)','door',JSON.stringify({values:Array.from({length:4000},(_,i)=>['field'+i,{value:'x'.repeat(200),at:f.now()}])}));f.report('door',{contact:true});const row=f.s.one('SELECT json FROM security_readings WHERE device_id=?','door');assert.ok(row.json.length<100000);assert.equal(JSON.parse(row.json).values.length,1);f.close();});

test('schedules do not run on startup or after a time gap, and run once on an observed minute edge',()=>{const f=fixture({time:Date.UTC(2026,10,8,0,0,5)});f.normal();const schedule=f.e.saveSchedule({areaId:f.area.id,name:'Away minute',days:[0],time:'00:01',timezone:'UTC',mode:'away',enabled:true},'operator');f.e.tick();assert.equal(f.e.state().areas[0].mode,'disarmed');tickFor(f,55000);assert.equal(f.e.state().areas[0].mode,'away');f.e.tick();assert.equal(f.e.state().events.filter(e=>e.type==='schedule_executed').length,1);assert.equal(f.e.schedules().find(s=>s.id===schedule.id).lastRunKey,'2026-11-08T00:01');f.e.command(f.area.id,'disarm',{},'operator');f.e.saveSchedule({id:schedule.id,time:'00:11'},'operator');f.advance(10*60000);f.e.tick();assert.equal(f.e.state().areas[0].mode,'disarmed');f.restart();f.normal();f.e.tick();assert.equal(f.e.state().areas[0].mode,'disarmed');f.close();});

test('blocked scheduled arming is recorded once rather than forcing unhealthy zones',()=>{const f=fixture({time:Date.UTC(2026,10,8,0,0,5)});f.e.saveSchedule({areaId:f.area.id,time:'00:01',days:[0],mode:'away',enabled:true},'operator');tickFor(f,55000);f.e.tick();assert.equal(f.e.state().areas[0].mode,'disarmed');assert.equal(f.e.state().events.filter(e=>e.type==='schedule_blocked').length,1);f.close();});

test('Sydney DST repeated wall-clock minutes execute a schedule once',()=>{const start=Date.UTC(2027,3,3,15,29,5),f=fixture({time:start});f.normal();f.e.saveSchedule({areaId:f.area.id,name:'DST wall minute',time:'02:30',days:[0],timezone:'Australia/Sydney',mode:'away',enabled:true},'operator');tickFor(f,55000);assert.equal(f.e.state().areas[0].mode,'away');f.e.command(f.area.id,'disarm',{},'operator');tickFor(f,60*60000);assert.equal(f.e.state().areas[0].mode,'disarmed');assert.equal(f.e.state().events.filter(e=>e.type==='schedule_executed').length,1);f.close();});

test('a stall or backward clock change does not catch up an arm schedule inside its minute',()=>{const f=fixture({time:Date.UTC(2026,10,8,0,0,1)});f.normal();f.e.saveSchedule({areaId:f.area.id,time:'00:01',days:[0],mode:'away',enabled:true},'operator');f.advance(118000);f.e.tick();assert.equal(f.e.state().areas[0].mode,'disarmed');assert.equal(f.e.state().events.filter(e=>e.type==='schedule_executed').length,0);f.setTime(Date.UTC(2026,10,8,0,0,59));f.e.tick();f.advance(1000);f.e.tick();assert.equal(f.e.state().areas[0].mode,'away');f.close();});

test('history pruning keeps active alarms, related events, bypasses and all configuration',()=>{const f=fixture();f.normal();f.action();f.arm();f.report('door',{contact:false});const active=f.e.activeIncidents()[0];f.e.bypassZone(f.motion.id,{durationMin:null,reason:'Renovation'},'operator');f.advance(100*86400000);f.e.prune();assert.equal(f.e.activeIncidents()[0].id,active.id);assert.ok(f.e.state().events.some(e=>e.incidentId===active.id));assert.equal(f.e.areas().length,1);assert.equal(f.e.actions().length,1);assert.equal(f.e.zone(f.motion.id).bypassUntil,null);assert.ok(f.e.zone(f.motion.id).bypassAt);f.close();});
