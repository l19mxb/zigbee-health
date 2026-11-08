import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../server/store.mjs';
import {Accounts} from '../server/accounts.mjs';
import {Sessions} from '../server/sessions.mjs';

const password='synthetic-account-password';
const replacement='different-synthetic-password';
function fixture(){let now=1794000000000;const s=new Store(),accounts=new Accounts(s,{password,clock:()=>now}),sessions=new Sessions(s,accounts,{clock:()=>now});return {s,accounts,sessions,admin:accounts.authenticate('admin',password),advance:ms=>now+=ms,close:()=>s.close()};}
const viewer=f=>f.accounts.create({username:'viewer',displayName:'Test Viewer',password},'admin');

test('bootstrap creates admin with the existing password and exposes no credential material',()=>{
  const f=fixture();try{
    assert.equal(f.accounts.count(),1);assert.equal(f.accounts.active(),true);
    assert.equal(f.admin.username,'admin');assert.equal(f.admin.displayName,'Administrator');assert.equal(f.admin.role,'admin');assert.equal(f.admin.enabled,true);
    const raw=f.s.one('SELECT * FROM users'),safe=JSON.stringify(f.accounts.list());
    assert.match(raw.password_salt,/^[a-f0-9]{32}$/);assert.match(raw.password_hash,/^[a-f0-9]{64}$/);
    for(const value of [password,raw.password_hash,raw.password_salt,'password_hash','password_salt'])assert.equal(safe.includes(value),false);
    assert.equal(JSON.stringify(f.s.all('SELECT * FROM events')).includes(password),false);
  }finally{f.close();}
});

test('an existing registry ignores changed bootstrap passwords and an unexpectedly empty registry stays locked',()=>{
  const f=fixture();try{
    const next=new Accounts(f.s,{password:replacement});assert.equal(next.count(),1);
    assert.equal(next.authenticate('admin',replacement),null);assert.ok(next.authenticate('admin',password));
    f.s.run('DELETE FROM users');const empty=new Accounts(f.s,{password:replacement});
    assert.equal(empty.active(),true);assert.equal(empty.count(),0);assert.equal(empty.authenticate('admin',replacement),null);
  }finally{f.close();}
});

test('a fresh password-free local preview does not silently create an administrator',()=>{
  const s=new Store();try{const a=new Accounts(s);assert.equal(a.active(),false);assert.equal(a.count(),0);assert.throws(()=>a.create({username:'example',password},'admin'),/initial administrator/);assert.equal(a.count(),0);}finally{s.close();}
});

test('new accounts default to Viewer; usernames are normalized, unique, bounded and immutable',()=>{
  const f=fixture();try{
    const user=f.accounts.create({username:'  Mixed.Case  ',password},'admin');assert.equal(user.username,'mixed.case');assert.equal(user.role,'viewer');assert.equal(user.displayName,'mixed.case');
    assert.ok(f.accounts.authenticate('MIXED.CASE',password));
    assert.throws(()=>f.accounts.create({username:'mixed.case',password},'admin'),/already in use/);
    for(const name of ['ab','.abc','bad name','a'.repeat(65),'../x'])assert.throws(()=>f.accounts.create({username:name,password},'admin'),/Username/);
    assert.throws(()=>f.accounts.update({id:user.id,username:'changed'},'admin'),/cannot be changed/);
    assert.throws(()=>f.accounts.create({username:'other',password,role:'owner'},'admin'),/Choose/);
    assert.throws(()=>f.accounts.create({username:'other',password,enabled:'yes'},'admin'),/enabled state/);
  }finally{f.close();}
});

test('passwords have independent random salts and length bounds; unknown and wrong credentials are rejected',()=>{
  const f=fixture();try{
    const user=viewer(f),raw=f.s.one('SELECT * FROM users WHERE id=?',user.id),admin=f.s.one('SELECT * FROM users WHERE id=?',f.admin.id);
    assert.notEqual(raw.password_salt,admin.password_salt);assert.notEqual(raw.password_hash,admin.password_hash);
    for(const value of ['short','a'.repeat(129),null,1234])assert.throws(()=>f.accounts.resetPassword({id:user.id,password:value},'admin'),/12–128/);
    for(const [name,value] of [['missing',password],['viewer','wrong'],['viewer',undefined],['viewer','a'.repeat(129)]])assert.equal(f.accounts.authenticate(name,value),null);
    assert.equal(f.accounts.get(user.id).authVersion,1);
  }finally{f.close();}
});

