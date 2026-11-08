import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../server/store.mjs';
import {Accounts,permissionKeys,rolePermissions,hasPermission} from '../server/accounts.mjs';
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

test('roles are permission presets while administrator permissions remain complete',()=>{
  const f=fixture();try{
    assert.equal(permissionKeys.length,9);assert.deepEqual(f.admin.permissions,[...permissionKeys].sort());
    const ordinary=viewer(f),operator=f.accounts.create({username:'operator',role:'operator',password},'admin');
    assert.deepEqual(ordinary.permissions,rolePermissions.viewer);assert.deepEqual(operator.permissions,rolePermissions.operator);
    assert.equal(hasPermission(ordinary,'viewHealth'),true);assert.equal(hasPermission(ordinary,'manageBrokers'),false);
    assert.equal(hasPermission(operator,'acknowledge'),true);assert.equal(hasPermission(operator,'manageUsers'),false);
    for(const key of permissionKeys)assert.equal(hasPermission(f.admin,key),true);
    assert.equal(hasPermission({...f.admin,enabled:false},'viewHealth'),false);assert.equal(hasPermission(null,'viewHealth'),false);
    assert.throws(()=>f.accounts.update({id:f.admin.id,permissions:['viewHealth']},'admin'),/every feature/);
    assert.deepEqual(f.accounts.get(f.admin.id).permissions,rolePermissions.admin);
  }finally{f.close();}
});

test('explicit nonadmin checkboxes can grant independent features and override role defaults',()=>{
  const f=fixture();try{
    const custom=f.accounts.create({username:'custom-viewer',role:'viewer',permissions:['manageBrokers'],password},'admin');
    assert.deepEqual(custom.permissions,['manageBrokers']);assert.equal(hasPermission(custom,'manageBrokers'),true);assert.equal(hasPermission(custom,'viewHealth'),false);assert.equal(hasPermission(custom,'viewReports'),false);
    const limited=f.accounts.create({username:'limited-operator',role:'operator',permissions:[],password},'admin');
    assert.deepEqual(limited.permissions,[]);assert.equal(hasPermission(limited,'acknowledge'),false);
    f.accounts.update({id:limited.id,permissions:['acknowledge']},'admin');assert.deepEqual(f.accounts.get(limited.id).permissions,['acknowledge','viewHealth']);
    f.accounts.update({id:limited.id,permissions:['manageShunts']},'admin');assert.deepEqual(f.accounts.get(limited.id).permissions,['manageShunts','viewHealth']);
    f.accounts.update({id:limited.id,permissions:['manageDevices']},'admin');assert.deepEqual(f.accounts.get(limited.id).permissions,['manageDevices']);
  }finally{f.close();}
});

test('feature permissions reject unknown keys, duplicates and nonarrays without changing accounts',()=>{
  const f=fixture();try{
    const user=viewer(f),version=user.authVersion;
    for(const permissions of [['unknown'],['viewHealth','viewHealth'],['viewHealth',1],null,{},'viewHealth',true]){
      assert.throws(()=>f.accounts.update({id:user.id,permissions},'admin'),/valid feature permissions/);
      assert.throws(()=>f.accounts.create({username:'invalid-permissions',password,permissions},'admin'),/valid feature permissions/);
    }
    assert.equal(f.accounts.count(),2);assert.equal(f.accounts.get(user.id).authVersion,version);assert.deepEqual(f.accounts.get(user.id).permissions,rolePermissions.viewer);
    assert.throws(()=>f.accounts.create({username:'partial-admin',password,role:'admin',permissions:[]},'admin'),/every feature/);
    assert.throws(()=>f.accounts.update({id:f.admin.id,role:'viewer',permissions:[]},'admin'),/at least one enabled administrator/);
  }finally{f.close();}
});

