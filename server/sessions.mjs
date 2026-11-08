import crypto from 'node:crypto';

export const sessionSeconds={normal:12*3600,remembered:30*86400};
const tokenHash=token=>crypto.createHash('sha256').update(token).digest('hex');
const validToken=token=>typeof token==='string'&&/^[a-f0-9]{64}$/.test(token);

export class Sessions{
  constructor(store,password,{clock=()=>Date.now()}={}){
    this.s=store;this.clock=clock;this.memory=new Map();
    // Stable across restarts, changes with the configured password or credential key.
    this.credentialTag=crypto.createHmac('sha256',store.encryptionKey).update('zigbee-health-session-v1\0').update(password).digest('hex');
    this.prune();
  }
  prune(){
    const now=this.clock();
    this.s.run('DELETE FROM auth_sessions WHERE expires_at<=? OR credential_tag<>?',now,this.credentialTag);
    for(const [key,expires] of this.memory)if(expires<=now)this.memory.delete(key);
    this.nextPruneAt=now+3600000;
  }
  issue(rememberMe=false){
    if(typeof rememberMe!=='boolean')throw Error('Stay signed in must be on or off');
    this.prune();const token=crypto.randomBytes(32).toString('hex'),key=tokenHash(token),seconds=rememberMe?sessionSeconds.remembered:sessionSeconds.normal,now=this.clock(),expires=now+seconds*1000;
    if(rememberMe)this.s.run('INSERT INTO auth_sessions(token_hash,credential_tag,created_at,expires_at) VALUES(?,?,?,?)',key,this.credentialTag,now,expires);
    else this.memory.set(key,expires);
    return {token,seconds};
  }
  valid(token){
    if(!validToken(token))return false;
    const now=this.clock();if(now>=this.nextPruneAt)this.prune();
    const key=tokenHash(token),expires=this.memory.get(key)||this.s.one('SELECT expires_at FROM auth_sessions WHERE token_hash=? AND credential_tag=?',key,this.credentialTag)?.expires_at;
    if(expires>now)return true;
    this.revoke(token);return false;
  }
  revoke(token){if(!validToken(token))return;const key=tokenHash(token);this.memory.delete(key);this.s.run('DELETE FROM auth_sessions WHERE token_hash=?',key);}
}
