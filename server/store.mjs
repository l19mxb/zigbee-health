import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {rolePermissions} from './accounts.mjs';

export const defaults={retentionDays:90,lowBattery:20,batteryRecovery:25,weakSignal:60,signalRecovery:80,mainsTimeoutMin:60,batteryTimeoutMin:1500,faultDelaySec:120,recoveryDelaySec:60,dropoutCount:3,dropoutWindowHours:24};
export const parse=value=>value?JSON.parse(value):null;
export class Store {
  constructor(file=':memory:'){
    this.file=file;
    if(file!==':memory:')fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS networks(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,network_id TEXT NOT NULL,ieee TEXT NOT NULL,name TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(network_id,ieee));
      CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY,device_id TEXT,network_id TEXT NOT NULL,category TEXT NOT NULL,priority TEXT NOT NULL,opened_at INTEGER NOT NULL,restored_at INTEGER,ack_at INTEGER,ack_by TEXT,processed_at INTEGER,rearm INTEGER NOT NULL DEFAULT 0,description TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS incident_scope ON incidents(network_id,device_id,category,restored_at);
      CREATE INDEX IF NOT EXISTS incident_time ON incidents(opened_at);
      CREATE TABLE IF NOT EXISTS conditions(scope TEXT NOT NULL,category TEXT NOT NULL,since INTEGER,recover_since INTEGER,last_known INTEGER,PRIMARY KEY(scope,category));
      CREATE TABLE IF NOT EXISTS shunts(id TEXT PRIMARY KEY,scope_type TEXT NOT NULL,scope_id TEXT NOT NULL,category TEXT,created_at INTEGER NOT NULL,expires_at INTEGER,cancelled_at INTEGER,expired_at INTEGER,reason TEXT NOT NULL,actor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,device_id TEXT,network_id TEXT,type TEXT NOT NULL,message TEXT NOT NULL,actor TEXT NOT NULL,incident_id TEXT);
      CREATE INDEX IF NOT EXISTS event_device_time ON events(device_id,at);
      CREATE TABLE IF NOT EXISTS samples(device_id TEXT NOT NULL,bucket INTEGER NOT NULL,lqi_sum REAL NOT NULL DEFAULT 0,lqi_count INTEGER NOT NULL DEFAULT 0,lqi_min REAL,lqi_max REAL,battery_min REAL,report_count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(device_id,bucket));
      CREATE INDEX IF NOT EXISTS sample_time ON samples(bucket);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,incident_id TEXT NOT NULL,kind TEXT NOT NULL,rearm INTEGER NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL,error TEXT,finished_at INTEGER,UNIQUE(incident_id,kind,rearm));`);
    if(!this.all('PRAGMA table_info(incidents)').some(c=>c.name==='resolution'))this.db.exec('ALTER TABLE incidents ADD COLUMN resolution TEXT');
    this.db.exec('CREATE TABLE IF NOT EXISTS device_links(id TEXT PRIMARY KEY,source_id TEXT NOT NULL UNIQUE,target_id TEXT NOT NULL,kind TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS link_target ON device_links(target_id)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions(id TEXT PRIMARY KEY,endpoint_hash TEXT NOT NULL UNIQUE,json TEXT NOT NULL,label TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,disabled_at INTEGER,last_success_at INTEGER,last_error TEXT);
      CREATE TABLE IF NOT EXISTS push_outbox(id TEXT PRIMARY KEY,incident_id TEXT,subscription_id TEXT NOT NULL,kind TEXT NOT NULL,rearm INTEGER NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL,error TEXT,finished_at INTEGER,UNIQUE(incident_id,subscription_id,kind,rearm));
      CREATE INDEX IF NOT EXISTS push_outbox_status ON push_outbox(status,created_at);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL COLLATE NOCASE UNIQUE,display_name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer')),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,auth_version INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,last_login_at INTEGER,permissions TEXT);
      CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY,credential_tag TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,user_id TEXT,auth_version INTEGER);
      CREATE INDEX IF NOT EXISTS auth_session_expiry ON auth_sessions(expires_at)`);
    const sessionColumns=this.all('PRAGMA table_info(auth_sessions)').map(c=>c.name);
    if(!this.all('PRAGMA table_info(users)').some(c=>c.name==='permissions'))this.db.exec('ALTER TABLE users ADD COLUMN permissions TEXT');
    for(const [access,permissions] of Object.entries(rolePermissions))this.run('UPDATE users SET permissions=? WHERE permissions IS NULL AND role=?',JSON.stringify(permissions),access);
    if(!sessionColumns.includes('user_id'))this.db.exec('ALTER TABLE auth_sessions ADD COLUMN user_id TEXT');
    if(!sessionColumns.includes('auth_version'))this.db.exec('ALTER TABLE auth_sessions ADD COLUMN auth_version INTEGER');
    // Legacy sessions have no accountable identity and cannot migrate into an administrator session.
    this.run('DELETE FROM auth_sessions WHERE user_id IS NULL OR auth_version IS NULL');
    this.db.exec('CREATE INDEX IF NOT EXISTS auth_session_user ON auth_sessions(user_id)');
    if(!this.all('PRAGMA table_info(push_subscriptions)').some(c=>c.name==='user_id'))this.db.exec('ALTER TABLE push_subscriptions ADD COLUMN user_id TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS push_subscription_user ON push_subscriptions(user_id)');
    this.run("UPDATE push_outbox SET status='uncertain',error='Service stopped during delivery; no automatic retry' WHERE status='delivering'");
    this.db.prepare("UPDATE outbox SET status='uncertain',error='Service stopped during delivery; review before resending' WHERE status='delivering'").run();
    if(!this.get('thresholds'))this.set('thresholds',defaults);
    if(!this.get('createdAt'))this.set('createdAt',Date.now());
    if(file===':memory:')this.encryptionKey=crypto.randomBytes(32);
    else {const keyFile=path.join(path.dirname(file),'secrets.key');if(!fs.existsSync(keyFile))fs.writeFileSync(keyFile,crypto.randomBytes(32),{flag:'wx',mode:0o600});this.encryptionKey=fs.readFileSync(keyFile);if(this.encryptionKey.length!==32)throw Error('Invalid secret key file');}
  }
  all(sql,...args){return this.db.prepare(sql).all(...args);}
  one(sql,...args){return this.db.prepare(sql).get(...args);}
  run(sql,...args){return this.db.prepare(sql).run(...args);}
  get(key){return parse(this.one('SELECT value FROM settings WHERE key=?',key)?.value);}
  set(key,value){this.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify(value));}
  networks(){return this.all('SELECT json FROM networks').map(r=>parse(r.json));}
  network(id){return parse(this.one('SELECT json FROM networks WHERE id=?',id)?.json);}
  saveNetwork(n){this.run('INSERT INTO networks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json',n.id,JSON.stringify(n));}
  devices(networkId){return (networkId?this.all('SELECT json FROM devices WHERE network_id=?',networkId):this.all('SELECT json FROM devices')).map(r=>parse(r.json));}
  device(id){return parse(this.one('SELECT json FROM devices WHERE id=?',id)?.json);}
  saveDevice(d){this.run('INSERT INTO devices VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,json=excluded.json',d.id,d.networkId,d.ieee,d.name,JSON.stringify(d));}
  event(type,message,{deviceId=null,networkId=null,actor='System',incidentId=null,at=Date.now()}={}){this.run('INSERT INTO events(at,device_id,network_id,type,message,actor,incident_id) VALUES(?,?,?,?,?,?,?)',at,deviceId,networkId,type,message,actor,incidentId);}
  transaction(fn){
    // Nested operations use savepoints, allowing a multi-area keypad command to
    // commit or roll back as one unit without weakening each command's own guard.
    const depth=this.transactionDepth||0,name='zh_nested_'+depth;
    this.db.exec(depth?'SAVEPOINT '+name:'BEGIN IMMEDIATE');this.transactionDepth=depth+1;
    try{const result=fn();this.db.exec(depth?'RELEASE SAVEPOINT '+name:'COMMIT');return result;}
    catch(error){if(depth){this.db.exec('ROLLBACK TO SAVEPOINT '+name);this.db.exec('RELEASE SAVEPOINT '+name);}else this.db.exec('ROLLBACK');throw error;}
    finally{this.transactionDepth=depth;}
  }
  seal(value){if(!value)return '';const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',this.encryptionKey,iv);const encrypted=Buffer.concat([c.update(value,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),encrypted]).toString('base64');}
  unseal(value){if(!value)return '';const b=Buffer.from(value,'base64'),c=crypto.createDecipheriv('aes-256-gcm',this.encryptionKey,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return Buffer.concat([c.update(b.subarray(28)),c.final()]).toString('utf8');}
  close(){this.db.close();}
}

export function validateThresholds(input,base=defaults){
  const value={...base};
  const bounds={retentionDays:[1,3650],lowBattery:[0,99],batteryRecovery:[1,100],weakSignal:[0,254],signalRecovery:[1,255],mainsTimeoutMin:[1,43200],batteryTimeoutMin:[1,43200],faultDelaySec:[0,86400],recoveryDelaySec:[0,86400],dropoutCount:[2,100],dropoutWindowHours:[1,168]};
  for(const [key,v] of Object.entries(input)){if(!bounds[key]||!Number.isFinite(v)||!Number.isInteger(v)||v<bounds[key][0]||v>bounds[key][1])throw Error('Invalid threshold: '+key);value[key]=v;}
  if(value.batteryRecovery<=value.lowBattery||value.signalRecovery<=value.weakSignal)throw Error('Recovery thresholds must exceed their alarm thresholds');
  return value;
}
