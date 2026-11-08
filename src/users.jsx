import React,{useEffect,useState} from 'react';
import {request} from './api.jsx';
import {Badge,Empty,Field,Icon,Modal,Pagination,date} from './ui.jsx';
import {SortHead,useTable} from './tables.jsx';
import './users.css';

const roles=['admin','operator','viewer'];
const roleNames={admin:'Administrator',operator:'Operator',viewer:'Viewer'};
const roleDetails={admin:'Manage users, configuration, devices and alarms.',operator:'Acknowledge and process alarms, manage shunts, and view reports.',viewer:'View device health, alarms and reports.'};
const roleLabel=role=>roleNames[role]||role;

export default function UserAdministration({currentUser,onChanged}){
  const [users,setUsers]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState(''),[dialog,setDialog]=useState(null);
  const table=useTable(users.map(user=>({...user,name:user.displayName,networkLabel:[user.username,roleLabel(user.role),user.enabled?'Enabled':'Disabled'].join(' ')})),'username');
  async function reload(signal){
    try{const result=await request('users',undefined,signal);setUsers(result.users);setError('');}
    catch(e){if(e.name!=='AbortError')setError(e.message);}
    finally{if(!signal?.aborted)setLoading(false);}
  }
  useEffect(()=>{const controller=new AbortController();void reload(controller.signal);return()=>controller.abort();},[]);
  async function save(route,body,success){
    await request(route,body);setDialog(null);setMessage(success);setError('');
    await onChanged?.();
    // Self password, role or session changes may have ended this session.
    await reload();
  }
  const enabledAdmins=users.filter(user=>user.enabled&&user.role==='admin').length;
  return <>
    <section className="panel config-panel users-panel" aria-label="User administration">
      <header className="panel-heading"><h2>Users <span className="count">{users.length}</span></h2><button className="primary" onClick={()=>{setMessage('');setDialog({type:'create'});}}>Add user</button></header>
      <p className="config-intro">Give each person their own account. Their username is recorded when they acknowledge alarms, apply shunts or change settings.</p>
      <div className="users-toolbar"><label className="search compact"><Icon name="search"/><input aria-label="Search users" placeholder="Search users…" value={table.search} onChange={e=>table.setSearch(e.target.value)}/></label><button disabled={loading} onClick={()=>void reload()}>Refresh users</button></div>
      {error?<div className="notice critical" role="alert">{error}</div>:null}
      {message?<div className="notice" role="status">{message}</div>:null}
      {loading?<p className="empty" role="status">Loading users…</p>:table.filtered.length?<div className="table-scroll users-table"><table><thead><tr><SortHead column="username" table={table}>Username</SortHead><SortHead column="displayName" table={table}>Name</SortHead><SortHead column="role" table={table}>Role</SortHead><SortHead column="enabled" table={table}>Status</SortHead><SortHead column="lastLoginAt" table={table}>Last sign-in</SortHead><th>Actions</th></tr></thead><tbody>{table.rows.map(user=><tr key={user.id}>
        <td><strong>{user.username}</strong>{currentUser?.id===user.id?<span className="row-subtitle">Your account</span>:null}</td><td>{user.displayName}</td><td><Badge tone={user.role==='admin'?'acknowledged':'neutral'}>{roleLabel(user.role)}</Badge></td><td><Badge tone={user.enabled?'healthy':'neutral'}>{user.enabled?'Enabled':'Disabled'}</Badge></td><td title={user.lastLoginAt?new Date(user.lastLoginAt).toISOString():undefined}>{date(user.lastLoginAt,true)}</td><td><div className="record-actions"><button aria-label={'Edit '+user.username} onClick={()=>setDialog({type:'edit',user})}>Edit</button><button aria-label={'Reset password for '+user.username} onClick={()=>setDialog({type:'reset',user})}>Reset password…</button><button aria-label={'Sign out '+user.username+' everywhere'} onClick={()=>setDialog({type:'revoke',user})}>Sign out everywhere…</button></div></td>
      </tr>)}</tbody></table></div>:<Empty>{table.search?'No users match this search.':'No user accounts are available.'}</Empty>}
      <Pagination total={table.filtered.length} {...table}/>
      <p className="small muted users-footnote">Disable an account to stop access while retaining its audit history. At least one enabled administrator must remain. Cloudflare Access separately controls who can reach the HTTPS app.</p>
    </section>
    <section className="panel config-panel users-role-panel" aria-label="Role permissions"><header className="panel-heading"><h2>Role permissions</h2></header><div className="users-role-grid">{roles.map(role=><div key={role}><h3>{roleLabel(role)}</h3><p className="muted">{roleDetails[role]}</p></div>)}</div></section>
    {dialog?<UserDialog key={dialog.type+(dialog.user?.id||'')} action={dialog} currentUser={currentUser} enabledAdmins={enabledAdmins} onClose={()=>setDialog(null)} onSave={save}/>:null}
  </>;
}