test('permission changes revoke normal and remembered sessions and produce an attributed audit event',()=>{
  const f=fixture();try{
    const user=viewer(f),normal=f.sessions.issue(false,user),remembered=f.sessions.issue(true,user);
    f.accounts.update({id:user.id,permissions:['manageBrokers']},'admin');
    assert.equal(f.sessions.valid(normal.token),false);assert.equal(f.sessions.valid(remembered.token),false);assert.equal(f.s.one('SELECT count(*) n FROM auth_sessions WHERE user_id=?',user.id).n,0);
    assert.throws(()=>f.sessions.issue(false,user),/active account/);
    const fresh=f.accounts.authenticate('viewer',password),newSession=f.sessions.issue(false,fresh);assert.deepEqual(f.sessions.current(newSession.token).permissions,['manageBrokers']);
    const event=f.s.one("SELECT actor,message FROM events WHERE type='permissions_changed' ORDER BY id DESC LIMIT 1");assert.equal(event.actor,'admin');assert.match(event.message,/viewer.*manageBrokers/);
    const oldVersion=fresh.authVersion;f.accounts.update({id:user.id,displayName:'Renamed'},'admin');assert.equal(f.accounts.get(user.id).authVersion,oldVersion);assert.ok(f.sessions.valid(newSession.token));
  }finally{f.close();}
});

test('role changes apply new presets only when no explicit permission array is supplied',()=>{
  const f=fixture();try{
    const user=f.accounts.create({username:'custom-permissions',password,permissions:['manageEmail']},'admin');
    f.accounts.update({id:user.id,displayName:'Same custom'},'admin');assert.deepEqual(f.accounts.get(user.id).permissions,['manageEmail']);
    f.accounts.update({id:user.id,role:'operator'},'admin');assert.deepEqual(f.accounts.get(user.id).permissions,rolePermissions.operator);
    f.accounts.update({id:user.id,role:'viewer',permissions:['manageThresholds']},'admin');assert.deepEqual(f.accounts.get(user.id).permissions,['manageThresholds']);
  }finally{f.close();}
});

test('removing health access disables existing push and does not revive it when health permission is restored',()=>{
  const f=fixture();try{
    const user=viewer(f);
    f.s.run('INSERT INTO push_subscriptions(id,endpoint_hash,json,label,created_at,updated_at,user_id) VALUES(?,?,?,?,?,?,?)','phone','phone','{}','Phone',1,1,user.id);
    f.s.run('INSERT INTO push_outbox(id,incident_id,subscription_id,kind,rearm,created_at,status) VALUES(?,?,?,?,?,?,?)','job',null,'phone','test',0,1,'queued');
    f.accounts.update({id:user.id,permissions:['viewReports']},'admin');
    const disabled=f.s.one('SELECT disabled_at,last_error FROM push_subscriptions WHERE id=?','phone');assert.ok(disabled.disabled_at);assert.equal(disabled.last_error,'Health access removed');
    assert.equal(f.s.one('SELECT status FROM push_outbox WHERE id=?','job').status,'suppressed');
    f.accounts.update({id:user.id,permissions:['viewReports','viewHealth']},'admin');
    assert.equal(f.s.one('SELECT disabled_at FROM push_subscriptions WHERE id=?','phone').disabled_at,disabled.disabled_at);assert.equal(f.accounts.get(user.id).enabled,true);
  }finally{f.close();}
});

test('legacy account rows receive role-preserving permission backfill without overriding explicit custom grants',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zigbee-permission-migration-')),file=path.join(dir,'health.db');let s;
  try{
    const old=new DatabaseSync(file);
    old.exec("CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL COLLATE NOCASE UNIQUE,display_name TEXT NOT NULL,role TEXT NOT NULL,enabled INTEGER NOT NULL,password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,auth_version INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,last_login_at INTEGER)");
    const insert=old.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    for(const access of ['admin','operator','viewer'])insert.run(access,access,access,access,1,'a'.repeat(32),'b'.repeat(64),1,1,1,null);
    old.close();s=new Store(file);let a=new Accounts(s);
    for(const access of ['admin','operator','viewer'])assert.deepEqual(a.get(access).permissions,rolePermissions[access]);
    s.run('UPDATE users SET permissions=? WHERE id=?',JSON.stringify(['manageBrokers']),'viewer');s.close();s=new Store(file);a=new Accounts(s);
    assert.deepEqual(a.get('viewer').permissions,['manageBrokers']);assert.equal(a.get('viewer').authVersion,1);assert.equal(a.count(),3);
  }finally{s?.close();assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});}
});
