import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store,defaults} from '../server/store.mjs';
import {Engine,deviceId} from '../server/engine.mjs';

const address='0x0000000000000001',actor='Test operator';
function fixture(){
  let now=1800000000000;
  const s=new Store(),e=new Engine(s,{clock:()=>now,timezone:'UTC'});
  s.set('thresholds',{...defaults,faultDelaySec:0,recoveryDelaySec:0});
  const inventory=(net='a',ieee=address,name='Sensor')=>{
    if(!s.network(net))s.saveNetwork({id:net,label:'Network '+net,enabled:true,connected:true,connectedAt:now-1000,bridgeState:'online',baseTopic:'zigbee2mqtt'});
    e.ingest(net,'zigbee2mqtt/bridge/devices',[{ieee_address:ieee,friendly_name:name,type:'EndDevice',power_source:'Battery'}]);
    return deviceId(net,ieee);
  };
  const id=inventory(),state=(net='a',name='Sensor')=>e.ingest(net,'zigbee2mqtt/'+name,{battery:10,linkquality:40});
  return {s,e,id,inventory,state,advance:ms=>now+=ms};
}
test('retirement closes working alarms as retired, suppresses queued mail and cancels shunts atomically',async()=>{
  const f=fixture();try{
    f.s.set('email',{enabled:true,recovery:true});f.state();f.e.tick();
    f.e.shunt({scopeType:'device',scopeId:f.id,reason:'Maintenance'},actor);
    assert.ok(f.e.snapshot().alarms.length);f.e.retireDevice({id:f.id,reason:'Discarded'},actor);
    assert.equal(f.e.snapshot().alarms.length,0);assert.equal(f.e.shunts().length,0);
    assert.equal(f.e.snapshot().devices[0].status,'retired');
    assert.ok(f.s.all('SELECT * FROM incidents').every(i=>i.resolution==='retired'&&i.processed_at));
    let emails=0;await f.e.deliver(async()=>emails++);f.e.tick();await f.e.deliver(async()=>emails++);
    assert.equal(emails,0);assert.ok(f.s.all('SELECT * FROM outbox').every(i=>i.status==='suppressed'));
    assert.throws(()=>f.e.shunt({scopeType:'device',scopeId:f.id,reason:'No'},actor),/Retired/);
  }finally{f.s.close();}
});
test('retired identity survives rediscovery and rename without collecting reports or new alarms',()=>{
  const f=fixture();try{
    f.state();f.e.tick();const count=f.s.one('SELECT sum(report_count) n FROM samples').n;
    f.e.retireDevice({id:f.id,reason:'Removed'},actor);f.advance(100000);
    f.inventory('a',address,'Renamed');f.state('a','Renamed');f.e.ingest('a','zigbee2mqtt/Renamed/availability',{state:'offline'});f.e.tick();
    assert.equal(f.s.devices().length,1);assert.equal(f.s.device(f.id).name,'Renamed');
    assert.equal(f.e.snapshot().devices[0].status,'retired');assert.equal(f.e.snapshot().alarms.length,0);
    assert.equal(f.s.one('SELECT sum(report_count) n FROM samples').n,count);
  }finally{f.s.close();}
});
test('restore preserves history and overrides but requires a fresh live measurement',()=>{
  const f=fixture();try{
    const d=f.s.device(f.id);d.overrides={lowBattery:12};d.room='Test room';f.s.saveDevice(d);f.state();f.e.tick();
    f.e.retireDevice({id:f.id,reason:'Stored'},actor);f.advance(1000);f.e.restoreDevice({id:f.id,reason:'Reinstalled'},actor);f.e.tick();
    let d2=f.e.snapshot().devices[0];assert.equal(d2.status,'unknown');assert.equal(d2.battery,null);assert.equal(d2.room,'Test room');assert.equal(d2.overrides.lowBattery,12);assert.equal(f.e.snapshot().alarms.length,0);
    f.e.ingest('a','zigbee2mqtt/Sensor',{battery:90,linkquality:200},{retain:true});f.e.tick();assert.equal(f.e.snapshot().devices[0].status,'unknown');
    f.e.ingest('a','zigbee2mqtt/Sensor',{battery:90,linkquality:200});f.e.tick();assert.equal(f.e.snapshot().devices[0].status,'healthy');assert.ok(f.e.report(f.id).samples.length);
  }finally{f.s.close();}
});
test('history deletion is confirmed server-side and scoped to a retired record, retaining tombstone and links',()=>{
  const f=fixture();try{
    f.state();f.e.tick();const other=f.inventory('b');f.state('b');f.e.tick();
    const request={id:f.id,reason:'Erase old history',confirmName:'Sensor',confirmation:'DELETE HISTORY'};
    assert.throws(()=>f.e.deleteDeviceHistory(request,actor),/Retire/);
    f.e.retireDevice({id:f.id,reason:'Moved'},actor);
    f.e.linkDevice({sourceId:f.id,targetId:other,kind:'moved',reason:'Coordinator migration'},actor);
    assert.throws(()=>f.e.deleteDeviceHistory({...request,confirmName:'Wrong'},actor),/Confirm/);
    const counts=f.e.deleteDeviceHistory(request,actor);assert.ok(counts.samples>0);
    assert.equal(f.e.report(f.id).samples.length,0);assert.equal(f.e.report(f.id).incidents.length,0);
    assert.equal(f.s.all('SELECT * FROM outbox WHERE incident_id NOT IN (SELECT id FROM incidents)').length,0);
    assert.ok(f.e.report(other).samples.length);assert.equal(f.e.report(other).links.length,1);
    assert.ok(f.s.device(f.id).retiredAt);assert.ok(f.s.device(f.id).historyDeletedAt);
    assert.equal(f.s.all('SELECT * FROM events WHERE device_id=?',f.id).length,1);
    f.inventory();f.state();f.e.tick();assert.equal(f.e.report(f.id).samples.length,0);assert.equal(f.e.snapshot().devices.find(d=>d.id===f.id).status,'retired');
  }finally{f.s.close();}
});
test('moved links require matching addresses, replacements require different hardware, and histories stay separate',()=>{
  const f=fixture();try{
    f.state();const b=f.inventory('b'),c=f.inventory('c','0x0000000000000002','Replacement');f.state('b');
    assert.throws(()=>f.e.linkDevice({sourceId:f.id,targetId:b,kind:'moved',reason:'Move'},actor),/Retire/);
    f.e.retireDevice({id:f.id,reason:'Move'},actor);
    assert.throws(()=>f.e.linkDevice({sourceId:f.id,targetId:c,kind:'moved',reason:'Move'},actor),/same Zigbee/);
    assert.throws(()=>f.e.linkDevice({sourceId:f.id,targetId:b,kind:'replacement',reason:'Swap'},actor),/Use moved/);
    const link=f.e.linkDevice({sourceId:f.id,targetId:b,kind:'moved',reason:'Move'},actor);
    assert.equal(f.e.report(b).links[0].device.id,f.id);assert.equal(f.e.report(b).samples.length,1);assert.equal(f.e.report(f.id).samples.length,1);
    assert.throws(()=>f.e.linkDevice({sourceId:f.id,targetId:c,kind:'replacement',reason:'Swap'},actor),/successor/);
    f.e.unlinkDevice({id:link.id,reason:'Correct relationship'},actor);
    f.e.linkDevice({sourceId:f.id,targetId:c,kind:'replacement',reason:'Hardware replaced'},actor);
    assert.equal(f.e.report(c).samples.length,0);assert.equal(f.e.report(c).links[0].kind,'replacement');
  }finally{f.s.close();}
});
test('links reject cycles and invalid requests without partial writes',()=>{
  const f=fixture();try{
    const b=f.inventory('b');f.e.retireDevice({id:f.id,reason:'Move'},actor);f.e.retireDevice({id:b,reason:'Move'},actor);
    f.e.linkDevice({sourceId:f.id,targetId:b,kind:'moved',reason:'Move'},actor);
    assert.throws(()=>f.e.linkDevice({sourceId:b,targetId:f.id,kind:'moved',reason:'Cycle'},actor),/cycle/);
    assert.throws(()=>f.e.restoreDevice({id:f.id,reason:''},actor),/reason/);
    assert.equal(f.s.all('SELECT * FROM device_links').length,1);assert.ok(f.s.device(f.id).retiredAt);
    f.advance(100*86400000);f.e.prune();assert.equal(f.s.all('SELECT * FROM device_links').length,1);assert.ok(f.s.device(f.id).retiredAt);
  }finally{f.s.close();}
});
test('v0.1 incident schema migrates safely and retired state/links survive reopen',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zigbee-lifecycle-')),file=path.join(dir,'health.db');
  try{
    const db=new DatabaseSync(file);db.exec('CREATE TABLE incidents(id TEXT PRIMARY KEY,device_id TEXT,network_id TEXT NOT NULL,category TEXT NOT NULL,priority TEXT NOT NULL,opened_at INTEGER NOT NULL,restored_at INTEGER,ack_at INTEGER,ack_by TEXT,processed_at INTEGER,rearm INTEGER NOT NULL DEFAULT 0,description TEXT NOT NULL)');db.close();
    let s=new Store(file),e=new Engine(s);const f=fixture(),successor=f.inventory('b');
    for(const n of f.s.networks())s.saveNetwork(n);for(const d of f.s.devices())s.saveDevice(d);f.s.close();
    e.retireDevice({id:f.id,reason:'Archived'},actor);e.linkDevice({sourceId:f.id,targetId:successor,kind:'moved',reason:'Moved network'},actor);
    s.close();s=new Store(file);e=new Engine(s);
    assert.equal(e.snapshot().devices.find(d=>d.id===f.id).status,'retired');assert.equal(e.report(successor).links[0].device.id,f.id);
    assert.equal(s.all('PRAGMA table_info(incidents)').filter(c=>c.name==='resolution').length,1);s.close();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