function UserDialog({action,currentUser,enabledAdmins,onClose,onSave}){
  const {type,user}=action;
  const [username,setUsername]=useState(''),[displayName,setDisplayName]=useState(user?.displayName||''),[role,setRole]=useState(user?.role||'viewer'),[enabled,setEnabled]=useState(user?.enabled??true),[password,setPassword]=useState(''),[repeat,setRepeat]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const isSelf=currentUser?.id===user?.id,lastAdmin=user?.enabled&&user.role==='admin'&&enabledAdmins===1;
  const disabling=type==='edit'&&user.enabled&&!enabled;
  const roleChanged=type==='edit'&&role!==user.role;
  const needsConfirmation=type==='reset'||type==='revoke'||disabling||roleChanged;
  const titles={create:'Add user',edit:'Edit user',reset:'Reset user password',revoke:'Sign out user everywhere'};
  const close=()=>{if(!busy){setPassword('');setRepeat('');onClose();}};
  const labels={create:'Create user',edit:'Save user',reset:'Reset password',revoke:'Sign out everywhere'};
  async function submit(event){
    event.preventDefault();setError('');
    if((type==='create'||type==='reset')&&password!==repeat){setError('The new passwords do not match.');return;}
    if(needsConfirmation&&!confirmed){setError('Confirm the change before continuing.');return;}
    setBusy(true);
    try{
      if(type==='create')await onSave('users',{username,displayName,role,password},'User created. Share the initial password privately.');
      else if(type==='edit')await onSave('users/update',{id:user.id,displayName,role,enabled},'User updated.');
      else if(type==='reset')await onSave('users/reset-password',{id:user.id,password},'Password reset. Existing sign-ins have ended.');
      else await onSave('users/revoke-sessions',{id:user.id},'Existing sign-ins have ended.');
      setPassword('');setRepeat('');
    }catch(e){setError(e.message);setPassword('');setRepeat('');}
    finally{setBusy(false);}
  }
  return <Modal title={titles[type]} onClose={close}><form className="user-form" onSubmit={submit}>
    {user?<p className="user-dialog-identity"><strong>{user.displayName}</strong><span className="muted">{user.username}{isSelf?' · Your account':''}</span></p>:null}
    {type==='create'?<Field label="Username" required autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{2,63}" value={username} onChange={e=>setUsername(e.target.value)} hint="3–64 characters, starting with a letter or number. Full stops, hyphens and underscores are allowed. Saved in lowercase."/>:null}
    {type==='create'||type==='edit'?<>
      <Field label="Display name" required autoFocus={type==='edit'} autoComplete="off" maxLength={100} value={displayName} onChange={e=>setDisplayName(e.target.value)}/>
      <Field label="Role"><select value={role} disabled={lastAdmin} onChange={e=>{setRole(e.target.value);setConfirmed(false);}}>{roles.map(value=><option value={value} key={value}>{roleLabel(value)}</option>)}</select></Field><p className="small muted user-role-help">{roleDetails[role]}</p>
      {type==='edit'?<label className="checkbox-field"><input type="checkbox" checked={enabled} disabled={lastAdmin} onChange={e=>{setEnabled(e.target.checked);setConfirmed(false);}}/>Account enabled</label>:null}
      {lastAdmin?<div className="notice">This is the last enabled administrator. Add or enable another administrator before changing this account’s role or disabling it.</div>:null}
    </>:null}
    {type==='create'||type==='reset'?<><Field label={type==='create'?'Initial password':'New password'} type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)} hint="12–128 characters."/><Field label="Repeat new password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={repeat} onChange={e=>setRepeat(e.target.value)}/></>:null}
    {type==='reset'?<div className="notice warning">Resetting this password ends all existing sign-ins for {user.username}.{isSelf?' You will need to sign in again with the new password.':''}</div>:type==='revoke'?<div className="notice warning">End all current sign-ins for {user.username}, including remembered 30-day sign-ins. The password stays the same.{isSelf?' This also signs you out now.':''}</div>:disabling?<div className="notice warning">Disabling this account immediately ends its sign-ins and prevents new sign-ins. Its audit history is retained.{isSelf?' This also signs you out now.':''}</div>:roleChanged?<div className="notice warning">Changing the role ends existing sign-ins so the updated permissions apply.{isSelf?' You will need to sign in again.':''}</div>:null}
    {needsConfirmation?<label className="checkbox-field user-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I understand and confirm this change.</label>:null}
    {error?<div className="notice critical" role="alert">{error}</div>:null}
    <div className="form-actions"><button type="button" disabled={busy} onClick={close}>Cancel</button><button className="primary" disabled={busy||(needsConfirmation&&!confirmed)}>{busy?'Saving…':labels[type]}</button></div>
  </form></Modal>;
}

export function AccountPanel({currentUser,onChanged}){
  const [currentPassword,setCurrentPassword]=useState(''),[password,setPassword]=useState(''),[repeat,setRepeat]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  async function submit(event){
    event.preventDefault();setError('');setMessage('');
    if(password!==repeat){setError('The new passwords do not match.');return;}
    setBusy(true);
    try{await request('account/password',{currentPassword,newPassword:password});setCurrentPassword('');setPassword('');setRepeat('');setMessage('Password changed. Sign in again with your new password.');await onChanged?.();}
    catch(e){setError(e.message);setCurrentPassword('');setPassword('');setRepeat('');}
    finally{setBusy(false);}
  }
  return <section className="panel config-panel account-panel" aria-label="Your account"><header className="panel-heading"><h2>Your account</h2></header><dl className="account-details"><div><dt>Username</dt><dd>{currentUser?.username}</dd></div><div><dt>Name</dt><dd>{currentUser?.displayName}</dd></div><div><dt>Role</dt><dd><Badge tone={currentUser?.role==='admin'?'acknowledged':'neutral'}>{roleLabel(currentUser?.role)}</Badge></dd></div></dl><section className="config-section"><h3>Change password</h3><p className="muted">Changing your password ends all your sign-ins, including remembered 30-day sign-ins.</p><form className="account-password-form" onSubmit={submit}><Field label="Current password" type="password" autoComplete="current-password" required maxLength={128} value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/><Field label="New password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)} hint="12–128 characters."/><Field label="Repeat new password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={repeat} onChange={e=>setRepeat(e.target.value)}/>{error?<div className="notice critical" role="alert">{error}</div>:null}{message?<div className="notice" role="status">{message}</div>:null}<button className="primary" disabled={busy}>{busy?'Changing password…':'Change password'}</button></form></section></section>;
}