test('the last enabled administrator cannot be demoted or disabled, including with another disabled admin present',()=>{
  const f=fixture();try{
    f.accounts.create({username:'inactive-admin',role:'admin',enabled:false,password},'admin');
    for(const change of [{role:'viewer'},{enabled:false},{role:'operator',enabled:false}])assert.throws(()=>f.accounts.update({id:f.admin.id,...change},'admin'),/at least one enabled administrator/);
    assert.equal(f.accounts.get(f.admin.id).role,'admin');assert.equal(f.accounts.get(f.admin.id).enabled,true);
    const second=f.accounts.create({username:'second-admin',role:'admin',password},'admin');
    f.accounts.update({id:f.admin.id,role:'viewer'},'admin');
    assert.throws(()=>f.accounts.update({id:second.id,enabled:false},'second-admin'),/at least one enabled administrator/);
  }finally{f.close();}
});

test('disable and re-enable invalidate both normal and remembered sessions permanently',()=>{
  const f=fixture();try{
    const user=viewer(f),normal=f.sessions.issue(false,user),remembered=f.sessions.issue(true,user);
    f.accounts.update({id:user.id,enabled:false},'admin');
    assert.equal(f.accounts.authenticate('viewer',password),null);assert.equal(f.sessions.valid(normal.token),false);assert.equal(f.sessions.valid(remembered.token),false);
    assert.equal(f.s.one('SELECT count(*) n FROM auth_sessions WHERE user_id=?',user.id).n,0);
    f.accounts.update({id:user.id,enabled:true},'admin');assert.ok(f.accounts.authenticate('viewer',password));
    assert.equal(f.sessions.valid(normal.token),false);assert.equal(f.sessions.valid(remembered.token),false);
  }finally{f.close();}
});

test('role changes revoke stale sessions, and session resolution always returns the current role and name',()=>{
  const f=fixture();try{
    const user=viewer(f),normal=f.sessions.issue(false,user),remembered=f.sessions.issue(true,user);
    f.accounts.update({id:user.id,displayName:'New Name'},'admin');assert.equal(f.sessions.current(normal.token).displayName,'New Name');
    f.accounts.update({id:user.id,role:'operator'},'admin');assert.equal(f.sessions.valid(normal.token),false);assert.equal(f.sessions.valid(remembered.token),false);
    assert.throws(()=>f.sessions.issue(true,user),/active account/);
    const fresh=f.accounts.authenticate('viewer',password);assert.equal(f.sessions.current(f.sessions.issue(false,fresh).token).role,'operator');
  }finally{f.close();}
});

test('disabling a user suppresses its queued push jobs and reenabling does not reactivate subscriptions',()=>{
  const f=fixture();try{
    const user=viewer(f);
    for(const [id,owner] of [['viewer-phone',user.id],['admin-phone',f.admin.id]]){
      f.s.run('INSERT INTO push_subscriptions(id,endpoint_hash,json,label,created_at,updated_at,user_id) VALUES(?,?,?,?,?,?,?)',id,id,'{}',id,1,1,owner);
      f.s.run('INSERT INTO push_outbox(id,incident_id,subscription_id,kind,rearm,created_at,status) VALUES(?,?,?,?,?,?,?)',id,null,id,'test',0,1,'queued');
    }
    f.accounts.update({id:user.id,enabled:false},'admin');
    assert.ok(f.s.one('SELECT disabled_at FROM push_subscriptions WHERE id=?','viewer-phone').disabled_at);
    assert.equal(f.s.one('SELECT status FROM push_outbox WHERE id=?','viewer-phone').status,'suppressed');
    assert.equal(f.s.one('SELECT disabled_at FROM push_subscriptions WHERE id=?','admin-phone').disabled_at,null);
    assert.equal(f.s.one('SELECT status FROM push_outbox WHERE id=?','admin-phone').status,'queued');
    f.accounts.update({id:user.id,enabled:true},'admin');
    assert.ok(f.s.one('SELECT disabled_at FROM push_subscriptions WHERE id=?','viewer-phone').disabled_at);
    assert.equal(f.s.one('SELECT status FROM push_outbox WHERE id=?','viewer-phone').status,'suppressed');
  }finally{f.close();}
});

