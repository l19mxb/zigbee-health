import {randomUUID} from 'node:crypto';

const reasonText = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 300) throw Error('A reason of 1–300 characters is required');
  return value.trim();
};

// These operations change the local registry only. They never unpair Zigbee devices.
export class DeviceLifecycle {
  requireDevice(id) {
    const d = this.s.device(id);
    if (!d) throw Error('Device not found');
    return d;
  }
  retireDevice({id, reason}, actor) {
    const d = this.requireDevice(id), note = reasonText(reason);
    if (d.retiredAt) throw Error('Device is already retired');
    const now = this.now();
    this.s.transaction(() => {
      this.s.saveDevice({...d, retiredAt: now, retiredBy: actor, retirementReason: note});
      this.s.run("UPDATE incidents SET resolution=CASE WHEN restored_at IS NULL THEN 'retired' ELSE resolution END, restored_at=coalesce(restored_at,?), processed_at=? WHERE device_id=? AND processed_at IS NULL", now, now, id);
      this.s.run("UPDATE outbox SET status='suppressed',finished_at=? WHERE status='queued' AND incident_id IN (SELECT id FROM incidents WHERE device_id=?)", now, id);
      this.s.run("UPDATE push_outbox SET status='suppressed',finished_at=? WHERE status='queued' AND incident_id IN (SELECT id FROM incidents WHERE device_id=?)",now,id);
      this.s.run('DELETE FROM conditions WHERE scope=?', id);
      this.s.run("UPDATE shunts SET cancelled_at=? WHERE scope_type='device' AND scope_id=? AND cancelled_at IS NULL AND expired_at IS NULL", now, id);
      this.s.event('device_retired', note, {deviceId:id, networkId:d.networkId, actor, at:now});
    });
  }
  restoreDevice({id, reason}, actor) {
    const d = this.requireDevice(id), note = reasonText(reason);
    if (!d.retiredAt) throw Error('Device is not retired');
    this.s.transaction(() => {
      this.s.saveDevice({...d, retiredAt:null, retiredBy:null, retirementReason:null, monitoringSince:this.now(), lastLiveAt:null, lastReceivedAt:null, cachedAt:null, battery:null, lqi:null, availability:'unknown', availabilityAt:null, availabilityRetained:false});
      this.s.run('DELETE FROM conditions WHERE scope=?', id);
      this.s.event('device_restored', note, {deviceId:id, networkId:d.networkId, actor, at:this.now()});
    });
  }
  historyCounts(id) {
    this.requireDevice(id);
    return Object.fromEntries(['samples','incidents','events','shunts'].map(table => [table, this.s.one(table==='shunts'?"SELECT count(*) n FROM shunts WHERE scope_type='device' AND scope_id=?":`SELECT count(*) n FROM ${table} WHERE device_id=?`,id).n]));
  }
  deleteDeviceHistory({id, confirmName, confirmation, reason}, actor) {
    const d = this.requireDevice(id), note = reasonText(reason);
    if (!d.retiredAt) throw Error('Retire the device before deleting its history');
    if (confirmName !== d.name || confirmation !== 'DELETE HISTORY') throw Error('Confirm the current device name and DELETE HISTORY');
    if (this.s.one("SELECT id FROM outbox WHERE status='delivering' AND incident_id IN (SELECT id FROM incidents WHERE device_id=?)",id)) throw Error('Wait for the in-progress email attempt before deleting history');
    const counts = this.historyCounts(id);
    this.s.transaction(() => {
      this.s.run('DELETE FROM push_outbox WHERE incident_id IN (SELECT id FROM incidents WHERE device_id=?)',id);
      this.s.run('DELETE FROM outbox WHERE incident_id IN (SELECT id FROM incidents WHERE device_id=?)',id);
      for (const table of ['samples','incidents','events']) this.s.run(`DELETE FROM ${table} WHERE device_id=?`,id);
      this.s.run("DELETE FROM shunts WHERE scope_type='device' AND scope_id=?",id);
      this.s.run('DELETE FROM conditions WHERE scope=?',id);
      this.s.saveDevice({...d, historyDeletedAt:this.now(), lastLiveAt:null, lastReceivedAt:null, cachedAt:null, battery:null, lqi:null, availability:'unknown', availabilityAt:null});
      this.s.event('history_deleted',note,{deviceId:id,networkId:d.networkId,actor,at:this.now()});
    });
    return counts;
  }
  linkDevice({sourceId, targetId, kind, reason}, actor) {
    const source=this.requireDevice(sourceId), target=this.requireDevice(targetId), note=reasonText(reason);
    if (sourceId===targetId) throw Error('Choose two different records');
    if (!source.retiredAt) throw Error('Retire the previous record before linking it');
    if (!['moved','replacement'].includes(kind)) throw Error('Choose moved device or replacement hardware');
    if (kind==='moved' && source.ieee!==target.ieee) throw Error('Moved records must have the same Zigbee address');
    if (kind==='replacement' && source.ieee===target.ieee) throw Error('Use moved device for records with the same Zigbee address');
    if (this.s.one('SELECT id FROM device_links WHERE source_id=?',sourceId)) throw Error('The previous record already has a successor; remove that link first');
    const visited=new Set([sourceId]);
    for (let id=targetId; id;) {
      if (visited.has(id)) throw Error('Record links cannot form a cycle');
      visited.add(id); id=this.s.one('SELECT target_id FROM device_links WHERE source_id=?',id)?.target_id;
    }
    const link={id:randomUUID(),source_id:sourceId,target_id:targetId,kind,reason:note,actor,created_at:this.now()};
    this.s.transaction(()=>{
      this.s.run('INSERT INTO device_links VALUES(?,?,?,?,?,?,?)',link.id,sourceId,targetId,kind,note,actor,link.created_at);
      for (const d of [source,target]) this.s.event('records_linked',`${kind==='moved'?'Moved device':'Replacement hardware'}: ${source.name} → ${target.name}. ${note}`,{deviceId:d.id,networkId:d.networkId,actor,at:this.now()});
    });
    return link;
  }
  unlinkDevice({id,reason}, actor) {
    const link=this.s.one('SELECT * FROM device_links WHERE id=?',id), note=reasonText(reason);
    if (!link) throw Error('Record link not found');
    this.s.transaction(()=>{
      this.s.run('DELETE FROM device_links WHERE id=?',id);
      for (const deviceId of [link.source_id,link.target_id]) this.s.event('records_unlinked',note,{deviceId,networkId:this.s.device(deviceId)?.networkId,actor,at:this.now()});
    });
  }
  linksFor(id) {
    return this.s.all('SELECT * FROM device_links WHERE source_id=? OR target_id=? ORDER BY created_at',id,id).map(link=>({...link,device:this.s.device(link.source_id===id?link.target_id:link.source_id)}));
  }
}
