import crypto from 'node:crypto';
import {hasPermission} from './accounts.mjs';

const OPTIONS={N:32768,r:8,p:1,maxmem:64*1024*1024};
const allowed=(condition,message,statusCode=400)=>{if(!condition)throw new KeypadError(message,statusCode);};
const keys=(input,names)=>{allowed(input&&typeof input==='object'&&!Array.isArray(input),'Provide keypad fields');allowed(Object.keys(input).every(name=>names.includes(name)),'Unknown keypad field');return input;};

export class KeypadError extends Error{
  constructor(message,statusCode=400,retryAfter=0){super(message);this.statusCode=statusCode;this.retryAfter=retryAfter;}
}

/** Authenticated residential keypad. PIN authority is evaluated on every command. */
export class Keypad{
  constructor(store,security,accounts,{clock=()=>Date.now()}={}){
    this.s=store;this.security=security;this.accounts=accounts;this.clock=clock;
    this.s.db.exec(`CREATE TABLE IF NOT EXISTS security_keypad_pins(user_id TEXT PRIMARY KEY,lookup_tag TEXT NOT NULL UNIQUE,salt TEXT NOT NULL,hash TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS security_keypad_access(user_id TEXT PRIMARY KEY,area_ids TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_keypad_throttle(scope TEXT PRIMARY KEY,failures INTEGER NOT NULL,blocked_until INTEGER NOT NULL,last_at INTEGER NOT NULL);`);
    this.dummySalt=this.mac('dummy-salt').slice(0,32);
    this.dummyHash=this.derive('dummy-not-a-pin',this.dummySalt);
  }
  now(){return this.clock();}
  mac(value){return crypto.createHmac('sha256',this.s.encryptionKey).update('zigbee-keypad-v1\0'+value).digest('hex');}
  tag(pin){return this.mac('lookup\0'+pin);}
  derive(pin,salt){return crypto.scryptSync(this.mac('verify\0'+pin),salt,32,OPTIONS).toString('hex');}
  freshUser(id){return this.accounts.get(id);}
  areaIds(user){
    const areas=this.security.areas(),known=new Set(areas.map(area=>area.id));
    if(user?.role==='admin')return areas.map(area=>area.id);
    const raw=this.s.one('SELECT area_ids FROM security_keypad_access WHERE user_id=?',user?.id||'')?.area_ids;
    if(!raw)return [];try{const ids=JSON.parse(raw);return Array.isArray(ids)&&ids.length<=64&&ids.every(id=>typeof id==='string')&&new Set(ids).size===ids.length?ids.filter(id=>known.has(id)):[];}catch{return [];}
  }
  settings(id,{admin=false}={}){
    const user=this.freshUser(id);allowed(user,'User not found');
    const canControl=hasPermission(user,'controlSecurity'),areaIds=admin||hasPermission(user,'viewSecurity')?this.areaIds(user):[],visible=admin?this.security.areas():this.security.areas().filter(area=>areaIds.includes(area.id));
    return {userId:user.id,pinSet:!!this.s.one('SELECT user_id FROM security_keypad_pins WHERE user_id=?',user.id),enabled:user.enabled,canControl,allAreas:user.role==='admin',areaIds,areas:visible.map(({id,name})=>({id,name}))};
  }
  state(sessionUser){
    if(this.security.demo&&!this.accounts.active())return {now:this.now(),timezone:this.security.timezone,areas:this.security.areas().map(area=>({...this.security.areaView(area),canArmAway:false})),canArm:false,readOnly:true,ownPin:{configured:false,areaIds:[],allAreas:false},message:'Sign in with an authenticated account to use the keypad.'};
    const user=this.freshUser(sessionUser.id);allowed(hasPermission(user,'viewSecurity'),'Security access is required',403);
    const settings=this.settings(user.id);
    return {now:this.now(),timezone:this.security.timezone,areas:this.security.areas().map(area=>{const view=this.security.areaView(area);return {...view,canArmAway:!!(hasPermission(user,'controlSecurity')&&area.mode==='disarmed'&&!area.targetMode&&view.readyAway)};}),canArm:hasPermission(user,'controlSecurity'),readOnly:false,ownPin:{configured:settings.pinSet,areaIds:settings.areaIds,allAreas:settings.allAreas}};
  }
  checkThrottle(scope){
    const row=this.s.one('SELECT blocked_until,last_at FROM security_keypad_throttle WHERE scope=?',scope),now=this.now();
    if(row&&row.blocked_until>now)throw new KeypadError('Too many attempts. Try again later.',429,Math.max(1,Math.ceil((row.blocked_until-now)/1000)));
  }
  failed(scope){
    const row=this.s.one('SELECT failures,last_at FROM security_keypad_throttle WHERE scope=?',scope),previous=row&&this.now()-row.last_at<1800000?row.failures:0,failures=Math.min(32,previous+1),delay=failures>=5?Math.min(900000,60000*2**Math.min(4,failures-5)):0;
    this.s.run('INSERT INTO security_keypad_throttle VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET failures=excluded.failures,blocked_until=excluded.blocked_until,last_at=excluded.last_at',scope,failures,this.now()+delay,this.now());
  }
  clearThrottle(scope){this.s.run('DELETE FROM security_keypad_throttle WHERE scope=?',scope);}
  validatePin(pin){allowed(typeof pin==='string'&&/^\d{4}$/.test(pin),'Enter a four-digit PIN');}
  validateAreas(value){
    const known=new Set(this.security.areas().map(area=>area.id));
    allowed(Array.isArray(value)&&value.length<=64&&value.every(id=>typeof id==='string'&&known.has(id))&&new Set(value).size===value.length,'Choose valid areas without duplicates');return [...value];
  }
  writePin(id,pin){
    this.validatePin(pin);const tag=this.tag(pin),existing=this.s.one('SELECT user_id FROM security_keypad_pins WHERE lookup_tag=?',tag);
    allowed(!existing||existing.user_id===id,'This PIN cannot be used. Choose a different PIN.');
    const salt=crypto.randomBytes(16).toString('hex'),hash=this.derive(pin,salt);
    this.s.run('INSERT INTO security_keypad_pins VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET lookup_tag=excluded.lookup_tag,salt=excluded.salt,hash=excluded.hash,updated_at=excluded.updated_at',id,tag,salt,hash,this.now());
  }
  saveOwn(sessionUser,input){
    const body=keys(input,['currentPassword','operation','pin']),user=this.freshUser(sessionUser.id);allowed(user?.enabled,'Account is unavailable');
    allowed(['set','remove'].includes(body.operation),'Choose set or remove');if(body.operation==='set'){allowed(hasPermission(user,'controlSecurity'),'Security control access is required to set a PIN',403);this.validatePin(body.pin);}else allowed(body.pin===undefined,'Do not include a PIN when removing it');
    const scope='setup:'+user.id;this.checkThrottle(scope);
    if(!this.accounts.verifyCurrentPassword(user.id,body.currentPassword)){this.failed(scope);throw new KeypadError('Current password is incorrect');}
    this.s.transaction(()=>{if(body.operation==='set')this.writePin(user.id,body.pin);else this.s.run('DELETE FROM security_keypad_pins WHERE user_id=?',user.id);this.clearThrottle(scope);this.security.event(body.operation==='set'?'keypad_pin_set':'keypad_pin_removed','Own keypad PIN '+(body.operation==='set'?'updated':'removed'),{actor:user.username});});
    return this.settings(user.id);
  }
  saveUser(sessionUser,input){
    const actor=this.freshUser(sessionUser.id);allowed(actor?.enabled&&actor.role==='admin','Administrator access is required',403);
    const body=keys(input,['id','operation','areaIds','pin']),user=this.freshUser(body.id);allowed(user,'User not found');allowed(['save','set','remove'].includes(body.operation),'Choose a valid keypad setting operation');
    if(body.operation==='save')allowed(body.areaIds!==undefined,'Choose the assigned areas');
    if(body.operation==='set')this.validatePin(body.pin);else allowed(body.pin===undefined,'Do not include a PIN for this operation');
    const areaIds=body.areaIds===undefined?null:this.validateAreas(body.areaIds);
    this.s.transaction(()=>{
      if(areaIds!==null){if(user.role==='admin')this.s.run('DELETE FROM security_keypad_access WHERE user_id=?',user.id);else this.s.run('INSERT INTO security_keypad_access VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET area_ids=excluded.area_ids',user.id,JSON.stringify(areaIds));}
      if(body.operation==='set')this.writePin(user.id,body.pin);if(body.operation==='remove')this.s.run('DELETE FROM security_keypad_pins WHERE user_id=?',user.id);
      this.security.event('keypad_user_settings_changed','Keypad settings updated for '+user.username,{actor:actor.username});
    });return this.settings(user.id,{admin:true});
  }
  rejected(sessionUser){this.failed('pin');this.security.event('keypad_pin_rejected','Keypad disarm attempt rejected',{actor:sessionUser.username});throw new KeypadError('PIN is invalid or does not permit the selected areas',403);}
  pinUser(pin){
    const valid=typeof pin==='string'&&/^\d{4}$/.test(pin),found=valid?this.s.one('SELECT * FROM security_keypad_pins WHERE lookup_tag=?',this.tag(pin)):null,row=found&&/^[a-f0-9]{32}$/.test(found.salt)&&/^[a-f0-9]{64}$/.test(found.hash)?found:null;
    const candidate=this.derive(valid?pin:'invalid-pin',row?.salt||this.dummySalt),expected=row?.hash||this.dummyHash;
    const matched=crypto.timingSafeEqual(Buffer.from(candidate,'hex'),Buffer.from(expected,'hex'));
    return matched&&row?this.freshUser(row.user_id):null;
  }
  command(sessionUser,input){
    const body=keys(input,['action','areaIds','all','pin']),session=this.freshUser(sessionUser.id);allowed(hasPermission(session,'viewSecurity'),'Security access is required',403);allowed(['arm_away','disarm'].includes(body.action),'Choose Arm Away or Disarm');
    allowed(body.all===undefined||typeof body.all==='boolean','All areas must be on or off');allowed(!(body.all===true&&body.areaIds!==undefined),'Choose selected areas or all areas');
    const explicit=body.all===true?null:this.validateAreas(body.areaIds);if(explicit)allowed(explicit.length>0,'Select at least one area');
    let actor=session,areaIds=explicit;
    if(body.action==='arm_away'){
      allowed(hasPermission(session,'controlSecurity'),'Security control access is required',403);allowed(body.pin===undefined,'Arming does not require a PIN');if(body.all===true)areaIds=this.security.areas().map(area=>area.id);
    }else{
      this.checkThrottle('pin');actor=this.pinUser(body.pin);
      if(!hasPermission(actor,'controlSecurity'))return this.rejected(session);
      const authorized=this.areaIds(actor);if(body.all===true)areaIds=authorized;
      if(!areaIds?.length||areaIds.some(id=>!authorized.includes(id)))return this.rejected(session);
    }
    allowed(areaIds?.length>0,'No areas are available');
    const areas=areaIds.map(id=>this.security.requireArea(id));
    if(body.action==='arm_away')for(const area of areas){const ready=this.security.readiness(area,'away');allowed(area.mode==='disarmed'&&!area.targetMode,'Disarm '+area.name+' before arming it again');allowed(ready.ready,'Area not ready: '+area.name);}
    const results=this.s.transaction(()=>{
      const currentSession=this.freshUser(session.id);allowed(hasPermission(currentSession,body.action==='arm_away'?'controlSecurity':'viewSecurity'),'Your session permissions changed',403);
      if(body.action==='disarm'){const currentActor=this.freshUser(actor.id),authorized=this.areaIds(currentActor);if(!hasPermission(currentActor,'controlSecurity')||areaIds.some(id=>!authorized.includes(id)))throw new KeypadError('PIN is invalid or does not permit the selected areas',403);}
      const result=areaIds.map(id=>this.security.command(id,body.action,{reason:'Keypad via signed-in user '+session.username},actor.username));
      // A valid low-scope PIN cannot reset the shared guessing budget for other
      // users' PINs. Failures decay only after a quiet thirty-minute interval.
      return result;
    });return {ok:true,action:body.action,areaIds,areas:results};
  }
}