test('self password changes require the current password and revoke all sessions without changing another account',()=>{
  const f=fixture();try{
    const user=viewer(f),normal=f.sessions.issue(false,user),remembered=f.sessions.issue(true,user),adminSession=f.sessions.issue(true,f.admin);
    assert.throws(()=>f.accounts.changePassword(user.id,'incorrect',replacement),/Current password/);assert.ok(f.sessions.valid(normal.token));
    f.accounts.changePassword(user.id,password,replacement);
    assert.equal(f.accounts.authenticate('viewer',password),null);assert.ok(f.accounts.authenticate('viewer',replacement));
    assert.equal(f.sessions.valid(normal.token),false);assert.equal(f.sessions.valid(remembered.token),false);assert.ok(f.sessions.valid(adminSession.token));
    assert.equal(f.s.one("SELECT actor FROM events WHERE type='password_changed'").actor,'viewer');
    const audit=JSON.stringify(f.s.all('SELECT * FROM events'));assert.equal(audit.includes(password),false);assert.equal(audit.includes(replacement),false);
  }finally{f.close();}
});

test('administrator resets and explicit session revocation invalidate existing sessions',()=>{
  const f=fixture();try{
    const user=viewer(f),first=f.sessions.issue(true,user);f.accounts.resetPassword({id:user.id,password:replacement},'admin');
    assert.equal(f.sessions.valid(first.token),false);assert.equal(f.accounts.authenticate('viewer',password),null);
    const fresh=f.accounts.authenticate('viewer',replacement),normal=f.sessions.issue(false,fresh),remembered=f.sessions.issue(true,fresh);
    f.accounts.revokeSessions(user.id,'admin');assert.equal(f.sessions.valid(normal.token),false);assert.equal(f.sessions.valid(remembered.token),false);
    assert.equal(f.accounts.get(user.id).enabled,true);assert.equal(f.accounts.count(),2);
  }finally{f.close();}
});

test('session issuance requires an active current account and cannot create anonymous remembered sessions',()=>{
  const f=fixture();try{
    for(const user of [undefined,null,{}, {id:f.admin.id,authVersion:0}])assert.throws(()=>f.sessions.issue(true,user),/active account/);
    assert.equal(f.s.one('SELECT count(*) n FROM auth_sessions').n,0);
    assert.throws(()=>new Sessions(f.s,password),/account registry/);
  }finally{f.close();}
});

test('legacy session migration discards identity-less tokens and adopts existing push subscriptions once',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zigbee-account-migration-')),file=path.join(dir,'health.db');let s;
  try{
    const old=new DatabaseSync(file);old.exec("CREATE TABLE auth_sessions(token_hash TEXT PRIMARY KEY,credential_tag TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);INSERT INTO auth_sessions VALUES('oldtoken','oldtag',1,9999999999999)");old.close();
    s=new Store(file);assert.equal(s.one('SELECT count(*) n FROM auth_sessions').n,0);
    s.run('INSERT INTO push_subscriptions(id,endpoint_hash,json,label,created_at,updated_at) VALUES(?,?,?,?,?,?)','existing','synthetic-hash','{}','Existing phone',1,1);
    let a=new Accounts(s,{password});const admin=a.authenticate('admin',password);assert.equal(s.one('SELECT user_id FROM push_subscriptions WHERE id=?','existing').user_id,admin.id);
    s.run('INSERT INTO push_subscriptions(id,endpoint_hash,json,label,created_at,updated_at) VALUES(?,?,?,?,?,?)','orphan','other-hash','{}','Later orphan',1,1);
    const remembered=new Sessions(s,a).issue(true,admin);s.close();s=new Store(file);a=new Accounts(s,{password:replacement});
    assert.equal(a.authenticate('admin',replacement),null);assert.ok(new Sessions(s,a).valid(remembered.token));assert.equal(s.one('SELECT user_id FROM push_subscriptions WHERE id=?','orphan').user_id,null);
  }finally{s?.close();assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});}
});
