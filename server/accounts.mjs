import crypto from 'node:crypto';

export const roles=Object.freeze(['admin','operator','viewer']);
const PASSWORD_OPTIONS={N:32768,r:8,p:3,maxmem:64*1024*1024};
const dto=row=>row?{id:row.id,username:row.username,displayName:row.display_name,role:row.role,enabled:!!row.enabled,authVersion:row.auth_version,createdAt:row.created_at,updatedAt:row.updated_at,lastLoginAt:row.last_login_at}:null;
const username=value=>{
  if(typeof value!=='string')throw Error('Enter a username');
  const result=value.trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(result))throw Error('Username must be 3–64 letters, numbers, dots, underscores or hyphens');
  return result;
};
const displayName=value=>{if(typeof value!=='string'||!value.trim()||value.trim().length>100)throw Error('Display name must be 1–100 characters');return value.trim();};
const role=value=>{if(!roles.includes(value))throw Error('Choose Admin, Operator or Viewer');return value;};
const password=value=>{if(typeof value!=='string'||value.length<12||value.length>128)throw Error('Password must be 12–128 characters');return value;};
const encodePassword=value=>{const salt=crypto.randomBytes(16).toString('hex');return {salt,hash:crypto.scryptSync(password(value),salt,32,PASSWORD_OPTIONS).toString('hex')};};
const verifyPassword=(value,row)=>{
  // Unknown and disabled users use an equally expensive dummy verification.
  const supplied=typeof value==='string'&&value.length<=128?value:'';
  const candidate=crypto.scryptSync(supplied,row.password_salt,32,PASSWORD_OPTIONS);
  return crypto.timingSafeEqual(candidate,Buffer.from(row.password_hash,'hex'))&&supplied===value;
};

