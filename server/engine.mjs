import crypto from 'node:crypto';
import {DeviceLifecycle} from './lifecycle.mjs';
import {defaults} from './store.mjs';

const HOUR=3600000,DAY=24*HOUR;
export const labels={offline:'Offline',stale:'Stale reading',battery:'Low battery',signal:'Weak signal',flapping:'Repeated dropouts',missing:'Missing from inventory',broker:'Broker unavailable',bridge:'Bridge unavailable'};
export const uid=()=>crypto.randomUUID();
export const deviceId=(network,ieee)=>network+':'+ieee.toLowerCase();
const numeric=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max?v:null;
export class Engine extends DeviceLifecycle {
  constructor(store,{clock=()=>Date.now(),demo=false,timezone=process.env.TZ||'UTC'}={}){super();new Intl.DateTimeFormat('en-GB',{timeZone:timezone});this.timezone=timezone;this.s=store;this.clock=clock;this.demo=demo;this.lastPrune=0;}
  now(){return this.clock();}
  thresholds(d){return {...defaults,...this.s.get('thresholds'),...d?.overrides};}
  sourceStatus(n){if(!n.enabled)return 'disabled';if(!n.connected)return this.now()-(n.attemptAt||this.now())<this.thresholds().faultDelaySec*1000?'connecting':'offline';return n.bridgeState==='online'?'online':n.bridgeState==='offline'?'offline':'unknown';}
  connection(id,connected,error=null){const n=this.s.network(id);if(!n)return;const was=n.connected;n.connected=connected;n.error=error;n.attemptAt=n.attemptAt||this.now();if(connected){n.connectedAt=this.now();n.bridgeState='unknown';n.bridgeAt=null;}this.s.saveNetwork(n);if(was!==connected)this.s.event(connected?'broker_connected':'broker_disconnected',connected?'MQTT connection established':'MQTT connection unavailable',{networkId:id,at:this.now()});}
  ingest(networkId,topic,payload,{retain=false}={}){
    const n=this.s.network(networkId);if(!n)return;
    const base=n.baseTopic+'/',name=topic.startsWith(base)?topic.slice(base.length):null;if(name===null)return;
    let p;try{p=typeof payload==='string'?JSON.parse(payload):payload;}catch{return;}
    const now=this.now();n.receivedAt=now;this.s.saveNetwork(n);
    if(name==='bridge/state'){
      const value=typeof p==='string'?p:p?.state;if(!['online','offline'].includes(value))return;
      if(n.bridgeState!==value)this.s.event('bridge_'+value,'Zigbee2MQTT reported '+value,{networkId,at:now});
      n.bridgeState=value;n.bridgeAt=now;this.s.saveNetwork(n);return;
    }
    if(name==='bridge/devices'&&Array.isArray(p)){
      if(p.length>4096)return;
      const seen=new Set();
      this.s.transaction(()=>{
        for(const x of p){if(x.type==='Coordinator'||!/^0x[0-9a-f]{16}$/i.test(x.ieee_address||''))continue;
          const id=deviceId(networkId,x.ieee_address),old=this.s.device(id);seen.add(id);
          const d={id,networkId,ieee:x.ieee_address.toLowerCase(),name:String(x.friendly_name||x.ieee_address).slice(0,150),model:x.definition?.model||'Unknown model',vendor:x.definition?.vendor||'',power:/battery/i.test(x.power_source||'')?'battery':'mains',room:old?.room||'',addedAt:old?.addedAt||now,lastLiveAt:null,lastReceivedAt:null,battery:null,lqi:null,availability:'unknown',overrides:{},...old,inventoryPresent:true,disabled:x.disabled===true};
          d.name=String(x.friendly_name||x.ieee_address).slice(0,150);d.model=x.definition?.model||d.model;d.vendor=x.definition?.vendor||d.vendor;if(x.power_source)d.power=/battery/i.test(x.power_source)?'battery':'mains';
          if(old&&old.name!==d.name)this.s.event('device_renamed',old.name+' renamed to '+d.name,{deviceId:id,networkId,at:now});
          this.s.saveDevice(d);
        }
        for(const d of this.s.devices(networkId))if(!seen.has(d.id)&&d.inventoryPresent){d.inventoryPresent=false;this.s.saveDevice(d);this.s.event('inventory_missing','Device no longer appears in the bridge inventory',{deviceId:d.id,networkId,at:now});}
      });return;
    }
    if(name==='bridge/event'){
      const ieee=p?.data?.ieee_address,id=ieee?deviceId(networkId,ieee):null;
      if(['device_leave','device_joined','device_announce'].includes(p?.type))this.s.event(p.type,p.type.replaceAll('_',' '),{deviceId:id,networkId,at:now});return;
    }
    if(name.startsWith('bridge/'))return;
    const availability=name.endsWith('/availability'),friendly=availability?name.slice(0,-13):name;
    if(/\/(?:set|get)(?:\/|$)/.test(name))return;
    const d=this.s.devices(networkId).find(d=>d.name===friendly);if(!d||d.retiredAt)return;
    if(availability){const value=typeof p==='string'?p:p?.state;if(['online','offline'].includes(value)){d.availability=value;d.availabilityAt=now;d.availabilityRetained=retain;this.s.saveDevice(d);}return;}
    if(!p||typeof p!=='object'||Array.isArray(p))return;
    d.lastReceivedAt=now;
    if(retain){d.cachedAt=now;this.s.saveDevice(d);return;}
    d.lastLiveAt=now;
    const battery=numeric(p.battery,0,100),lqi=numeric(p.linkquality,0,255);
    if(battery!==null)d.battery=battery;if(lqi!==null)d.lqi=lqi;
    this.s.saveDevice(d);
    const bucket=Math.floor(now/300000)*300000;
    this.s.run(`INSERT INTO samples(device_id,bucket,lqi_sum,lqi_count,lqi_min,lqi_max,battery_min,report_count) VALUES(?,?,?,?,?,?,?,1)
      ON CONFLICT(device_id,bucket) DO UPDATE SET lqi_sum=lqi_sum+excluded.lqi_sum,lqi_count=lqi_count+excluded.lqi_count,
      lqi_min=CASE WHEN excluded.lqi_min IS NULL THEN lqi_min WHEN lqi_min IS NULL THEN excluded.lqi_min ELSE min(lqi_min,excluded.lqi_min) END,
      lqi_max=CASE WHEN excluded.lqi_max IS NULL THEN lqi_max WHEN lqi_max IS NULL THEN excluded.lqi_max ELSE max(lqi_max,excluded.lqi_max) END,
      battery_min=CASE WHEN excluded.battery_min IS NULL THEN battery_min WHEN battery_min IS NULL THEN excluded.battery_min ELSE min(battery_min,excluded.battery_min) END,report_count=report_count+1`,d.id,bucket,lqi||0,lqi===null?0:1,lqi,lqi,battery);
  }
  active(scope,category){return this.s.one('SELECT * FROM incidents WHERE '+(scope.startsWith('network:')?'network_id=? AND device_id IS NULL':'device_id=?')+' AND category=? AND restored_at IS NULL ORDER BY opened_at DESC LIMIT 1',scope.startsWith('network:')?scope.slice(8):scope,category);}
  condition({scope,networkId,deviceId=null,category,value,priority='warning',description,thresholds=this.thresholds()}){
    if(value===null)return;
    const now=this.now(),old=this.s.one('SELECT * FROM conditions WHERE scope=? AND category=?',scope,category),active=this.active(scope,category);
    const same=old?.last_known===(value?1:0);
    if(same&&((value&&active)||(!value&&!active)))return;
    let since=value?(old?.last_known===1?old.since:now):null,recovery=!value&&active?(old?.last_known===0?old.recover_since:now):null;
    this.s.transaction(()=>{
    if(!same)this.s.run('INSERT INTO conditions VALUES(?,?,?,?,?) ON CONFLICT(scope,category) DO UPDATE SET since=excluded.since,recover_since=excluded.recover_since,last_known=excluded.last_known',scope,category,since,recovery,value?1:0);
    if(value&&!active&&now-since>=thresholds.faultDelaySec*1000){const id=uid();this.s.run('INSERT INTO incidents(id,device_id,network_id,category,priority,opened_at,description) VALUES(?,?,?,?,?,?,?)',id,deviceId,networkId,category,priority,now,description);this.s.event('alarm_raised',description,{networkId,deviceId,incidentId:id,at:now});}
    if(!value&&active&&now-recovery>=thresholds.recoveryDelaySec*1000){this.s.run('UPDATE incidents SET restored_at=? WHERE id=?',now,active.id);this.s.event('alarm_restored',labels[category]+' restored',{networkId,deviceId,incidentId:active.id,at:now});}
    });
  }
  shunts(){return this.s.all('SELECT * FROM shunts WHERE cancelled_at IS NULL AND expired_at IS NULL AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC',this.now());}
  isShunted(i){return this.shunts().some(s=>(s.scope_type==='device'?s.scope_id===i.device_id:s.scope_id===i.network_id)&&(!s.category||s.category===i.category));}
  deviceState(d,n,incidents){
    const source=this.sourceStatus(n),hasLive=!!d.lastLiveAt&&d.lastLiveAt>=(n.connectedAt||0);
    const active=incidents.filter(i=>i.device_id===d.id&&!i.restored_at),pending=this.s.all('SELECT category FROM conditions WHERE scope=? AND last_known=1',d.id).filter(c=>!active.some(i=>i.category===c.category));
    const issues=[...active.map(i=>({category:i.category,label:labels[i.category],priority:i.priority,shunted:this.isShunted(i)})),...pending.map(c=>({category:c.category,label:labels[c.category]+' · Pending',priority:c.category==='offline'?'critical':'warning',pending:true,shunted:this.isShunted({device_id:d.id,network_id:d.networkId,category:c.category})}))];
    const status=d.retiredAt?'retired':d.disabled?'excluded':source!=='online'?'unknown':d.availability==='offline'?'offline':!hasLive?'unknown':issues.some(i=>i.category==='stale')?'stale':issues.length?'issues':'healthy';
    return {...d,status,issues,networkLabel:n.label,sourceStatus:source,hasLive};
  }
  tick(){
    const now=this.now();
    for(const sh of this.s.all('SELECT * FROM shunts WHERE cancelled_at IS NULL AND expired_at IS NULL AND expires_at IS NOT NULL AND expires_at<=?',now)){
      this.s.transaction(()=>{
      this.s.run('UPDATE shunts SET expired_at=? WHERE id=?',now,sh.id);this.s.event('shunt_expired','Shunt expired: '+sh.reason,{actor:'System',deviceId:sh.scope_type==='device'?sh.scope_id:null,networkId:sh.scope_type==='network'?sh.scope_id:null,at:now});
      this.rearmShunt(sh);
      });
    }
    for(const n of this.s.networks()){
      if(!n.enabled)continue;const source=this.sourceStatus(n),t=this.thresholds(),scope='network:'+n.id;
      this.condition({scope,networkId:n.id,category:'broker',value:!n.connected,priority:'critical',description:n.label+': MQTT broker is unreachable',thresholds:t});
      this.condition({scope,networkId:n.id,category:'bridge',value:!n.connected?null:n.bridgeState!=='online',priority:'critical',description:n.label+': Zigbee2MQTT bridge is unavailable',thresholds:t});
      if(source!=='online')continue;
      for(const d of this.s.devices(n.id)){
        if(d.disabled||d.retiredAt)continue;const dt=this.thresholds(d),hasLive=!!d.lastLiveAt&&d.lastLiveAt>=(n.connectedAt||0),stale=hasLive&&now-d.lastLiveAt>(d.power==='battery'?dt.batteryTimeoutMin:dt.mainsTimeoutMin)*60000;
        const base={scope:d.id,deviceId:d.id,networkId:n.id,thresholds:dt};
        this.condition({...base,category:'missing',value:d.inventoryPresent===false,description:d.name+' is missing from the bridge inventory'});
        this.condition({...base,category:'offline',value:d.availability==='offline'?true:d.availability==='online'||hasLive?false:null,priority:'critical',description:d.name+' is reported offline by Zigbee2MQTT'});
        this.condition({...base,category:'stale',value:hasLive?stale:null,description:d.name+' has exceeded its expected reporting interval'});
        const fresh=hasLive&&!stale&&d.availability!=='offline';
        const battActive=this.active(d.id,'battery'),sigActive=this.active(d.id,'signal');
        this.condition({...base,category:'battery',value:fresh&&d.battery!==null?d.battery<=(battActive?dt.batteryRecovery-0.001:dt.lowBattery):null,description:d.name+': battery '+d.battery+'%'});
        this.condition({...base,category:'signal',value:fresh&&d.lqi!==null?d.lqi<(sigActive?dt.signalRecovery:dt.weakSignal):null,description:d.name+': link quality '+d.lqi+' LQI'});
        const count=this.s.one("SELECT count(*) AS n FROM incidents WHERE device_id=? AND category='offline' AND opened_at>=?",d.id,Math.max(now-dt.dropoutWindowHours*HOUR,d.monitoringSince||0)).n;
        this.condition({...base,category:'flapping',value:count>=dt.dropoutCount,description:d.name+': '+count+' offline episodes in '+dt.dropoutWindowHours+' hours'});
      }
    }
    this.queueNotifications();
    if(now-this.lastPrune>HOUR){this.prune();this.lastPrune=now;}
  }
  acknowledge(ids,actor,note=''){
    if(!Array.isArray(ids)||ids.length<1||ids.length>100)throw Error('Select between 1 and 100 alarms');
    this.s.transaction(()=>{for(const id of ids){const i=this.s.one('SELECT * FROM incidents WHERE id=?',id);if(!i||i.processed_at)throw Error('Alarm is unavailable');if(i.ack_at)continue;this.s.run('UPDATE incidents SET ack_at=?,ack_by=? WHERE id=?',this.now(),actor,id);this.s.event('acknowledged',note||'Alarm acknowledged',{deviceId:i.device_id,networkId:i.network_id,incidentId:id,actor,at:this.now()});}});
  }
  process(id,actor,note=''){const i=this.s.one('SELECT * FROM incidents WHERE id=?',id);if(!i||!i.restored_at)throw Error('Only restored alarms can be processed');this.s.transaction(()=>{this.s.run('UPDATE incidents SET processed_at=? WHERE id=?',this.now(),id);this.s.event('processed',note||'Restored alarm processed',{deviceId:i.device_id,networkId:i.network_id,incidentId:id,actor,at:this.now()});});}
  shunt({scopeType,scopeId,category=null,durationMin=null,reason},actor){
    if(!['device','network'].includes(scopeType)||!(scopeType==='device'?this.s.device(scopeId):this.s.network(scopeId)))throw Error('Select a valid shunt target');
    if(scopeType==='device'&&this.s.device(scopeId).retiredAt)throw Error('Retired devices cannot be shunted');
    if(category&&!Object.hasOwn(labels,category))throw Error('Invalid issue category');
    if(typeof reason!=='string'||!reason.trim()||reason.length>300)throw Error('A shunt reason is required');
    if(durationMin!==null&&(!Number.isInteger(durationMin)||durationMin<1||durationMin>525600))throw Error('Invalid shunt duration');
    const sh={id:uid(),scope_type:scopeType,scope_id:scopeId,category,created_at:this.now(),expires_at:durationMin===null?null:this.now()+durationMin*60000,reason:reason.trim(),actor};
    this.s.transaction(()=>{this.s.run('INSERT INTO shunts(id,scope_type,scope_id,category,created_at,expires_at,reason,actor) VALUES(?,?,?,?,?,?,?,?)',sh.id,scopeType,scopeId,category,sh.created_at,sh.expires_at,sh.reason,actor);
    this.s.event('shunt_created',sh.reason,{deviceId:scopeType==='device'?scopeId:null,networkId:scopeType==='network'?scopeId:null,actor,at:this.now()});});return sh;
  }
  rearmShunt(sh){for(const i of this.s.all('SELECT * FROM incidents WHERE restored_at IS NULL'))if((sh.scope_type==='device'?i.device_id===sh.scope_id:i.network_id===sh.scope_id)&&(!sh.category||sh.category===i.category)&&!this.isShunted(i))this.s.run('UPDATE incidents SET ack_at=NULL,ack_by=NULL,rearm=rearm+1 WHERE id=?',i.id);}
  cancelShunt(id,actor){const sh=this.s.one('SELECT * FROM shunts WHERE id=? AND cancelled_at IS NULL AND expired_at IS NULL',id);if(!sh)throw Error('Shunt is unavailable');this.s.transaction(()=>{this.s.run('UPDATE shunts SET cancelled_at=? WHERE id=?',this.now(),id);this.s.event('shunt_cancelled',sh.reason,{actor,at:this.now(),deviceId:sh.scope_type==='device'?sh.scope_id:null,networkId:sh.scope_type==='network'?sh.scope_id:null});this.rearmShunt(sh);});}
  queueNotifications(){
    const mail=this.s.get('email');if(!mail?.enabled||this.demo)return;
    for(const i of this.s.all('SELECT * FROM incidents WHERE processed_at IS NULL')){
      const source=this.s.network(i.network_id);if(!source?.enabled)continue;
      const eligible=!i.ack_at&&!this.isShunted(i)&&(!i.device_id||!this.s.device(i.device_id)?.retiredAt&&!this.s.device(i.device_id)?.disabled&&this.sourceStatus(source)==='online')&&!(i.category==='bridge'&&!source.connected);
      const c=this.s.one('SELECT * FROM conditions WHERE scope=? AND category=?',i.device_id||'network:'+i.network_id,i.category);
      if(!i.restored_at&&eligible&&c?.last_known===1)this.s.run("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,?,'queued',NULL,NULL)",uid(),i.id,'alarm',i.rearm,this.now());
      if(!i.resolution&&i.restored_at&&mail.recovery&&this.s.one("SELECT id FROM outbox WHERE incident_id=? AND kind='alarm' AND status='accepted'",i.id))this.s.run("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,?,'queued',NULL,NULL)",uid(),i.id,'recovery',i.rearm,this.now());
    }
  }
  async deliver(send){
    if(this.delivering||this.demo||!this.s.get('email')?.enabled)return;this.delivering=true;
    try{for(const job of this.s.all("SELECT * FROM outbox WHERE status='queued' ORDER BY created_at LIMIT 10")){
      const i=this.s.one('SELECT * FROM incidents WHERE id=?',job.incident_id),n=i&&this.s.network(i.network_id);
      const eligible=i&&!i.resolution&&n?.enabled&&!this.isShunted(i)&&(!i.device_id||!this.s.device(i.device_id)?.retiredAt&&!this.s.device(i.device_id)?.disabled)&&(job.kind==='recovery'?!!i.restored_at:!i.restored_at&&!i.ack_at&&i.rearm===job.rearm&&(!i.device_id||this.sourceStatus(n)==='online')&&!(i.category==='bridge'&&!n.connected)&&this.s.one('SELECT last_known FROM conditions WHERE scope=? AND category=?',i.device_id||'network:'+i.network_id,i.category)?.last_known===1);
      if(!eligible){this.s.run("UPDATE outbox SET status='suppressed',finished_at=? WHERE id=?",this.now(),job.id);continue;}
      this.s.run("UPDATE outbox SET status='delivering' WHERE id=?",job.id);
      try{await send({subject:'[Zigbee Health] '+(job.kind==='recovery'?'Restored: ':'')+labels[i.category],text:i.description+'\nNetwork: '+n.label+'\nRaised: '+new Date(i.opened_at).toISOString()+'\nIncident: '+i.id});this.s.run("UPDATE outbox SET status='accepted',finished_at=? WHERE id=?",this.now(),job.id);}
      catch{this.s.run("UPDATE outbox SET status='uncertain',error='Email delivery was not confirmed. No automatic retry.',finished_at=? WHERE id=?",this.now(),job.id);}
    }}finally{this.delivering=false;}
  }
  prune(){const cutoff=this.now()-this.thresholds().retentionDays*DAY;this.s.transaction(()=>{
    this.s.run('DELETE FROM samples WHERE bucket<?',cutoff);
    this.s.run('DELETE FROM events WHERE at<? AND (incident_id IS NULL OR incident_id NOT IN (SELECT id FROM incidents WHERE processed_at IS NULL))',cutoff);
    this.s.run('DELETE FROM outbox WHERE incident_id IN (SELECT id FROM incidents WHERE processed_at IS NOT NULL AND processed_at<?)',cutoff);
    this.s.run('DELETE FROM incidents WHERE processed_at IS NOT NULL AND processed_at<?',cutoff);
    this.s.run('DELETE FROM shunts WHERE (cancelled_at IS NOT NULL AND cancelled_at<?) OR (expired_at IS NOT NULL AND expired_at<?)',cutoff,cutoff);
    this.s.set('lastPruneAt',this.now());
  });}
  snapshot(){
    const incidents=this.s.all('SELECT * FROM incidents WHERE processed_at IS NULL ORDER BY CASE priority WHEN \'critical\' THEN 0 ELSE 1 END,opened_at ASC'),networks=this.s.networks();
    const netMap=new Map(networks.map(n=>[n.id,n]));
    const devices=this.s.devices().map(d=>this.deviceState(d,netMap.get(d.networkId),incidents));
    const map=new Map(devices.map(d=>[d.id,d]));
    const alarms=incidents.map(i=>({...i,deviceName:map.get(i.device_id)?.name||netMap.get(i.network_id)?.label||'Network',networkLabel:netMap.get(i.network_id)?.label,issue:labels[i.category],shunted:this.isShunted(i),monitoringSuspended:!!i.device_id&&(map.get(i.device_id)?.disabled||this.sourceStatus(netMap.get(i.network_id))!=='online')}));
    return {at:this.now(),demo:this.demo,timezone:this.timezone,links:this.s.all('SELECT * FROM device_links ORDER BY created_at'),networks:networks.map(({password,...n})=>({...n,passwordSet:!!password,status:this.sourceStatus(n)})),devices,alarms,shunts:this.shunts(),thresholds:this.thresholds(),events:this.s.all('SELECT * FROM events ORDER BY at DESC,id DESC LIMIT 200'),email:{...this.s.get('email'),password:undefined,passwordSet:!!this.s.get('email')?.password},deliveries:this.s.all('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 50'),storage:{bytes:this.s.one('PRAGMA page_count').page_count*this.s.one('PRAGMA page_size').page_size,createdAt:this.s.get('createdAt'),lastPruneAt:this.s.get('lastPruneAt'),retentionDays:this.thresholds().retentionDays,oldestSampleAt:this.s.one('SELECT min(bucket) AS at FROM samples').at,lastBackupAt:this.s.get('lastBackupAt')}};
  }
  report(id,days=7){
    const d=this.s.device(id);if(!d)throw Error('Device not found');if(![1,7,30,90].includes(days))throw Error('Invalid report range');
    const start=this.now()-days*DAY,samples=this.s.all('SELECT bucket,lqi_min,lqi_max,CASE WHEN lqi_count>0 THEN lqi_sum/lqi_count ELSE NULL END AS lqi_avg,battery_min,report_count FROM samples WHERE device_id=? AND bucket>=? ORDER BY bucket LIMIT 30000',id,start);
    const incidents=this.s.all('SELECT * FROM incidents WHERE device_id=? AND (opened_at>=? OR restored_at>=? OR restored_at IS NULL) ORDER BY opened_at DESC',id,start,start);
    const events=this.s.all('SELECT * FROM events WHERE (device_id=? OR (device_id IS NULL AND network_id=?)) AND at>=? ORDER BY at DESC LIMIT 1000',id,d.networkId,start);
    const downtime=incidents.filter(i=>i.category==='offline').reduce((sum,i)=>sum+Math.max(0,Math.min(this.now(),i.restored_at||this.now())-Math.max(start,i.opened_at)),0);
    return {device:d,timezone:this.timezone,links:this.linksFor(id),historyCounts:this.historyCounts(id),days,from:start,to:this.now(),samples,incidents,events,offlineEpisodes:incidents.filter(i=>i.category==='offline').length,downtimeMs:downtime,coverageFrom:samples[0]?.bucket||null,note:'Last heard measures MQTT receipt time, not authenticated physical sample time. Downtime covers detected individual-device offline incidents; bridge outages are shown as separate events. Collection gaps are not treated as healthy.'};
  }
}
