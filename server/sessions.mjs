import crypto from 'node:crypto';

export const sessionSeconds={normal:12*3600,remembered:30*86400};
const tokenHash=token=>crypto.createHash('sha256').update(token).digest('hex');
const validToken=token=>typeof token==='string'&&/^[a-f0-9]{64}$/.test(token);

export class Sessions{
  constructor(store,accounts,{clock=()=>Date.now()}={}){
    if(!accounts||typeof accounts.get!=='function')throw Error('Sessions require an account registry');
    this.s=store;this.accounts=accounts;this.clock=clock;this.memory=new Map();
    this.credentialTag=crypto.createHmac('sha256',store.encryptionKey).update('zigbee-health-user-sessions-v2').digest('hex');
    this.prune();
  }
  prune(){
    const now=this.clock();
    this.s.run('DELETE FROM auth_sessions WHERE expires_at<=? OR credential_tag<>? OR user_id IS NULL OR auth_version IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE users.id=auth_sessions.user_id AND users.enabled=1 AND users.auth_version=auth_sessions.auth_version)',now,this.credentialTag);
    for(const [key,record] of this.memory)if(record.expires_at<=now)this.memory.delete(key);
    this.nextPruneAt=now+3600000;
  }
  issue(rememberMe=false,user){
    if(typeof rememberMe!=='boolean')throw Error('Stay signed in must be on or off');
    const current=this.accounts.get(user?.id);
    if(!current?.enabled||current.authVersion!==user.authVersion)throw Error('Sign in with an active account');
    this.prune();const token=crypto.randomBytes(32).toString('hex'),key=tokenHash(token),seconds=rememberMe?sessionSeconds.remembered:sessionSeconds.normal,now=this.clock(),expires=now+seconds*1000;
    if(rememberMe)this.s.run('INSERT INTO auth_sessions(token_hash,credential_tag,created_at,expires_at,user_id,auth_version) VALUES(?,?,?,?,?,?)',key,this.credentialTag,now,expires,current.id,current.authVersion);
    else this.memory.set(key,{user_id:current.id,auth_version:current.authVersion,expires_at:expires});
    return {token,seconds};
  }
  current(token){
    if(!validToken(token))return null;
    const now=this.clock();if(now>=this.nextPruneAt)this.prune();
    const key=tokenHash(token),record=this.memory.get(key)||this.s.one('SELECT user_id,auth_version,expires_at FROM auth_sessions WHERE token_hash=? AND credential_tag=?',key,this.credentialTag);
    if(record?.expires_at>now){const user=this.accounts.get(record.user_id);if(user?.enabled&&user.authVersion===record.auth_version)return user;}
    this.revoke(token);return null;
  }
  valid(token){return !!this.current(token);}
  revoke(token){if(!validToken(token))return;const key=tokenHash(token);this.memory.delete(key);this.s.run('DELETE FROM auth_sessions WHERE token_hash=?',key);}
  revokeUser(id){for(const [key,record] of this.memory)if(record.user_id===id)this.memory.delete(key);this.s.run('DELETE FROM auth_sessions WHERE user_id=?',id);}
}
