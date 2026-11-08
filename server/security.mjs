import crypto from 'node:crypto';
import {pushAccountActive,securityPushRecipients} from './accounts.mjs';

const DAY=86400000,MINUTE=60000,MAX_PROPERTIES=128;
const MODES=['disarmed','away','home'];
const OPERATORS=['eq','ne','gt','gte','lt','lte'];
const uid=()=>crypto.randomUUID();
const parse=raw=>raw?JSON.parse(raw):null;
const own=(value,key)=>Object.hasOwn(value,key);
const scalar=value=>typeof value==='boolean'||typeof value==='string'&&value.length<=200||typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e12;
const requireValue=(ok,message)=>{if(!ok)throw Error(message);};
const text=(value,label,max=80)=>{requireValue(typeof value==='string'&&value.trim().length>0&&value.trim().length<=max&&!/[\u0000-\u001f\u007f]/.test(value),label+' must be 1–'+max+' characters');return value.trim();};
const integer=(value,min,max,label)=>{requireValue(Number.isInteger(value)&&value>=min&&value<=max,'Invalid '+label);return value;};
const bool=(value,label)=>{requireValue(typeof value==='boolean','Invalid '+label);return value;};
const actorName=value=>text(value||'System','Actor',100);
const identifier=(value,label)=>{requireValue(typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f]/.test(value),'Invalid '+label);return value;};
const timezone=value=>{requireValue(typeof value==='string'&&value.length<=100,'Choose a valid timezone');try{new Intl.DateTimeFormat('en-GB',{timeZone:value}).format(0);}catch{throw Error('Choose a valid timezone');}return value;};
const property=value=>{requireValue(typeof value==='string'&&value.length<=100&&/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,4}$/.test(value)&&!value.split('.').some(p=>['__proto__','prototype','constructor'].includes(p))&&!/(?:password|secret|token|credential|api_?key)|(?:^|[._])(?:pin|code)(?:$|[._])/i.test(value),'Choose a valid sensor property');return value;};
const object=(input,keys)=>{requireValue(input&&typeof input==='object'&&!Array.isArray(input),'Provide configuration fields');requireValue(Object.keys(input).every(key=>keys.includes(key)),'Unknown configuration field');return input;};
const compare=(value,operator,target)=>operator==='eq'?value===target:operator==='ne'?value!==target:typeof value==='number'&&typeof target==='number'&&(operator==='gt'?value>target:operator==='gte'?value>=target:operator==='lt'?value<target:value<=target);
const sensorProperty=(payload,path)=>{let value=payload;for(const key of path.split('.')){if(!value||typeof value!=='object'||!own(value,key))return {present:false};value=value[key];}return {present:true,value};};

export const defaultSecurityPayload=JSON.stringify({event:'{{event}}',area:'{{area}}',zone:'{{zone}}',device:'{{device}}',timestamp:'{{timestamp}}',incidentId:'{{incidentId}}'});