export class Accounts{
  constructor(store,{password:initialPassword='',clock=()=>Date.now()}={}){
    this.s=store;this.clock=clock;
    const dummy=encodePassword(crypto.randomBytes(24).toString('hex'));
    this.dummy={password_salt:dummy.salt,password_hash:dummy.hash};
    this.s.transaction(()=>{
      if(this.count()){if(!this.s.get('accountsInitialised'))this.s.set('accountsInitialised',true);return;}
      if(this.s.get('accountsInitialised')||!initialPassword)return;
      const secret=encodePassword(initialPassword),now=this.clock(),id=crypto.randomUUID();
      this.s.run('INSERT INTO users(id,username,display_name,role,enabled,password_salt,password_hash,auth_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,'admin','Administrator','admin',1,secret.salt,secret.hash,1,now,now);
      this.s.run('UPDATE push_subscriptions SET user_id=? WHERE user_id IS NULL',id);
      this.s.set('accountsInitialised',true);
      this.s.event('administrator_created','Initial administrator account created',{actor:'System',at:now});
    });
  }
  // Once initialised, an unexpectedly empty registry stays locked rather than reopening preview access.
  active(){return this.s.get('accountsInitialised')===true||this.count()>0;}
  count(){return this.s.one('SELECT count(*) n FROM users').n;}
  list(){return this.s.all('SELECT * FROM users ORDER BY username').map(dto);}
  get(id){return typeof id==='string'?dto(this.s.one('SELECT * FROM users WHERE id=?',id)):null;}
  requireUser(id){const user=this.s.one('SELECT * FROM users WHERE id=?',typeof id==='string'?id:'');if(!user)throw Error('User not found');return user;}
  authenticate(name,suppliedPassword){
    let key='';try{key=username(name);}catch{}
    const row=this.s.one('SELECT * FROM users WHERE username=?',key);
    const valid=verifyPassword(suppliedPassword,row?.enabled?row:this.dummy);
    if(!valid||!row?.enabled)return null;
    this.s.run('UPDATE users SET last_login_at=? WHERE id=?',this.clock(),row.id);
    return this.get(row.id);
  }
  create(body,actor='System'){
    const name=username(body.username),label=displayName(body.displayName===undefined?name:body.displayName),access=role(body.role===undefined?'viewer':body.role);
    if(body.enabled!==undefined&&typeof body.enabled!=='boolean')throw Error('User enabled state must be on or off');
    const secret=encodePassword(body.password),enabled=body.enabled!==false,id=crypto.randomUUID(),now=this.clock();
    return this.s.transaction(()=>{
      if(this.s.one('SELECT id FROM users WHERE username=?',name))throw Error('Username is already in use');
      if(!this.active())throw Error('Configure the initial administrator before adding users');
      this.s.run('INSERT INTO users(id,username,display_name,role,enabled,password_salt,password_hash,auth_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,name,label,access,enabled?1:0,secret.salt,secret.hash,1,now,now);
      this.s.event('user_created','User '+name+' created as '+access,{actor,at:now});
      return this.get(id);
    });
  }
  invalidate(id){
    this.s.run('UPDATE users SET auth_version=auth_version+1,updated_at=? WHERE id=?',this.clock(),id);
    this.s.run('DELETE FROM auth_sessions WHERE user_id=?',id);
  }
  update(body,actor='System'){
    if(body.username!==undefined)throw Error('Usernames cannot be changed');
    return this.s.transaction(()=>{
      const old=this.requireUser(body.id),label=body.displayName===undefined?old.display_name:displayName(body.displayName),access=body.role===undefined?old.role:role(body.role);
      if(body.enabled!==undefined&&typeof body.enabled!=='boolean')throw Error('User enabled state must be on or off');
      const enabled=body.enabled===undefined?!!old.enabled:body.enabled;
      if(old.enabled&&old.role==='admin'&&(!enabled||access!=='admin')&&this.s.one("SELECT count(*) n FROM users WHERE role='admin' AND enabled=1").n<=1)throw Error('Keep at least one enabled administrator');
      this.s.run('UPDATE users SET display_name=?,role=?,enabled=?,updated_at=? WHERE id=?',label,access,enabled?1:0,this.clock(),old.id);
      if(old.role!==access||!!old.enabled!==enabled)this.invalidate(old.id);
      if(!enabled){
        this.s.run("UPDATE push_subscriptions SET disabled_at=coalesce(disabled_at,?),last_error='Account disabled' WHERE user_id=?",this.clock(),old.id);
        this.s.run("UPDATE push_outbox SET status='suppressed',error='Account disabled',finished_at=? WHERE status='queued' AND subscription_id IN (SELECT id FROM push_subscriptions WHERE user_id=?)",this.clock(),old.id);
      }
      this.s.event('user_updated','User '+old.username+' updated ('+access+', '+(enabled?'enabled':'disabled')+')',{actor,at:this.clock()});
      return this.get(old.id);
    });
  }
  changePassword(id,currentPassword,newPassword){
    const old=this.requireUser(id);
    if(!old.enabled||!verifyPassword(currentPassword,old))throw Error('Current password is incorrect');
    const secret=encodePassword(newPassword);
    return this.s.transaction(()=>{
      const current=this.requireUser(id);
      if(!current.enabled||current.auth_version!==old.auth_version)throw Error('Account changed; sign in again');
      this.s.run('UPDATE users SET password_salt=?,password_hash=? WHERE id=?',secret.salt,secret.hash,id);
      this.invalidate(id);
      this.s.event('password_changed','Password changed for '+old.username,{actor:old.username,at:this.clock()});
      return this.get(id);
    });
  }
  resetPassword(body,actor='System'){
    const secret=encodePassword(body.password);
    return this.s.transaction(()=>{
      const old=this.requireUser(body.id);
      this.s.run('UPDATE users SET password_salt=?,password_hash=? WHERE id=?',secret.salt,secret.hash,old.id);
      this.invalidate(old.id);
      this.s.event('password_reset','Password reset for '+old.username,{actor,at:this.clock()});
      return this.get(old.id);
    });
  }
  revokeSessions(id,actor='System'){
    return this.s.transaction(()=>{
      const old=this.requireUser(id);this.invalidate(id);
      this.s.event('user_sessions_revoked','Sessions revoked for '+old.username,{actor,at:this.clock()});
      return this.get(id);
    });
  }
}
