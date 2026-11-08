import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {SecurityEngine} from '../server/security.mjs';
import {createBackup} from '../server/backup.mjs';
import {seedDemo} from '../server/demo.mjs';
import {seedSecurityDemo,pulseSecurityDemo} from '../server/security-demo.mjs';

test('a complete backup restores armed security configuration, alarm memory and its key without replaying queued alerts',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'zigbee-security-backup-'));
  const source=path.join(folder,'source','health.db'),target=path.join(folder,'backup');
  let original,restored;
  try{
    let now=Date.now();original=new Store(source);
    original.saveNetwork({id:'backup-network',label:'Backup fixture',mode:'zigbee2mqtt',baseTopic:'zigbee2mqtt',host:'broker.example.test',port:1883,protocol:'mqtt',enabled:true,connected:true,connectedAt:now-1000,bridgeState:'online',username:'fixture-user',password:original.seal('synthetic-broker-secret')});
    const health=new Engine(original,{clock:()=>now});
    health.ingest('backup-network','zigbee2mqtt/bridge/devices',[{ieee_address:'0x00124b0000000001',friendly_name:'Fixture contact',type:'EndDevice',power_source:'Battery'}]);
    const security=new SecurityEngine(original,{clock:()=>now}),device=original.devices()[0];
    const area=security.saveArea({name:'Fixture area',entryDelaySec:0,exitDelaySec:0},'Fixture');
    const zone=security.saveZone({name:'Fixture zone',areaId:area.id,deviceId:device.id,property:'contact',value:false,type:'instant'},'Fixture');
    const action=security.saveAction({name:'Fixture MQTT alert',areaId:area.id,kind:'mqtt',networkId:'backup-network',topic:'security/alerts',enabled:true},'Fixture');
    security.ingest(device.id,{contact:true});security.command(area.id,'arm_away',{},'Fixture');
    now+=1000;security.ingest(device.id,{contact:false});
    assert.equal(security.state().incidents.length,1);assert.equal(security.queuedActions().length,1);
    const receipt=await createBackup(source,target);assert.equal(receipt.integrity,'ok');
    restored=new Store(path.join(target,'health.db'));
    const after=new SecurityEngine(restored,{clock:()=>now+1000});
    assert.deepEqual(after.area(area.id),security.area(area.id));
    assert.deepEqual(after.zone(zone.id),security.zone(zone.id));
    assert.deepEqual(after.action(action.id),security.action(action.id));
    assert.equal(after.state().incidents.length,1);assert.equal(after.state().incidents[0].resetAt,null);
    assert.equal(after.queuedActions().length,0);
    assert.equal(restored.one('SELECT status FROM security_deliveries').status,'suppressed');
    assert.equal(after.state().zones[0].active,null);
    assert.equal(restored.unseal(restored.network('backup-network').password),'synthetic-broker-secret');
  }finally{
    restored?.close();original?.close();
    const resolved=fs.realpathSync(folder),parent=fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('zigbee-security-backup-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});

test('the residential demonstration is isolated from live workspaces and never enables outputs or schedules',()=>{
  const live=new Store(),simulated=new Store();
  try{
    const liveHealth=new Engine(live),liveSecurity=new SecurityEngine(live);
    assert.throws(()=>seedSecurityDemo(liveHealth,liveSecurity),/requires simulation/);
    assert.equal(liveSecurity.state().areas.length,0);
    const health=new Engine(simulated,{demo:true}),security=new SecurityEngine(simulated,{demo:true});
    seedDemo(health);seedSecurityDemo(health,security);pulseSecurityDemo(health,security);
    const state=security.state(),house=state.areas.find(area=>area.name==='House');
    assert.equal(state.areas.length,3);assert.equal(state.zones.length,8);
    assert.equal(house.mode,'disarmed');assert.equal(house.readyAway,true);
    assert.equal(state.areas.find(area=>area.name==='Garage').mode,'away');
    assert.ok(state.actions.length===2&&state.actions.every(action=>action.enabled===false));
    assert.ok(state.schedules.length===2&&state.schedules.every(schedule=>schedule.enabled===false));
    assert.equal(security.queuedActions().length,0);
    seedSecurityDemo(health,security);assert.equal(security.state().areas.length,3);
  }finally{live.close();simulated.close();}
});
