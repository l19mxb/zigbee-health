import {createHash,randomUUID} from 'node:crypto';
import {generateVAPIDKeys,sendNotification} from 'web-push';
import {labels} from './engine.mjs';

const providers=new Set(['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com']);
export function validatePublicOrigin(value){
  if(value==='')return '';
  let url;try{url=new URL(value);}catch{throw Error('Enter the HTTPS app address');}
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||value.length>300)throw Error('Use an HTTPS app address without a path, query or password');
  return url.origin;
}
export function validateSubscription(value){
  if(!value||typeof value!=='object'||JSON.stringify(value).length>5000)throw Error('Invalid browser subscription');
  let url;try{url=new URL(value.endpoint);}catch{throw Error('Invalid browser push endpoint');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port||!(providers.has(url.hostname)||/^[a-z0-9.-]+\.notify\.windows\.com$/.test(url.hostname)))throw Error('Unsupported browser push provider');
  const key=(s,length)=>typeof s==='string'&&/^[A-Za-z0-9_-]+={0,2}$/.test(s)&&Buffer.from(s,'base64url').length===length;
  if(!key(value.keys?.p256dh,65)||Buffer.from(value.keys.p256dh,'base64url')[0]!==4||!key(value.keys?.auth,16))throw Error('Invalid browser encryption keys');
  return {endpoint:url.href,expirationTime:Number.isFinite(value.expirationTime)?value.expirationTime:null,keys:{p256dh:value.keys.p256dh,auth:value.keys.auth}};
}
const hash=value=>createHash('sha256').update(value).digest('hex');
export class PushService{
  constructor(engine,{send=sendNotification}={}){this.e=engine;this.s=engine.s;this.send=send;this.delivering=false;}
  settings(){return {enabled:false,recovery:true,includeDeviceNames:false,...this.s.get('pushSettings')};}
  status(userId=null,admin=true){const keys=this.s.get('pushVapid'),restricted=userId&&!admin;return {...this.settings(),publicOrigin:this.s.get('web')?.publicOrigin||'',publicKey:keys?.publicKey||null,simulation:this.e.demo,subscriptions:this.s.all('SELECT id,label,created_at,updated_at,disabled_at,last_success_at,last_error FROM push_subscriptions'+(restricted?' WHERE user_id=?':'')+' ORDER BY created_at DESC',...(restricted?[userId]:[])),deliveries:this.s.all('SELECT id,subscription_id,kind,created_at,status,error,finished_at FROM push_outbox'+(restricted?' WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE user_id=?)':'')+' ORDER BY created_at DESC LIMIT 50',...(restricted?[userId]:[]))};}
  owned(id,userId,admin){const sub=this.s.one('SELECT * FROM push_subscriptions WHERE id=?',id);if(!sub||userId&&!admin&&sub.user_id!==userId)throw Error('Browser subscription not found');return sub;}
  accountActive(sub){return sub.user_id?!!this.s.one('SELECT id FROM users WHERE id=? AND enabled=1',sub.user_id):!this.s.get('accountsInitialised');}
  configure(input,actor){
    if(typeof input.enabled!=='boolean'||typeof input.recovery!=='boolean'||typeof input.includeDeviceNames!=='boolean')throw Error('Invalid push settings');
    const origin=validatePublicOrigin(String(input.publicOrigin||'')),oldOrigin=this.s.get('web')?.publicOrigin||'';
    if(input.enabled&&(this.e.demo||!origin))throw Error(this.e.demo?'Push delivery is disabled in simulation':'Set the HTTPS app address before enabling push');
    this.s.transaction(()=>{
      this.s.set('web',{publicOrigin:origin});this.s.set('pushSettings',{enabled:input.enabled,recovery:input.recovery,includeDeviceNames:input.includeDeviceNames});
      if(input.enabled&&!this.s.get('pushVapid')){const pair=generateVAPIDKeys();this.s.set('pushVapid',{publicKey:pair.publicKey,privateKey:this.s.seal(pair.privateKey)});}
      if(oldOrigin!==origin)this.s.run("UPDATE push_subscriptions SET disabled_at=?,last_error='App address changed; enable notifications again' WHERE disabled_at IS NULL",this.e.now());
      if(oldOrigin!==origin||!input.enabled)this.s.run("UPDATE push_outbox SET status='suppressed',finished_at=? WHERE status='queued'",this.e.now());
      this.s.event('push_settings_changed','App address or browser notification settings updated',{actor,at:this.e.now()});
    });
  }
  subscribe(value,label,actor,userId=null){
    if(this.e.demo||!this.settings().enabled)throw Error('Push delivery is disabled');
    const subscription=validateSubscription(value),endpointHash=hash(subscription.endpoint),now=this.e.now(),old=this.s.one('SELECT * FROM push_subscriptions WHERE endpoint_hash=?',endpointHash),id=old?.id||randomUUID();
    if(old?.user_id&&old.user_id!==userId)throw Error('This browser belongs to another user; an administrator must remove its registration first');
    if(userId&&!this.s.one('SELECT id FROM users WHERE id=? AND enabled=1',userId))throw Error('User account is unavailable');
    if(typeof label!=='string'||!label.trim()||label.length>80)throw Error('Enter a browser/device name of up to 80 characters');
    this.s.transaction(()=>{
      this.s.run('INSERT INTO push_subscriptions(id,endpoint_hash,json,label,created_at,updated_at,user_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(endpoint_hash) DO UPDATE SET json=excluded.json,label=excluded.label,updated_at=excluded.updated_at,disabled_at=NULL,last_error=NULL,user_id=excluded.user_id',id,endpointHash,this.s.seal(JSON.stringify(subscription)),label.trim(),now,now,userId);
      // Enrolment does not replay an existing alarm backlog. A future rearm has a new generation.
      for(const i of this.s.all('SELECT * FROM incidents WHERE processed_at IS NULL'))this.s.run("INSERT OR IGNORE INTO push_outbox VALUES(?,?,?,?,?,?,'suppressed','Predates browser enrolment',?)",randomUUID(),i.id,id,'alarm',i.rearm,now,now);
      this.s.event('push_browser_enabled','Browser notifications enabled for '+label.trim(),{actor,at:now});
    });return {id};
  }
  remove(id,actor,userId=null,admin=true){
    const sub=this.owned(id,userId,admin);
    this.s.transaction(()=>{this.s.run('DELETE FROM push_outbox WHERE subscription_id=?',id);this.s.run('DELETE FROM push_subscriptions WHERE id=?',id);this.s.event('push_browser_removed','Browser notifications removed for '+sub.label,{actor,at:this.e.now()});});
  }
  eligible(i,kind,rearm){
    if(!i||i.resolution)return false;const n=this.s.network(i.network_id),d=i.device_id?this.s.device(i.device_id):null;
    if(!n?.enabled||d?.retiredAt||d?.disabled||this.e.isShunted(i))return false;
    if(kind==='recovery')return !!i.restored_at;
    const condition=this.s.one('SELECT last_known FROM conditions WHERE scope=? AND category=?',i.device_id||'network:'+i.network_id,i.category);
    return !i.restored_at&&!i.processed_at&&!i.ack_at&&i.rearm===rearm&&(!i.device_id||this.e.sourceStatus(n)==='online')&&!(i.category==='bridge'&&!n.connected)&&condition?.last_known===1;
  }
  queue(){
    if(this.e.demo||!this.settings().enabled)return;
    for(const sub of this.s.all('SELECT id,user_id FROM push_subscriptions WHERE disabled_at IS NULL').filter(sub=>this.accountActive(sub)))for(const i of this.s.all('SELECT * FROM incidents WHERE processed_at IS NULL')){
      if(this.eligible(i,'alarm',i.rearm))this.s.run("INSERT OR IGNORE INTO push_outbox VALUES(?,?,?,?,?,?,'queued',NULL,NULL)",randomUUID(),i.id,sub.id,'alarm',i.rearm,this.e.now());
      if(this.settings().recovery&&this.eligible(i,'recovery',i.rearm)&&this.s.one("SELECT id FROM push_outbox WHERE subscription_id=? AND incident_id=? AND kind='alarm' AND status='accepted'",sub.id,i.id))this.s.run("INSERT OR IGNORE INTO push_outbox VALUES(?,?,?,?,?,?,'queued',NULL,NULL)",randomUUID(),i.id,sub.id,'recovery',i.rearm,this.e.now());
    }
  }
  async test(id,userId=null,admin=true){
    if(this.e.demo||!this.settings().enabled)throw Error('Push delivery is disabled');
    const sub=this.owned(id,userId,admin);if(sub.disabled_at||!this.accountActive(sub))throw Error('Browser is unavailable');
    if(this.s.one("SELECT id FROM push_outbox WHERE subscription_id=? AND kind='test' AND created_at>?",id,this.e.now()-60000))throw Error('Wait one minute before another test');
    const job={id:randomUUID(),incident_id:null,subscription_id:id,kind:'test',rearm:0,created_at:this.e.now()};
    this.s.run("INSERT INTO push_outbox VALUES(?,?,?,?,?,?,'queued',NULL,NULL)",job.id,null,id,'test',0,job.created_at);await this.deliver();
    return this.s.one('SELECT status,error FROM push_outbox WHERE id=?',job.id);
  }
  payload(i,kind){
    if(kind==='test')return {title:'Zigbee Health',body:'Browser notifications are set up.',tag:'zigbee-health-test',url:'/',alarmId:null};
    const detail=this.settings().includeDeviceNames?i.description:labels[i.category]+(kind==='recovery'?' restored.':' detected.')+' Open the alarm viewer to review.';
    return {title:'Zigbee Health'+(kind==='recovery'?' · Restored':''),body:detail.slice(0,240),tag:'zh-'+i.id,url:'/?alarm='+encodeURIComponent(i.id),alarmId:i.id};
  }
  deliver(){
    if(this.delivery)return this.delivery;
    if(this.stopping||this.e.demo||!this.settings().enabled)return Promise.resolve();
    this.delivery=this.flush().finally(()=>{this.delivery=null;});return this.delivery;
  }
  async close(){this.stopping=true;await this.delivery;}
  async flush(){
    this.delivering=true;
    try{
      const pair=this.s.get('pushVapid'),origin=this.s.get('web')?.publicOrigin;if(!pair||!origin)return;
      for(const job of this.s.all("SELECT * FROM push_outbox WHERE status='queued' ORDER BY created_at LIMIT 10")){
        if(this.stopping)break;
        const sub=this.s.one('SELECT * FROM push_subscriptions WHERE id=? AND disabled_at IS NULL',job.subscription_id),i=job.incident_id?this.s.one('SELECT * FROM incidents WHERE id=?',job.incident_id):null;
        if(!sub||!this.accountActive(sub)||this.e.now()-job.created_at>300000||job.kind!=='test'&&!this.eligible(i,job.kind,job.rearm)){this.s.run("UPDATE push_outbox SET status='suppressed',finished_at=? WHERE id=?",this.e.now(),job.id);continue;}
        this.s.run("UPDATE push_outbox SET status='delivering' WHERE id=?",job.id);
        try{
          const subscription=validateSubscription(JSON.parse(this.s.unseal(sub.json)));
          await this.send(subscription,JSON.stringify(this.payload(i,job.kind)),{vapidDetails:{subject:origin+'/',publicKey:pair.publicKey,privateKey:this.s.unseal(pair.privateKey)},TTL:300,urgency:i?.priority==='critical'?'high':'normal',timeout:10000});
          this.s.run("UPDATE push_outbox SET status='accepted',finished_at=? WHERE id=?",this.e.now(),job.id);this.s.run('UPDATE push_subscriptions SET last_success_at=?,last_error=NULL WHERE id=?',this.e.now(),sub.id);
        }catch(error){
          const expired=[404,410].includes(error.statusCode),message=expired?'Browser subscription expired; enable it again':'Push delivery was not confirmed. No automatic retry.';
          this.s.run("UPDATE push_outbox SET status=?,error=?,finished_at=? WHERE id=?",expired?'expired':'uncertain',message,this.e.now(),job.id);
          this.s.run('UPDATE push_subscriptions SET last_error=?,disabled_at=CASE WHEN ? THEN ? ELSE disabled_at END WHERE id=?',message,expired?1:0,this.e.now(),sub.id);
        }
      }
    }finally{this.delivering=false;}
  }
}