/** Independent residential security state. No network or device command is sent here. */
export class SecurityEngine {
  constructor(store,{demo=false,clock,now,timezone:zone=process.env.TZ||'UTC'}={}){
    this.s=store;this.demo=demo;this.clock=clock||now||(()=>Date.now());this.timezone=timezone(zone);
    this.readings=new Map();this.edges=new Map();this.lastMinute=Math.floor(this.now()/MINUTE);this.lastTickAt=this.now();this.lastPrune=this.now();this.delivering=false;
    this.s.db.exec(`CREATE TABLE IF NOT EXISTS security_areas(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_zones(id TEXT PRIMARY KEY,area_id TEXT NOT NULL,device_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS security_zone_area ON security_zones(area_id);
      CREATE INDEX IF NOT EXISTS security_zone_device ON security_zones(device_id);
      CREATE TABLE IF NOT EXISTS security_zone_areas(zone_id TEXT NOT NULL,area_id TEXT NOT NULL,PRIMARY KEY(zone_id,area_id));
      CREATE INDEX IF NOT EXISTS security_zone_membership_area ON security_zone_areas(area_id);
      CREATE TABLE IF NOT EXISTS security_schedules(id TEXT PRIMARY KEY,area_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_actions(id TEXT PRIMARY KEY,area_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_readings(device_id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_incidents(id TEXT PRIMARY KEY,area_id TEXT NOT NULL,zone_id TEXT NOT NULL,cycle_id TEXT NOT NULL,raised_at INTEGER NOT NULL,ack_at INTEGER,ack_by TEXT,restored_at INTEGER,reset_at INTEGER,json TEXT NOT NULL,UNIQUE(area_id,zone_id,cycle_id));
      CREATE INDEX IF NOT EXISTS security_incident_area ON security_incidents(area_id,reset_at);
      CREATE TABLE IF NOT EXISTS security_events(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,area_id TEXT,zone_id TEXT,incident_id TEXT,type TEXT NOT NULL,actor TEXT NOT NULL,message TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS security_event_time ON security_events(at);
      CREATE TABLE IF NOT EXISTS security_deliveries(id TEXT PRIMARY KEY,incident_id TEXT NOT NULL,action_id TEXT NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL,error TEXT,finished_at INTEGER,action_json TEXT NOT NULL,context_json TEXT NOT NULL,UNIQUE(incident_id,action_id));
      CREATE INDEX IF NOT EXISTS security_delivery_status ON security_deliveries(status,created_at);
      CREATE TABLE IF NOT EXISTS security_push_deliveries(id TEXT PRIMARY KEY,delivery_id TEXT,incident_id TEXT NOT NULL,action_id TEXT NOT NULL,subscription_id TEXT NOT NULL,owner_id TEXT,endpoint_hash TEXT NOT NULL,label TEXT NOT NULL,kind TEXT NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL,error TEXT,finished_at INTEGER,UNIQUE(incident_id,action_id,subscription_id));
      CREATE INDEX IF NOT EXISTS security_push_delivery_parent ON security_push_deliveries(delivery_id,status);
      CREATE INDEX IF NOT EXISTS security_push_delivery_owner ON security_push_deliveries(owner_id,created_at);`);
    this.s.transaction(()=>{
      // Backfill membership only. Existing detector JSON and runtime history are
      // deliberately left byte-exact when upgrading a single-area workspace.
      this.s.run('INSERT INTO security_zone_areas(zone_id,area_id) SELECT z.id,z.area_id FROM security_zones z JOIN security_areas a ON a.id=z.area_id WHERE NOT EXISTS (SELECT 1 FROM security_zone_areas m WHERE m.zone_id=z.id)');
      this.s.run("UPDATE security_deliveries SET status='uncertain',error='Service restarted during delivery. No automatic retry.',finished_at=? WHERE status='delivering'",this.now());
      this.s.run("UPDATE security_deliveries SET status='suppressed',error='Service restarted; previous queued outputs were cancelled.',finished_at=? WHERE status='queued'",this.now());
      this.s.run("UPDATE security_push_deliveries SET status='uncertain',error='Service restarted during delivery. No automatic retry.',finished_at=? WHERE status='delivering'",this.now());
      this.s.run("UPDATE security_push_deliveries SET status='suppressed',error='Service restarted; previous queued outputs were cancelled.',finished_at=? WHERE status='queued'",this.now());
    });
    for(const area of this.areas())if(area.targetMode){
        this._saveArea(this.clearCycleBypass({...area,mode:'disarmed',targetMode:null,exitAt:null,entryAt:null,pendingZoneId:null,armedAt:null}));
        this.event('restart_exit_cancelled',area.name+' exit delay was cancelled by a service restart; this area is disarmed.',{areaId:area.id});
      }else if(area.entryAt){
        const zone=this.zone(area.pendingZoneId);if(zone)this._trigger(area,zone,area.pendingActivatedAt||this.now(),false);
        this._saveArea({...this.requireArea(area.id),entryAt:null,pendingZoneId:null});
        this.event('restart_entry_latched',area.name+' restarted during an entry delay. The area remains armed; alarm memory is retained without replaying outputs.',{areaId:area.id});
      }else if(area.mode!=='disarmed')this.event('restart_armed',area.name+' remains armed after a service restart. Fresh zone reports are required; cached reports do not trigger outputs.',{areaId:area.id});
  }
  now(){return this.clock();}
  areas(){return this.s.all('SELECT json FROM security_areas ORDER BY rowid').map(row=>parse(row.json));}
  zones(){const memberships=new Map();for(const row of this.s.all('SELECT zone_id,area_id FROM security_zone_areas ORDER BY rowid')){if(!memberships.has(row.zone_id))memberships.set(row.zone_id,[]);memberships.get(row.zone_id).push(row.area_id);}return this.s.all('SELECT json FROM security_zones ORDER BY rowid').map(row=>{const zone=parse(row.json),areaIds=memberships.get(zone.id)||[];return {...zone,areaId:areaIds.includes(zone.areaId)?zone.areaId:areaIds[0]||zone.areaId,areaIds};});}
  schedules(){return this.s.all('SELECT json FROM security_schedules ORDER BY rowid').map(row=>parse(row.json));}
  actions(){return this.s.all('SELECT json FROM security_actions ORDER BY rowid').map(row=>parse(row.json));}
  area(id){return parse(this.s.one('SELECT json FROM security_areas WHERE id=?',typeof id==='string'?id:'')?.json);}
  zone(id){const zone=parse(this.s.one('SELECT json FROM security_zones WHERE id=?',typeof id==='string'?id:'')?.json);if(!zone)return null;const areaIds=this.s.all('SELECT area_id FROM security_zone_areas WHERE zone_id=? ORDER BY rowid',zone.id).map(row=>row.area_id);return {...zone,areaId:areaIds.includes(zone.areaId)?zone.areaId:areaIds[0]||zone.areaId,areaIds};}
  zoneInArea(zone,id){return zone.areaIds.includes(id);}
  editableZone(zone){for(const id of zone.areaIds)this.editable(this.requireArea(id));}
  action(id){return parse(this.s.one('SELECT json FROM security_actions WHERE id=?',typeof id==='string'?id:'')?.json);}
  requireArea(id){const area=this.area(id);requireValue(area,'Security area not found');return area;}
  _saveArea(area){this.s.run('INSERT INTO security_areas VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json',area.id,JSON.stringify(area));return area;}
  event(type,message,{areaId=null,zoneId=null,incidentId=null,actor='System'}={}){return Number(this.s.run('INSERT INTO security_events(at,area_id,zone_id,incident_id,type,actor,message) VALUES(?,?,?,?,?,?,?)',this.now(),areaId,zoneId,incidentId,type,actorName(actor),message).lastInsertRowid);}
  editable(area){requireValue(area.mode==='disarmed'&&!area.targetMode&&!area.entryAt,'Disarm this area before changing its configuration');}
  saveArea(input,actor='System'){
    const body=object(input,['id','name','enabled','entryDelaySec','exitDelaySec']);
    const old=body.id?this.requireArea(identifier(body.id,'area')):null;if(old)this.editable(old);
    const area={...(old||{id:uid(),mode:'disarmed',targetMode:null,exitAt:null,entryAt:null,pendingZoneId:null,armedAt:null,cycleId:null,createdAt:this.now()}),name:text(body.name??old?.name,'Area name'),enabled:bool(body.enabled??old?.enabled??true,'area enabled state'),entryDelaySec:integer(body.entryDelaySec??old?.entryDelaySec??30,0,600,'entry delay'),exitDelaySec:integer(body.exitDelaySec??old?.exitDelaySec??30,0,600,'exit delay'),updatedAt:this.now()};
    requireValue(this.areas().every(a=>a.id===area.id||a.name.toLowerCase()!==area.name.toLowerCase()),'Area names must be unique');
    requireValue(old||this.areas().length<64,'At most 64 security areas are supported');
    this.s.transaction(()=>{this._saveArea(area);this.event(old?'area_updated':'area_created',area.name+(old?' configuration updated':' created disarmed'),{areaId:area.id,actor});});return this.areaView(area);
  }
  removeArea(id,actor='System'){
    const area=this.requireArea(id);this.editable(area);requireValue(!this.activeIncidents(id).length,'Reset this area’s alarm memory before removing it');
    const linked=this.zones().filter(zone=>this.zoneInArea(zone,id));for(const zone of linked){this.editableZone(zone);requireValue(!this.s.one('SELECT id FROM security_incidents WHERE zone_id=? AND reset_at IS NULL',zone.id),'Reset shared zone alarm memory before changing its area memberships');}
    this.s.transaction(()=>{this.event('area_removed',area.name+' removed; its audit history is retained',{areaId:id,actor});for(const zone of linked){const areaIds=zone.areaIds.filter(member=>member!==id);this.s.run('DELETE FROM security_zone_areas WHERE zone_id=? AND area_id=?',zone.id,id);if(areaIds.length){const next={...zone,areaId:areaIds[0],areaIds};this.s.run('UPDATE security_zones SET area_id=?,json=? WHERE id=?',next.areaId,JSON.stringify(next),zone.id);}else{this.s.run('DELETE FROM security_zones WHERE id=?',zone.id);this.edges.delete(zone.id);}}for(const table of ['security_schedules','security_actions'])this.s.run('DELETE FROM '+table+' WHERE area_id=?',id);this._suppressArea(id,'Area removed');this.s.run('DELETE FROM security_areas WHERE id=?',id);});
  }
  saveZone(input,actor='System'){
    const body=object(input,['id','areaId','areaIds','deviceId','name','property','operator','value','type','homeBypass','enabled','freshnessMin']);
    const old=body.id?this.zone(identifier(body.id,'zone')):null;requireValue(!body.id||old,'Security zone not found');
    // A pre-upgrade browser may still submit the unchanged compatibility areaId
    // while editing a name. Preserve memberships unless it explicitly moves.
    const requested=own(body,'areaIds')?body.areaIds:own(body,'areaId')?old&&body.areaId===old.areaId?old.areaIds:[body.areaId]:old?.areaIds;
    requireValue(Array.isArray(requested)&&requested.length>0&&requested.length<=64&&requested.every(id=>typeof id==='string')&&new Set(requested).size===requested.length,'Choose one or more unique areas for this zone');
    const areas=requested.map(id=>this.requireArea(identifier(id,'area'))),areaIds=areas.map(area=>area.id),area=areas[0];
    requireValue(!own(body,'areaIds')||!own(body,'areaId')||body.areaId===area.id,'The compatibility area must be the first selected area');
    for(const id of new Set([...(old?.areaIds||[]),...areaIds]))this.editable(this.requireArea(id));
    const membershipChanged=old&&(old.areaIds.length!==areaIds.length||old.areaIds.some(id=>!areaIds.includes(id)));
    if(membershipChanged)requireValue(!this.s.one('SELECT id FROM security_incidents WHERE zone_id=? AND reset_at IS NULL',old.id),'Reset this zone’s alarm memory before changing its area memberships');
    const device=this.s.device(body.deviceId??old?.deviceId),network=device&&this.s.network(device.networkId);
    requireValue(device&&!device.retiredAt&&!device.disabled&&network&&network.mode!=='mqtt','Choose a current Zigbee device');
    const zone={...(old||{id:uid(),bypassAt:null,bypassUntil:null,bypassReason:'',createdAt:this.now()}),areaId:area.id,areaIds,deviceId:device.id,name:text(body.name??old?.name??device.name,'Zone name'),property:property(body.property??old?.property),operator:body.operator??old?.operator??'eq',value:own(body,'value')?body.value:old?.value,type:body.type??old?.type??'instant',homeBypass:bool(body.homeBypass??old?.homeBypass??false,'Home exclusion'),enabled:bool(body.enabled??old?.enabled??true,'zone enabled state'),freshnessMin:integer(body.freshnessMin??old?.freshnessMin??1500,1,43200,'zone reporting timeout'),updatedAt:this.now()};
    requireValue(OPERATORS.includes(zone.operator)&&scalar(zone.value),'Choose a valid operator and scalar trigger value');
    requireValue(['eq','ne'].includes(zone.operator)||typeof zone.value==='number','Numeric comparisons require a numeric trigger value');
    requireValue(['instant','entry'].includes(zone.type),'Choose an instant or entry zone');
    requireValue(this.zones().every(z=>z.id===zone.id||!z.areaIds.some(id=>areaIds.includes(id))||z.deviceId!==device.id||z.property!==zone.property),'This device property is already a zone in a selected area');
    requireValue(new Set([...this.zones().filter(z=>z.deviceId===device.id&&z.id!==zone.id).map(z=>z.property),zone.property]).size<=MAX_PROPERTIES,'At most 128 detector properties can be configured per device');
    requireValue(old||this.zones().length<1024,'At most 1024 security zones are supported');
    this.s.transaction(()=>{this.s.run('INSERT INTO security_zones VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET area_id=excluded.area_id,device_id=excluded.device_id,json=excluded.json',zone.id,zone.areaId,zone.deviceId,JSON.stringify(zone));this.s.run('DELETE FROM security_zone_areas WHERE zone_id=?',zone.id);for(const id of areaIds)this.s.run('INSERT INTO security_zone_areas VALUES(?,?)',zone.id,id);for(const id of new Set([...(old?.areaIds||[]),...areaIds]))this.event(old?'zone_updated':'zone_created',zone.name+(old?' configuration updated':' added')+'; areas: '+areas.map(member=>member.name).join(', '),{areaId:id,zoneId:zone.id,actor});});this.edges.delete(zone.id);return this.zoneState(zone);
  }
  removeZone(id,actor='System'){
    const zone=this.zone(id);requireValue(zone,'Security zone not found');this.editableZone(zone);requireValue(!this.s.one('SELECT id FROM security_incidents WHERE zone_id=? AND reset_at IS NULL',id),'Reset this zone’s alarm memory before removing it');
    this.s.transaction(()=>{this.s.run('DELETE FROM security_zone_areas WHERE zone_id=?',id);this.s.run('DELETE FROM security_zones WHERE id=?',id);for(const areaId of zone.areaIds)this.event('zone_removed',zone.name+' removed from all areas; its audit history is retained',{areaId,zoneId:id,actor});});this.edges.delete(id);
  }
  saveSchedule(input,actor='System'){
    const body=object(input,['id','name','areaId','days','time','timezone','mode','enabled']);
    const old=body.id?parse(this.s.one('SELECT json FROM security_schedules WHERE id=?',identifier(body.id,'schedule'))?.json):null;requireValue(!body.id||old,'Security schedule not found');
    const area=this.requireArea(body.areaId??old?.areaId);this.editable(area);if(old&&old.areaId!==area.id)this.editable(this.requireArea(old.areaId));
    const days=body.days??old?.days??[1,2,3,4,5];requireValue(Array.isArray(days)&&days.length>0&&days.length<=7&&days.every(d=>Number.isInteger(d)&&d>=0&&d<=6)&&new Set(days).size===days.length,'Choose unique weekdays');
    const schedule={...(old||{id:uid(),lastRunKey:null,createdAt:this.now()}),areaId:area.id,name:text(body.name??old?.name??'Area schedule','Schedule name'),days:[...days].sort(),time:body.time??old?.time,timezone:timezone(body.timezone??old?.timezone??this.timezone),mode:body.mode??old?.mode??'away',enabled:bool(body.enabled??old?.enabled??false,'schedule enabled state'),updatedAt:this.now()};
    requireValue(typeof schedule.time==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time),'Choose a valid schedule time');requireValue(MODES.includes(schedule.mode),'Choose a valid scheduled mode');requireValue(old||this.schedules().length<512,'At most 512 schedules are supported');
    this.s.transaction(()=>{this.s.run('INSERT INTO security_schedules VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET area_id=excluded.area_id,json=excluded.json',schedule.id,schedule.areaId,JSON.stringify(schedule));this.event(old?'schedule_updated':'schedule_created',schedule.name+' '+(schedule.enabled?'enabled':'saved disabled')+' for '+schedule.time+' '+schedule.timezone,{areaId:area.id,actor});});return schedule;
  }
  removeSchedule(id,actor='System'){const schedule=parse(this.s.one('SELECT json FROM security_schedules WHERE id=?',identifier(id,'schedule'))?.json);requireValue(schedule,'Security schedule not found');this.editable(this.requireArea(schedule.areaId));this.s.transaction(()=>{this.s.run('DELETE FROM security_schedules WHERE id=?',id);this.event('schedule_removed',schedule.name+' removed',{areaId:schedule.areaId,actor});});}
  saveAction(input,actor='System'){
    const body=object(input,['id','name','areaId','kind','enabled','networkId','topic','payloadTemplate','subject','text','subscriptionIds']);
    const old=body.id?this.action(identifier(body.id,'action')):null;requireValue(!body.id||old,'Security action not found');
    const area=this.requireArea(body.areaId??old?.areaId);this.editable(area);if(old&&old.areaId!==area.id)this.editable(this.requireArea(old.areaId));
    const action={...(old||{id:uid(),createdAt:this.now()}),areaId:area.id,name:text(body.name??old?.name??'Security alert','Action name'),kind:body.kind??old?.kind??'mqtt',enabled:bool(body.enabled??old?.enabled??false,'action enabled state'),networkId:body.networkId??old?.networkId??'',topic:body.topic??old?.topic??'',payloadTemplate:body.payloadTemplate??old?.payloadTemplate??defaultSecurityPayload,subject:body.subject??old?.subject??'[Security] {{area}}',text:body.text??old?.text??'{{zone}} activated in {{area}} at {{timestamp}}. Incident: {{incidentId}}',updatedAt:this.now()};
    requireValue(['mqtt','email','push'].includes(action.kind),'Choose MQTT, email or browser push');
    if(action.kind==='push'){
      const ids=body.subscriptionIds??old?.subscriptionIds??[],available=new Set(securityPushRecipients(this.s).map(sub=>sub.id));
      requireValue(Array.isArray(ids)&&ids.length>0&&ids.length<=32&&ids.every(id=>typeof id==='string'&&id.length<=200&&available.has(id))&&new Set(ids).size===ids.length,'Choose 1–32 unique browsers with Security access enabled');
      action.subscriptionIds=[...ids];
    }else delete action.subscriptionIds;
    const allowed=new Set(['area','zone','device','event','timestamp','incidentId','mode']);
    for(const value of [action.payloadTemplate,action.subject,action.text]){requireValue(typeof value==='string'&&Buffer.byteLength(value,'utf8')<=8192&&!value.includes('\u0000'),'Security alert templates must be at most 8192 bytes');for(const match of value.matchAll(/\{\{([^{}]+)\}\}/g))requireValue(allowed.has(match[1]),'Unknown alert template field: '+match[1]);}
    requireValue(action.subject.trim().length>0&&action.subject.length<=200&&!/[\r\n]/.test(action.subject),'Email subject must be 1–200 characters without line breaks');
    if(action.kind==='email')requireValue(action.text.trim().length>0,'Enter an email alert message');
    let template;try{template=JSON.parse(action.payloadTemplate);}catch{throw Error('MQTT payload must be a JSON object');}requireValue(template&&typeof template==='object'&&!Array.isArray(template),'MQTT payload must be a JSON object');
    let nodes=0;const inspectTemplate=(value,depth=0)=>{requireValue(++nodes<=512&&depth<=8,'MQTT payload is too deeply nested or complex');requireValue(typeof value!=='number'||Number.isFinite(value),'MQTT payload numbers must be finite');if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){requireValue(!['__proto__','prototype','constructor'].includes(key),'Unsafe MQTT payload key');inspectTemplate(child,depth+1);}};inspectTemplate(template);
    if(action.kind==='mqtt'){
      requireValue(typeof action.topic==='string'&&action.topic.length>=1&&Buffer.byteLength(action.topic,'utf8')<=255&&!/[\s+#\u0000-\u0020\u007f]/.test(action.topic)&&!action.topic.startsWith('$')&&!action.topic.startsWith('/')&&!action.topic.endsWith('/')&&!/(?:^|\/)(?:set|get)(?:\/|$)|(?:^|\/)bridge\/request(?:\/|$)/i.test(action.topic),'Choose an alert topic without wildcards, whitespace or device command paths');
      requireValue(this.s.network(action.networkId),'Choose an existing broker');if(action.enabled)requireValue(this.s.network(action.networkId)?.enabled,'Enable the selected broker before enabling this alert');
    }else if(action.kind==='email'&&action.enabled)requireValue(this.s.get('email')?.enabled,'Enable SMTP email settings before enabling this alert');
    else if(action.kind==='push'&&action.enabled)requireValue(this.s.get('pushSettings')?.enabled,'Enable browser push delivery before enabling this alert');
    requireValue(old||this.actions().length<512,'At most 512 security actions are supported');
    this.s.transaction(()=>{this.s.run('INSERT INTO security_actions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET area_id=excluded.area_id,json=excluded.json',action.id,action.areaId,JSON.stringify(action));this.event(old?'action_updated':'action_created',action.name+' '+(action.enabled?'enabled':'saved disabled'),{areaId:area.id,actor});});return action;
  }
  removeAction(id,actor='System'){const action=this.action(id);requireValue(action,'Security action not found');this.editable(this.requireArea(action.areaId));this.s.transaction(()=>{this.s.run('DELETE FROM security_actions WHERE id=?',id);this.s.run("UPDATE security_deliveries SET status='suppressed',error='Action removed',finished_at=? WHERE action_id=? AND status='queued'",this.now(),id);this.s.run("UPDATE security_push_deliveries SET status='suppressed',error='Action removed',finished_at=? WHERE action_id=? AND status='queued'",this.now(),id);this.event('action_removed',action.name+' removed',{areaId:action.areaId,actor});});}
  isBypassed(zone){return zone.bypassAt!==null&&zone.bypassAt!==undefined&&(zone.bypassUntil===null||zone.bypassUntil>this.now());}
  isCycleBypassed(zone,area){return !!(area?.cycleId&&(area.mode!=='disarmed'||area.targetMode)&&area.cycleBypass?.cycleId===area.cycleId&&Array.isArray(area.cycleBypass.zoneIds)&&area.cycleBypass.zoneIds.includes(zone.id));}
  clearCycleBypass(area){const {cycleBypass,...rest}=area;return rest;}
  bypassZone(id,options,actor='System'){
    const zone=this.zone(id);requireValue(zone,'Security zone not found');const body=object(options,['durationMin','reason']);
    const reason=text(body.reason,'Bypass reason',300),duration=body.durationMin===null?null:integer(body.durationMin,1,525600,'bypass duration');
    zone.bypassAt=this.now();zone.bypassUntil=duration===null?null:this.now()+duration*MINUTE;zone.bypassReason=reason;
    this.s.transaction(()=>{this.s.run('UPDATE security_zones SET json=? WHERE id=?',JSON.stringify(zone),id);for(const areaId of zone.areaIds){const area=this.requireArea(areaId);if(area.pendingZoneId===id)this._saveArea({...area,entryAt:null,pendingZoneId:null});this.event('zone_bypassed',zone.name+' bypassed in all assigned areas: '+reason,{areaId,zoneId:id,actor});}});return this.zoneState(zone);
  }
  clearBypass(id,actor='System'){const zone=this.zone(id);requireValue(zone,'Security zone not found');requireValue(this.isBypassed(zone),'This zone is not bypassed');this._clearBypass(zone,actor,'zone_bypass_cleared');return this.zoneState(this.zone(id));}
  _clearBypass(zone,actor,type){zone.bypassAt=null;zone.bypassUntil=null;zone.bypassReason='';this.s.transaction(()=>{this.s.run('UPDATE security_zones SET json=? WHERE id=?',JSON.stringify(zone),zone.id);for(const areaId of zone.areaIds)this.event(type,zone.name+' bypass ended in all assigned areas. A fresh normal-to-active report is required to trigger.',{areaId,zoneId:zone.id,actor});});this.edges.delete(zone.id);}
  _source(device){const n=device&&this.s.network(device.networkId);return {network:n,available:!!(device&&!device.retiredAt&&!device.disabled&&device.inventoryPresent!==false&&device.availability!=='offline'&&n?.enabled&&n.connected&&n.mode!=='mqtt'&&n.bridgeState==='online')};}
  zoneView(zone,area=this.area(zone.areaId),mode=area?.targetMode||area?.mode||'disarmed'){
    const d=this.s.device(zone.deviceId),{network,available}=this._source(d),record=this.readings.get(zone.deviceId),reading=record?.values.get(zone.property),epoch=network?.connectedAt||0;
    const known=available&&record?.epoch===epoch&&!!reading&&scalar(reading.value)&&typeof reading.value===typeof zone.value&&reading.at>=epoch&&this.now()-reading.at<=zone.freshnessMin*MINUTE;
    const active=known?compare(reading.value,zone.operator,zone.value):null,manualBypassed=this.isBypassed(zone),cycleBypassed=this.isCycleBypassed(zone,area),bypassed=manualBypassed||cycleBypassed,homeExcluded=mode==='home'&&zone.homeBypass;
    let trouble=null;if(!d)trouble='Device missing';else if(d.retiredAt)trouble='Device retired';else if(d.disabled)trouble='Device disabled';else if(d.inventoryPresent===false)trouble='Missing from Zigbee inventory';else if(d.availability==='offline')trouble='Device offline';else if(!network?.enabled)trouble='Broker disabled or missing';else if(!network.connected)trouble='Broker offline';else if(network.mode==='mqtt')trouble='A Zigbee2MQTT device is required';else if(network.bridgeState!=='online')trouble='Zigbee bridge unavailable';else if(!known)trouble=reading&&record?.epoch===epoch?scalar(reading.value)&&typeof reading.value===typeof zone.value?'Zone reading is stale':'Sensor property is unavailable or has an unexpected type':'Awaiting a fresh sensor report';
    return {...zone,deviceName:d?.name||'Missing device',networkId:d?.networkId||null,networkLabel:network?.label||'Missing broker',observedValue:known?reading.value:null,lastReportAt:known?reading.at:null,known:!!known,active,status:!zone.enabled?'disabled':bypassed||homeExcluded?'bypassed':!available?'trouble':!known?'unknown':active?'active':'normal',bypassed,manualBypassed,cycleBypassed,homeExcluded,trouble,ready:!zone.enabled||bypassed||homeExcluded||known&&!active};
  }
  zoneState(zone){const views=zone.areaIds.map(id=>this.area(id)).filter(Boolean).map(area=>{const view=this.zoneView(zone,area);return {areaId:area.id,areaName:area.name,mode:area.mode,targetMode:area.targetMode,status:view.status,homeExcluded:view.homeExcluded,ready:view.ready,bypassed:view.bypassed,manualBypassed:view.manualBypassed,cycleBypassed:view.cycleBypassed,known:view.known,active:view.active,trouble:view.trouble};});return {...this.zoneView(zone),areaStates:views};}
  activeIncidents(areaId){return this.s.all('SELECT * FROM security_incidents WHERE reset_at IS NULL'+(areaId?' AND area_id=?':'')+' ORDER BY raised_at DESC',...(areaId?[areaId]:[])).map(row=>this.incidentView(row));}
  incidentView(row){return {...parse(row.json),id:row.id,areaId:row.area_id,zoneId:row.zone_id,cycleId:row.cycle_id,raisedAt:row.raised_at,ackAt:row.ack_at,ackBy:row.ack_by,restoredAt:row.restored_at,resetAt:row.reset_at};}
  readiness(area,mode='away'){
    const zones=this.zones().filter(z=>this.zoneInArea(z,area.id)&&z.enabled).map(z=>this.zoneView(z,area,mode)),blocking=zones.filter(z=>!z.ready),incidents=this.activeIncidents(area.id);
    const includedCount=zones.filter(zone=>!zone.bypassed&&!zone.homeExcluded).length;
    return {ready:area.enabled&&includedCount>0&&blocking.length===0&&incidents.length===0,blockingZones:blocking.map(z=>({id:z.id,name:z.name,status:z.status,trouble:z.trouble})),zoneCount:zones.length,includedCount,readyCount:zones.filter(z=>z.status==='normal').length,bypassedCount:zones.filter(z=>z.status==='bypassed').length,troubleCount:zones.filter(z=>['unknown','trouble'].includes(z.status)).length,activeAlarmCount:incidents.length};
  }
  areaView(area){
    const away=this.readiness(area,'away'),home=this.readiness(area,'home'),readiness=(area.targetMode||area.mode)==='home'?home:away,status=readiness.activeAlarmCount?'alarm':area.entryAt?'entry_delay':area.targetMode?'exit_delay':area.mode==='disarmed'?'disarmed':'armed';
    const cycleBypasses=this.zones().filter(zone=>this.zoneInArea(zone,area.id)&&this.isCycleBypassed(zone,area)).map(({id,name})=>({id,name}));
    return {...area,...readiness,readyAway:away.ready,readyHome:home.ready,status,cycleBypasses,cycleBypassCount:cycleBypasses.length,countdownSec:area.entryAt?Math.max(0,Math.ceil((area.entryAt-this.now())/1000)):area.exitAt?Math.max(0,Math.ceil((area.exitAt-this.now())/1000)):0};
  }
  armWithCycleBypass(areaId,zoneIds,reason,actor){
    const area=this.requireArea(areaId),ready=this.readiness(area,'away');
    requireValue(Array.isArray(zoneIds)&&zoneIds.length===new Set(zoneIds).size&&zoneIds.every(id=>typeof id==='string'),'Invalid cycle bypass selection');
    const blockers=ready.blockingZones.map(zone=>zone.id);requireValue(zoneIds.length===blockers.length&&zoneIds.every(id=>blockers.includes(id)),'The bypass list changed; review it again');
    return this._arm(area,'away',text(reason,'Bypass reason',300),actorName(actor),zoneIds);
  }
  _arm(area,mode,reason,actor,zoneIds=null){
    requireValue(area.enabled,'This security area is disabled');requireValue(area.mode==='disarmed'&&!area.targetMode,'This area is already armed or arming');
    const cycleId=uid(),cycleBypass=zoneIds?.length?{cycleId,zoneIds:[...zoneIds]}:null,candidate=cycleBypass?{...area,cycleId,cycleBypass,targetMode:mode}:area,ready=this.readiness(candidate,mode);
    requireValue(!ready.activeAlarmCount,'Reset alarm memory before arming this area');requireValue(ready.zoneCount>0,'Add an enabled zone before arming this area');requireValue(ready.includedCount>0,'At least one included zone must remain protected when arming');requireValue(ready.ready,'Area not ready: '+ready.blockingZones.map(z=>z.name+' ('+z.status+')').join(', '));
    area={...this.clearCycleBypass(area),cycleId,...(cycleBypass?{cycleBypass}:{}),targetMode:area.exitDelaySec?mode:null,exitAt:area.exitDelaySec?this.now()+area.exitDelaySec*1000:null,entryAt:null,pendingZoneId:null,mode:area.exitDelaySec?'disarmed':mode,armedAt:area.exitDelaySec?null:this.now()};
    this.s.transaction(()=>{this._saveArea(area);if(cycleBypass){const names=this.zones().filter(zone=>zoneIds.includes(zone.id)).map(zone=>zone.name);this.event('cycle_bypass_armed',area.name+' bypassed until disarm: '+names.join(', ')+'. Reason: '+reason,{areaId:area.id,actor});}this.event(area.exitDelaySec?'exit_started':'area_armed',area.name+(area.exitDelaySec?' exit delay started':' armed '+mode),{areaId:area.id,actor});});return this.areaView(area);
  }
  command(areaId,command,options={},actor='System'){
    if(command&&typeof command==='object'){actor=typeof options==='string'?options:actor;options=command;command=options.action;}
    object(options,['action','reason']);actor=actorName(actor);let area=this.requireArea(areaId);
    requireValue(['arm_away','arm_home','disarm','acknowledge','reset'].includes(command),'Choose a valid security command');
    if(command==='disarm'){
      this.s.transaction(()=>{this._saveArea(this.clearCycleBypass({...area,mode:'disarmed',targetMode:null,exitAt:null,entryAt:null,pendingZoneId:null,armedAt:null}));this.event('area_disarmed',area.name+' disarmed'+(options.reason?': '+text(options.reason,'Reason',300):''),{areaId,actor});});return this.areaView(this.requireArea(areaId));
    }
    if(command==='acknowledge'){
      this.s.transaction(()=>{this.s.run('UPDATE security_incidents SET ack_at=?,ack_by=? WHERE area_id=? AND reset_at IS NULL AND ack_at IS NULL',this.now(),actor,areaId);this.event('alarm_acknowledged',area.name+' alarm memory acknowledged',{areaId,actor});});return this.areaView(area);
    }
    if(command==='reset'){
      requireValue(area.mode==='disarmed'&&!area.targetMode,'Disarm this area before resetting alarm memory');
      requireValue(this.activeIncidents(areaId).every(incident=>incident.ackAt!==null),'Acknowledge every alarm in this area before resetting alarm memory');
      const active=this.zones().filter(z=>this.zoneInArea(z,areaId)&&z.enabled).map(z=>this.zoneView(z,area,'away')).filter(z=>!z.ready);
      requireValue(!active.length,'Restore or explicitly bypass active and unknown zones before resetting alarm memory');
      this.s.transaction(()=>{this.s.run('UPDATE security_incidents SET reset_at=? WHERE area_id=? AND reset_at IS NULL',this.now(),areaId);this._suppressArea(areaId,'Alarm memory reset');this.event('alarm_reset',area.name+' alarm memory reset',{areaId,actor});});return this.areaView(area);
    }
    return this._arm(area,command==='arm_home'?'home':'away',options.reason,actor);
  }
  _suppressArea(areaId,reason){this.s.run("UPDATE security_deliveries SET status='suppressed',error=?,finished_at=? WHERE status='queued' AND incident_id IN (SELECT id FROM security_incidents WHERE area_id=?)",reason,this.now(),areaId);this.s.run("UPDATE security_push_deliveries SET status='suppressed',error=?,finished_at=? WHERE status='queued' AND incident_id IN (SELECT id FROM security_incidents WHERE area_id=?)",reason,this.now(),areaId);}
  _boundProperties(deviceId,values){
    const configured=new Set(this.zones().filter(zone=>zone.deviceId===deviceId).map(zone=>zone.property));
    const entries=[...values].sort((a,b)=>Number(configured.has(b[0]))-Number(configured.has(a[0]))||b[1].at-a[1].at);
    return new Map(entries.slice(0,MAX_PROPERTIES));
  }
  _readingHistory(deviceId){
    const raw=this.s.one('SELECT json FROM security_readings WHERE device_id=?',deviceId)?.json;
    if(typeof raw!=='string'||raw.length>100000)return {values:[]};
    try{const history=JSON.parse(raw);if(!history||!Array.isArray(history.values))return {values:[]};const values=[];for(const pair of history.values.slice(0,MAX_PROPERTIES)){if(!Array.isArray(pair)||pair.length!==2||!pair[1]||!Number.isFinite(pair[1].at)||!scalar(pair[1].value))continue;try{property(pair[0]);values.push(pair);}catch{}}return {values,sampleAt:Number.isFinite(history.sampleAt)?history.sampleAt:null};}catch{return {values:[]};}
  }
  ingest(deviceId,payload,{retain=false,at=this.now(),dup=false}={}){
    if(retain||dup||!payload||typeof payload!=='object'||Array.isArray(payload)||!Number.isFinite(at)||at>this.now()+1000||at<this.now()-MINUTE)return;
    const d=this.s.device(deviceId),{network,available}=this._source(d);if(!available||at<(network.connectedAt||0))return;
    const epoch=network.connectedAt||0,history=this._readingHistory(deviceId),previousValues=new Map(history.values);
    // Optional Zigbee2MQTT sample timestamps reject an identifiable cached replay.
    // MQTT receipt alone cannot authenticate the physical sensor sample time.
    let sampleAt=null;if(own(payload,'last_seen')){const value=payload.last_seen;sampleAt=typeof value==='number'?(value<1e11?value*1000:value):typeof value==='string'?Date.parse(value):null;if(!Number.isFinite(sampleAt)||sampleAt<this.now()-MINUTE||sampleAt>this.now()+1000||sampleAt<(network.connectedAt||0)||history.sampleAt!=null&&sampleAt<history.sampleAt)return;}
    let record=this.readings.get(deviceId);if(!record||record.epoch!==epoch){record={epoch,values:new Map()};this.readings.set(deviceId,record);}
    let count=0;const reported=new Set(),walk=(node,prefix='',depth=0)=>{if(depth>4||count>=64)return;for(const [key,value] of Object.entries(node)){if(count>=64)break;const path=prefix?prefix+'.'+key:key;try{property(path);}catch{continue;}if(scalar(value)){count++;const old=record.values.get(path);if(!old||at>=old.at){record.values.set(path,{value,at});reported.add(path);}}else if(value&&typeof value==='object'&&!Array.isArray(value))walk(value,path,depth+1);}};walk(payload);
    // Explicit invalid detector values make the zone unknown immediately. Also
    // prioritize configured detectors if a device emits many unrelated fields.
    const deviceZones=this.zones().filter(zone=>zone.deviceId===deviceId&&zone.enabled);
    for(const zone of deviceZones){const current=sensorProperty(payload,zone.property);if(current.present){const previous=record.values.get(zone.property);if(!previous||at>=previous.at){record.values.set(zone.property,{value:scalar(current.value)?current.value:null,at});reported.add(zone.property);}}}
    record.values=this._boundProperties(deviceId,record.values);
    for(const zone of deviceZones){
      const reading=record.values.get(zone.property);if(!reading||!reported.has(zone.property))continue;
      const view=this.zoneView(zone),previous=this.edges.get(zone.id),persisted=previousValues.get(zone.property),previousActive=previous?.epoch===epoch?previous.active:persisted?compare(persisted.value,zone.operator,zone.value):null;
      this.edges.set(zone.id,{epoch,active:view.active,at});
      if(view.active===false)this.s.run('UPDATE security_incidents SET restored_at=coalesce(restored_at,?) WHERE zone_id=? AND reset_at IS NULL',at,zone.id);
      if(previousActive===true||view.active!==true||this.isBypassed(zone))continue;
      for(const areaId of zone.areaIds){const area=this.area(areaId);if(!area||!area.enabled||area.mode==='disarmed'||area.targetMode||this.isCycleBypassed(zone,area)||area.mode==='home'&&zone.homeBypass)continue;
        if(zone.type==='entry'&&area.entryDelaySec>0&&!this.activeIncidents(area.id).length){
          if(!area.entryAt){this._saveArea({...area,entryAt:at+area.entryDelaySec*1000,pendingZoneId:zone.id,pendingActivatedAt:at});this.event('entry_started',zone.name+' started the entry delay',{areaId:area.id,zoneId:zone.id});}
        }else this._trigger(area,zone,at);
      }
    }
    for(const [key,value] of record.values){const old=previousValues.get(key);if(!scalar(value.value))previousValues.delete(key);else if(!old||value.at>=old.at)previousValues.set(key,value);}
    this.s.run('INSERT INTO security_readings VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET json=excluded.json',deviceId,JSON.stringify({values:[...this._boundProperties(deviceId,previousValues)],epoch,sampleAt:Number.isFinite(sampleAt)?sampleAt:history.sampleAt??null}));
    // Bound unrelated-device discovery memory to the same inventory ceiling as collection.
    if(this.readings.size>4096)this.readings.delete(this.readings.keys().next().value);
  }
  _trigger(area,zone,at=this.now(),outputs=true){
    if(!this.zoneInArea(zone,area.id)||!area.enabled||area.mode==='disarmed'||!zone.enabled||this.isBypassed(zone)||this.isCycleBypassed(zone,area)||area.mode==='home'&&zone.homeBypass)return;
    if(this.s.one('SELECT id FROM security_incidents WHERE area_id=? AND zone_id=? AND cycle_id=?',area.id,zone.id,area.cycleId))return;
    const d=this.s.device(zone.deviceId),id=uid(),description=zone.name+' activated in armed '+area.name,view=this.zoneView(zone,area),details={areaName:area.name,zoneName:zone.name,deviceName:d?.name||zone.name,deviceId:zone.deviceId,networkId:d?.networkId||null,mode:area.mode,description,activatedAt:at};
    this.s.transaction(()=>{
      this.s.run('INSERT INTO security_incidents(id,area_id,zone_id,cycle_id,raised_at,restored_at,json) VALUES(?,?,?,?,?,?,?)',id,area.id,zone.id,area.cycleId,this.now(),view.active===false?this.now():null,JSON.stringify(details));
      const eventId=this.event('intrusion',description,{areaId:area.id,zoneId:zone.id,incidentId:id});
      this._saveArea({...this.requireArea(area.id),entryAt:null,pendingZoneId:null});
      const context={eventId:String(eventId),incidentId:id,areaId:area.id,area:area.name,zoneId:zone.id,zone:zone.name,deviceId:zone.deviceId,device:d?.name||zone.name,networkId:d?.networkId||null,raisedAt:this.now(),timestamp:new Date(this.now()).toISOString(),mode:area.mode,event:'intrusion',type:'intrusion'};
      if(outputs&&!this.demo)for(const action of this.actions().filter(action=>action.areaId===area.id&&action.enabled)){
        const deliveryId=uid();this.s.run("INSERT OR IGNORE INTO security_deliveries VALUES(?,?,?,?,'queued',NULL,NULL,?,?)",deliveryId,id,action.id,this.now(),JSON.stringify(action),JSON.stringify(context));
        if(action.kind==='push')for(const subscriptionId of action.subscriptionIds){
          const sub=this.s.one('SELECT id,user_id,endpoint_hash,label,disabled_at FROM push_subscriptions WHERE id=?',subscriptionId),eligible=this.s.get('pushSettings')?.enabled===true&&sub&&!sub.disabled_at&&pushAccountActive(this.s,sub,'viewSecurity');
          this.s.run('INSERT OR IGNORE INTO security_push_deliveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',uid(),deliveryId,id,action.id,subscriptionId,sub?.user_id||null,sub?.endpoint_hash||'',sub?.label||'Unavailable browser','alarm',this.now(),eligible?'queued':'suppressed',eligible?null:'Browser or push delivery was unavailable when the alarm was raised',eligible?null:this.now());
        }
      }
    });
  }
  tick(){
    const now=this.now(),gap=now-this.lastTickAt;this.lastTickAt=now;
    for(const zone of this.zones())if(zone.bypassAt!=null&&zone.bypassUntil!==null&&zone.bypassUntil<=now)this._clearBypass(zone,'System','zone_bypass_expired');
    for(const area of this.areas()){
      if(area.targetMode&&area.exitAt<=now){
        const ready=this.readiness(area,area.targetMode);
        if(ready.ready){this._saveArea({...area,mode:area.targetMode,targetMode:null,exitAt:null,armedAt:now});this.event('area_armed',area.name+' armed '+area.targetMode,{areaId:area.id});}
        else {this._saveArea(this.clearCycleBypass({...area,mode:'disarmed',targetMode:null,exitAt:null,armedAt:null}));this.event('arm_blocked',area.name+' did not arm: '+(ready.blockingZones.map(z=>z.name).join(', ')||'alarm memory or no enabled zones'),{areaId:area.id});}
      }
      const latest=this.area(area.id);if(latest.entryAt&&latest.entryAt<=now){const zone=this.zone(latest.pendingZoneId);if(zone)this._trigger(latest,zone,latest.pendingActivatedAt||now);this._saveArea({...this.requireArea(area.id),entryAt:null,pendingZoneId:null});}
    }
    const minute=Math.floor(now/MINUTE);
    if(minute!==this.lastMinute){const timely=minute-this.lastMinute===1&&gap>=0&&gap<=15000;this.lastMinute=minute;if(timely)this._runSchedules();}
    if(now-this.lastPrune>=3600000){this.prune();this.lastPrune=now;}
  }
  _runSchedules(){
    for(const schedule of this.schedules().filter(s=>s.enabled)){
      const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:schedule.timezone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(this.now()).map(part=>[part.type,part.value]));
      const day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday),time=parts.hour+':'+parts.minute,key=parts.year+'-'+parts.month+'-'+parts.day+'T'+time;
      if(!schedule.days.includes(day)||time!==schedule.time||schedule.lastRunKey===key)continue;
      // Wall-clock key deliberately omits UTC offset: repeated DST minutes run once.
      schedule.lastRunKey=key;this.s.run('UPDATE security_schedules SET json=? WHERE id=?',JSON.stringify(schedule),schedule.id);
      try{this.command(schedule.areaId,schedule.mode==='disarmed'?'disarm':'arm_'+schedule.mode,{},'Schedule');this.event('schedule_executed',schedule.name+' executed '+schedule.mode,{areaId:schedule.areaId,actor:'Schedule'});}
      catch(error){this.event('schedule_blocked',schedule.name+' was blocked: '+error.message,{areaId:schedule.areaId,actor:'Schedule'});}
    }
  }
  queuedActions(limit=10){integer(limit,1,100,'delivery batch');return this.s.all("SELECT * FROM security_deliveries WHERE status='queued' ORDER BY created_at,id LIMIT ?",limit).map(row=>this.deliveryView(row));}
  deliveryView(row){return {id:row.id,incidentId:row.incident_id,actionId:row.action_id,createdAt:row.created_at,status:row.status,error:row.error,finishedAt:row.finished_at,action:parse(row.action_json),context:parse(row.context_json)};}
  claimAction(id){
    if(this.demo)return null;const row=this.s.one("SELECT * FROM security_deliveries WHERE id=? AND status='queued'",identifier(id,'delivery'));if(!row)return null;
    const incident=this.s.one('SELECT * FROM security_incidents WHERE id=?',row.incident_id),action=this.action(row.action_id),area=incident&&this.area(incident.area_id);
    if(this.now()-row.created_at>5*MINUTE){this.s.run("UPDATE security_deliveries SET status='suppressed',error='Alert expired before delivery',finished_at=? WHERE id=?",this.now(),id);this.s.run("UPDATE security_push_deliveries SET status='suppressed',error='Alert expired before delivery',finished_at=? WHERE delivery_id=? AND status='queued'",this.now(),id);return null;}
    if(!incident||incident.reset_at||!action?.enabled||!area?.enabled||JSON.stringify(action)!==row.action_json){this.s.run("UPDATE security_deliveries SET status='suppressed',error='Alarm reset, area disabled or action changed',finished_at=? WHERE id=?",this.now(),id);this.s.run("UPDATE security_push_deliveries SET status='suppressed',error='Alarm reset, area disabled or action changed',finished_at=? WHERE delivery_id=? AND status='queued'",this.now(),id);return null;}
    if(action.kind==='email'&&!this.s.get('email')?.enabled||action.kind==='mqtt'&&!this.s.network(action.networkId)?.enabled||action.kind==='push'&&!this.s.get('pushSettings')?.enabled){this.s.run("UPDATE security_deliveries SET status='suppressed',error='Configured output is disabled or unavailable',finished_at=? WHERE id=?",this.now(),id);this.s.run("UPDATE security_push_deliveries SET status='suppressed',error='Configured output is disabled or unavailable',finished_at=? WHERE delivery_id=? AND status='queued'",this.now(),id);return null;}
    this.s.run("UPDATE security_deliveries SET status='delivering' WHERE id=? AND status='queued'",id);return this.deliveryView({...row,status:'delivering'});
  }
  finishAction(id,status,error=null){requireValue(['accepted','uncertain','suppressed'].includes(status),'Invalid delivery result');const job=this.s.one("SELECT * FROM security_deliveries WHERE id=? AND status='delivering'",id);requireValue(job,'Delivery is not in progress');const message=status==='uncertain'?'Delivery not confirmed. No automatic retry.':status==='suppressed'?'No eligible browser delivery remained':null;this.s.transaction(()=>{this.s.run('UPDATE security_deliveries SET status=?,error=?,finished_at=? WHERE id=?',status,message,this.now(),id);this.s.run("UPDATE security_push_deliveries SET status='suppressed',error='Parent delivery completed without another attempt',finished_at=? WHERE delivery_id=? AND status='queued'",this.now(),id);this.event(status==='accepted'?'output_accepted':status==='suppressed'?'output_suppressed':'output_uncertain',parse(job.action_json).name+': '+(status==='accepted'?'accepted':status==='suppressed'?'suppressed':'not confirmed; no automatic retry'),{areaId:parse(job.context_json).areaId,incidentId:job.incident_id});});}
  async deliver(send){
    if(this.delivering||this.demo)return;this.delivering=true;
    try{for(const queued of this.queuedActions()){const job=this.claimAction(queued.id);if(!job)continue;try{const result=await send(job.action,job.context,job);this.finishAction(job.id,result?.status==='suppressed'?'suppressed':'accepted');}catch{this.finishAction(job.id,'uncertain');}}}finally{this.delivering=false;}
  }
  prune(){
    const days=this.s.get('thresholds')?.retentionDays||90,cutoff=this.now()-days*DAY;
    this.s.transaction(()=>{this.s.run('DELETE FROM security_push_deliveries WHERE incident_id IN (SELECT id FROM security_incidents WHERE reset_at IS NOT NULL AND reset_at<?) OR (kind=\'test\' AND created_at<?)',cutoff,cutoff);this.s.run('DELETE FROM security_deliveries WHERE incident_id IN (SELECT id FROM security_incidents WHERE reset_at IS NOT NULL AND reset_at<?)',cutoff);this.s.run('DELETE FROM security_events WHERE at<? AND (incident_id IS NULL OR incident_id NOT IN (SELECT id FROM security_incidents WHERE reset_at IS NULL))',cutoff);this.s.run('DELETE FROM security_incidents WHERE reset_at IS NOT NULL AND reset_at<?',cutoff);});
  }
  state(){
    const areas=this.areas().map(area=>this.areaView(area)),zones=this.zones().map(zone=>this.zoneState(zone)),networks=this.s.networks().map(n=>({id:n.id,label:n.label,enabled:n.enabled,connected:n.connected,mode:n.mode||'zigbee2mqtt'}));
    const devices=this.s.devices().filter(d=>!d.retiredAt&&!d.disabled&&this.s.network(d.networkId)?.mode!=='mqtt').map(d=>{const {network,available}=this._source(d),record=this.readings.get(d.id),properties=record?.epoch===(network?.connectedAt||0)?[...record.values].filter(([,value])=>scalar(value.value)).map(([key,value])=>({property:key,value:value.value,type:typeof value.value})):[];return {id:d.id,name:d.name,ieee:/^0x[0-9a-f]{16}$/i.test(d.ieee)?d.ieee:'',networkId:d.networkId,networkLabel:network?.label||'Missing broker',room:d.room||'',model:d.model||'',available,properties};});
    const incidents=[...this.s.all('SELECT * FROM security_incidents WHERE reset_at IS NULL ORDER BY raised_at DESC'),...this.s.all('SELECT * FROM security_incidents WHERE reset_at IS NOT NULL ORDER BY raised_at DESC LIMIT 200')].map(row=>this.incidentView(row));
    const events=this.s.all('SELECT * FROM security_events ORDER BY at DESC,id DESC LIMIT 200').map(row=>({id:row.id,at:row.at,areaId:row.area_id,zoneId:row.zone_id,incidentId:row.incident_id,type:row.type,actor:row.actor,message:row.message}));
    const deliveries=this.s.all('SELECT * FROM security_deliveries ORDER BY created_at DESC,id DESC LIMIT 100').map(row=>{const job=this.deliveryView(row),results=job.action.kind==='push'?this.s.all('SELECT id,label,status,error,created_at AS createdAt,finished_at AS finishedAt FROM security_push_deliveries WHERE delivery_id=? ORDER BY created_at,id',job.id):undefined;return {...job,action:undefined,context:undefined,name:job.action.name,kind:job.action.kind,areaId:job.context.areaId,...(results?{results}:{})};});
    return {now:this.now(),at:this.now(),timezone:this.timezone,demo:this.demo,areas,zones,schedules:this.schedules(),actions:this.actions(),incidents,events,deliveries,devices,candidates:devices,networks,securityPushRecipients:securityPushRecipients(this.s),securityPushSettings:{enabled:this.s.get('pushSettings')?.enabled===true,includeDeviceNames:this.s.get('pushSettings')?.includeDeviceNames===true},summary:{areas:areas.length,armed:areas.filter(a=>a.mode!=='disarmed').length,alarms:incidents.filter(i=>!i.resetAt).length,unacknowledged:incidents.filter(i=>!i.resetAt&&!i.ackAt).length,trouble:zones.filter(z=>z.enabled&&['unknown','trouble'].includes(z.status)).length,bypassed:zones.filter(z=>z.status==='bypassed').length}};
  }
}
