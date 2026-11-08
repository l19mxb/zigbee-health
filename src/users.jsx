import React,{useEffect,useState} from 'react';
import {request} from './api.jsx';
import {Badge,Empty,Field,Icon,Modal,Pagination,date} from './ui.jsx';
import {SortHead,useTable} from './tables.jsx';
import './users.css';

const roles=['admin','operator','viewer'];
const roleNames={admin:'Administrator',operator:'Operator',viewer:'Viewer'};
const roleDetails={admin:'Full access, including user administration. Administrator access is fixed.',operator:'Start with the health monitor, reports, acknowledgement and shunts; adjust the features below.',viewer:'Start with the health monitor and reports; adjust the features below.'};
const roleLabel=role=>roleNames[role]||role;
const featureGroups=[
  {label:'Monitoring',features:[['viewHealth','Health monitor'],['viewReports','History & reports']]},
  {label:'Alarm handling',features:[['acknowledge','Acknowledge / process alarms'],['manageShunts','Apply / cancel shunts']]},
  {label:'Security',features:[['viewSecurity','View security areas & alarms'],['controlSecurity','Arm / disarm & bypass zones'],['manageSecurity','Security setup & alert actions']]},
  {label:'Configuration',features:[['manageDevices','Device records & settings'],['manageBrokers','Brokers & live topic log'],['manageThresholds','Thresholds & retention'],['manageEmail','Email settings'],['manageNotifications','App address & global push']]}
];
const features=featureGroups.flatMap(group=>group.features),featureKeys=features.map(([key])=>key);
const presets={admin:featureKeys,operator:['viewHealth','viewReports','acknowledge','manageShunts'],viewer:['viewHealth','viewReports']};
const sameFeatures=(a,b)=>a.length===b.length&&a.every(key=>b.includes(key));
const userFeatures=user=>user?.role==='admin'?featureKeys:Array.isArray(user?.permissions)?user.permissions:presets[user?.role]||[];
const customAccess=user=>user.role!=='admin'&&!sameFeatures(userFeatures(user),presets[user.role]||[]);
const featureSummary=user=>features.filter(([key])=>userFeatures(user).includes(key)).map(([,label])=>label).join(', ')||'Your account and notification preferences only';
function AccessSummary({user}){const account=user||{};return <div className="user-access-summary"><Badge tone={account.role==='admin'?'acknowledged':'neutral'}>{customAccess(account)?'Custom access':roleLabel(account.role)}</Badge><span className="small muted" title={featureSummary(account)}>{userFeatures(account).length} of {featureKeys.length} features{account.role==='admin'?' · User administration':''}</span></div>;}

export default function UserAdministration({currentUser,onChanged}){
  const [users,setUsers]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState(''),[dialog,setDialog]=useState(null);
  const table=useTable(users.map(user=>({...user,name:user.displayName,accessLabel:customAccess(user)?'Custom access':roleLabel(user.role),networkLabel:[user.username,roleLabel(user.role),customAccess(user)?'Custom access':'',featureSummary(user),user.enabled?'Enabled':'Disabled'].join(' ')})),'username');
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
      <p className="config-intro">Give each person their own account and tick the features they can use. Their username is recorded when they acknowledge alarms, apply shunts or change settings.</p>
      <div className="users-toolbar"><label className="search compact"><Icon name="search"/><input aria-label="Search users" placeholder="Search users…" value={table.search} onChange={e=>table.setSearch(e.target.value)}/></label><button disabled={loading} onClick={()=>void reload()}>Refresh users</button></div>
      {error?<div className="notice critical" role="alert">{error}</div>:null}
      {message?<div className="notice" role="status">{message}</div>:null}
      {loading?<p className="empty" role="status">Loading users…</p>:table.filtered.length?<div className="table-scroll users-table"><table><thead><tr><SortHead column="username" table={table}>Username</SortHead><SortHead column="displayName" table={table}>Name</SortHead><SortHead column="accessLabel" table={table}>Access</SortHead><SortHead column="enabled" table={table}>Status</SortHead><SortHead column="lastLoginAt" table={table}>Last sign-in</SortHead><th>Actions</th></tr></thead><tbody>{table.rows.map(user=><tr key={user.id}>
        <td><strong>{user.username}</strong>{currentUser?.id===user.id?<span className="row-subtitle">Your account</span>:null}</td><td>{user.displayName}</td><td><AccessSummary user={user}/></td><td><Badge tone={user.enabled?'healthy':'neutral'}>{user.enabled?'Enabled':'Disabled'}</Badge></td><td title={user.lastLoginAt?new Date(user.lastLoginAt).toISOString():undefined}>{date(user.lastLoginAt,true)}</td><td><div className="record-actions"><button aria-label={'Edit '+user.username} onClick={()=>setDialog({type:'edit',user})}>Edit</button><button aria-label={'Manage keypad access for '+user.username} onClick={()=>setDialog({type:'keypad',user})}>Keypad access…</button><button aria-label={'Reset password for '+user.username} onClick={()=>setDialog({type:'reset',user})}>Reset password…</button><button aria-label={'Sign out '+user.username+' everywhere'} onClick={()=>setDialog({type:'revoke',user})}>Sign out everywhere…</button></div></td>
      </tr>)}</tbody></table></div>:<Empty>{table.search?'No users match this search.':'No user accounts are available.'}</Empty>}
      <Pagination total={table.filtered.length} {...table}/>
      <p className="small muted users-footnote">Disable an account to stop access while retaining its audit history. At least one enabled administrator must remain. Cloudflare Access separately controls who can reach the HTTPS app.</p>
    </section>
    <section className="panel config-panel users-role-panel" aria-label="Access presets"><header className="panel-heading"><h2>Access presets</h2></header><div className="users-role-grid">{roles.map(role=><div key={role}><h3>{roleLabel(role)}</h3><p className="muted">{roleDetails[role]}</p></div>)}</div><p className="small muted users-footnote">Presets are starting points for feature checkboxes. User administration is reserved for administrators and cannot be delegated separately. Everyone can manage their own password and notification preferences. Health push requires health monitor access; security push requires security view access and selection in an alert action.</p></section>
    {dialog?.type==='keypad'?<KeypadAccessDialog user={dialog.user} onClose={()=>setDialog(null)} onSave={save}/>:dialog?<UserDialog key={dialog.type+(dialog.user?.id||'')} action={dialog} currentUser={currentUser} enabledAdmins={enabledAdmins} onClose={()=>setDialog(null)} onSave={save}/>:null}
  </>;
}

function UserDialog({action,currentUser,enabledAdmins,onClose,onSave}){
  const {type,user}=action;
  const [username,setUsername]=useState(''),[displayName,setDisplayName]=useState(user?.displayName||''),[role,setRole]=useState(user?.role||'viewer'),[permissions,setPermissions]=useState(()=>user?userFeatures(user):presets.viewer),[enabled,setEnabled]=useState(user?.enabled??true),[password,setPassword]=useState(''),[repeat,setRepeat]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const isSelf=currentUser?.id===user?.id,lastAdmin=user?.enabled&&user.role==='admin'&&enabledAdmins===1;
  const disabling=type==='edit'&&user.enabled&&!enabled;
  const roleChanged=type==='edit'&&role!==user.role;
  const permissionsChanged=type==='edit'&&!sameFeatures(permissions,userFeatures(user));
  const removingHealth=type==='edit'&&userFeatures(user).includes('viewHealth')&&!permissions.includes('viewHealth');
  const removingSecurity=type==='edit'&&userFeatures(user).includes('viewSecurity')&&!permissions.includes('viewSecurity');
  const removingAllPush=(removingHealth||removingSecurity)&&!permissions.includes('viewHealth')&&!permissions.includes('viewSecurity');
  const needsConfirmation=type==='reset'||type==='revoke'||disabling||roleChanged||permissionsChanged;
  function choosePreset(value){setRole(value);setPermissions(presets[value]);setConfirmed(false);}
  function toggleFeature(key,checked){
    const next=new Set(permissions);
    if(checked){next.add(key);if(key==='acknowledge'||key==='manageShunts')next.add('viewHealth');if(key==='controlSecurity'||key==='manageSecurity')next.add('viewSecurity');}
    else{next.delete(key);if(key==='viewHealth'){next.delete('acknowledge');next.delete('manageShunts');}if(key==='viewSecurity'){next.delete('controlSecurity');next.delete('manageSecurity');}}
    setPermissions(featureKeys.filter(value=>next.has(value)));setConfirmed(false);
  }
  const titles={create:'Add user',edit:'Edit user',reset:'Reset user password',revoke:'Sign out user everywhere'};
  const close=()=>{if(!busy){setPassword('');setRepeat('');onClose();}};
  const labels={create:'Create user',edit:'Save user',reset:'Reset password',revoke:'Sign out everywhere'};
  async function submit(event){
    event.preventDefault();setError('');
    if((type==='create'||type==='reset')&&password!==repeat){setError('The new passwords do not match.');return;}
    if(needsConfirmation&&!confirmed){setError('Confirm the change before continuing.');return;}
    setBusy(true);
    try{
      if(type==='create')await onSave('users',{username,displayName,role,password,permissions},'User created. Share the initial password privately.');
      else if(type==='edit')await onSave('users/update',{id:user.id,displayName,role,enabled,permissions},'User updated.');
      else if(type==='reset')await onSave('users/reset-password',{id:user.id,password},'Password reset. Existing sign-ins have ended.');
      else await onSave('users/revoke-sessions',{id:user.id},'Existing sign-ins have ended.');
      setPassword('');setRepeat('');
    }catch(e){setError(e.message);setPassword('');setRepeat('');}
    finally{setBusy(false);}
  }
  return <Modal title={titles[type]} onClose={close} wide={type==='create'||type==='edit'}><form className="user-form" onSubmit={submit}>
    {user?<p className="user-dialog-identity"><strong>{user.displayName}</strong><span className="muted">{user.username}{isSelf?' · Your account':''}</span></p>:null}
    {type==='create'?<Field label="Username" required autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{2,63}" value={username} onChange={e=>setUsername(e.target.value)} hint="3–64 characters, starting with a letter or number. Full stops, hyphens and underscores are allowed. Saved in lowercase."/>:null}
    {type==='create'||type==='edit'?<>
      <Field label="Display name" required autoFocus={type==='edit'} autoComplete="off" maxLength={100} value={displayName} onChange={e=>setDisplayName(e.target.value)}/>
      <Field label="Access preset"><select value={role} disabled={lastAdmin} onChange={e=>choosePreset(e.target.value)}>{roles.map(value=><option value={value} key={value}>{roleLabel(value)}</option>)}</select></Field><p className="small muted user-role-help">{roleDetails[role]}</p>
      <section className="user-features" aria-label="Feature access"><div className="user-features-heading"><h3>Allowed features</h3><AccessSummary user={{role,permissions}}/></div><p className="small muted">{role==='admin'?'Administrators have every feature and user administration.':'Tick each feature this person can use. Their own password and notification preferences are always available.'}</p><div className="user-feature-groups">{featureGroups.map(group=><fieldset key={group.label} disabled={role==='admin'}><legend>{group.label}</legend>{group.features.map(([key,label])=><label className="checkbox-field" key={key}><input type="checkbox" checked={permissions.includes(key)} onChange={e=>toggleFeature(key,e.target.checked)}/>{label}</label>)}</fieldset>)}</div><p className="small muted">Acknowledgement, shunts and health push require the health monitor. Turning it off also turns off those two actions. Security controls, setup and security push require security view access; turning it off also turns off those two features. Each push category requires its corresponding view access.</p></section>
      {type==='edit'?<label className="checkbox-field"><input type="checkbox" checked={enabled} disabled={lastAdmin} onChange={e=>{setEnabled(e.target.checked);setConfirmed(false);}}/>Account enabled</label>:null}
      {lastAdmin?<div className="notice">This is the last enabled administrator. Add or enable another administrator before changing this account’s role or disabling it.</div>:null}
    </>:null}
    {type==='create'||type==='reset'?<><Field label={type==='create'?'Initial password':'New password'} type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)} hint="12–128 characters."/><Field label="Repeat new password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={repeat} onChange={e=>setRepeat(e.target.value)}/></>:null}
    {type==='reset'?<div className="notice warning">Resetting this password ends all existing sign-ins for {user.username}.{isSelf?' You will need to sign in again with the new password.':''}</div>:type==='revoke'?<div className="notice warning">End all current sign-ins for {user.username}, including remembered 30-day sign-ins. The password stays the same.{isSelf?' This also signs you out now.':''}</div>:disabling?<div className="notice warning">Disabling this account immediately ends its sign-ins and prevents new sign-ins. Its audit history is retained.{isSelf?' This also signs you out now.':''}</div>:roleChanged||permissionsChanged?<div className="notice warning">Changing access ends existing sign-ins so the updated permissions apply.{isSelf?' You will need to sign in again.':''}</div>:null}
    {removingAllPush?<div className="notice warning">Removing both health monitor and security view access disables this account’s browser registrations and suppresses pending messages. If access is restored, the person must enable notifications again from their browser.</div>:removingHealth||removingSecurity?<div className="notice warning">Removing {removingHealth?'health monitor':'security view'} access suppresses pending {removingHealth?'health':'security'} notifications. Browser registrations stay enabled for the other permitted alarm category.</div>:null}
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
  return <section className="panel config-panel account-panel" aria-label="Your account">
    <header className="panel-heading"><h2>Your account</h2></header>
    <dl className="account-details"><div><dt>Username</dt><dd>{currentUser?.username}</dd></div><div><dt>Name</dt><dd>{currentUser?.displayName}</dd></div><div><dt>Access preset</dt><dd>{roleLabel(currentUser?.role)}</dd></div></dl>
    <section className="config-section account-feature-list" aria-label="Your feature access"><div className="user-features-heading"><h3>Your feature access</h3><AccessSummary user={currentUser}/></div>{userFeatures(currentUser).length?<ul>{features.filter(([key])=>userFeatures(currentUser).includes(key)).map(([key,label])=><li key={key}><Icon name="check" size={15}/>{label}</li>)}{currentUser?.role==='admin'?<li><Icon name="check" size={15}/>User administration</li>:null}</ul>:<p className="muted">No dashboard features are enabled for this account. Your own password and notification preferences remain available.</p>}</section>
    {currentUser?.id&&currentUser.id!=='local-preview'?<OwnKeypadPin key={currentUser.id} currentUser={currentUser}/>:<section className="config-section own-keypad"><h3>Keypad PIN</h3><p className="muted">Set up authenticated user accounts to use keypad PINs.</p></section>}
    <section className="config-section"><h3>Change password</h3><p className="muted">Changing your password ends all your sign-ins, including remembered 30-day sign-ins.</p><form className="account-password-form" onSubmit={submit}><Field label="Current password" type="password" autoComplete="current-password" required maxLength={128} value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/><Field label="New password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)} hint="12–128 characters."/><Field label="Repeat new password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={repeat} onChange={e=>setRepeat(e.target.value)}/>{error?<div className="notice critical" role="alert">{error}</div>:null}{message?<div className="notice" role="status">{message}</div>:null}<button className="primary" disabled={busy}>{busy?'Changing password…':'Change password'}</button></form></section>
  </section>;
}

function useKeypadStatus(route){
  const [status,setStatus]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  async function reload(signal){
    setLoading(true);setError('');
    try{const next=await request(route,undefined,signal);setStatus(next);return next;}
    catch(e){if(e.name!=='AbortError')setError(e.message);return null;}
    finally{if(!signal?.aborted)setLoading(false);}
  }
  useEffect(()=>{const controller=new AbortController();void reload(controller.signal);return()=>controller.abort();},[route]);
  return {status,loading,error,reload};
}

function PinFields({pin,setPin,repeat,setRepeat,disabled=false}){
  const digits=value=>value.replace(/[^0-9]/g,'').slice(0,4);
  return <div className="keypad-pin-fields"><Field label="New 4-digit PIN" type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{4}" minLength={4} maxLength={4} required disabled={disabled} value={pin} onChange={e=>setPin(digits(e.target.value))} hint="Exactly four digits. The existing PIN is never displayed."/><Field label="Repeat new PIN" type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{4}" minLength={4} maxLength={4} required disabled={disabled} value={repeat} onChange={e=>setRepeat(digits(e.target.value))}/></div>;
}

function KeypadAreaList({status}){
  if(status.allAreas)return <p className="small muted">This PIN can disarm all security areas, including areas added later. Administrator access cannot be restricted here.</p>;
  return status.areas.length?<ul className="keypad-area-names">{status.areas.map(area=><li key={area.id}>{area.name}</li>)}</ul>:<p className="small muted">No security areas assigned. An administrator must assign areas before this PIN can disarm them.</p>;
}

function OwnKeypadPin({currentUser}){
  const {status,loading,error,reload}=useKeypadStatus('account/keypad');
  const [operation,setOperation]=useState(null),[currentPassword,setCurrentPassword]=useState(''),[pin,setPin]=useState(''),[repeat,setRepeat]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[formError,setFormError]=useState(''),[message,setMessage]=useState('');
  function clear(){setPin('');setRepeat('');setCurrentPassword('');setConfirmed(false);}
  function choose(value){clear();setFormError('');setMessage('');setOperation(value);}
  async function submit(event){
    event.preventDefault();setFormError('');setMessage('');
    if(operation==='set'&&(pin.length!==4||pin!==repeat)){setFormError('Enter the same four-digit PIN twice.');return;}
    if(operation==='remove'&&!confirmed){setFormError('Confirm removal before continuing.');return;}
    setBusy(true);
    try{await request('account/keypad',{currentPassword,operation,...(operation==='set'?{pin}:{})});clear();setOperation(null);setMessage(operation==='set'?'Keypad PIN saved.':'Keypad PIN removed.');await reload();}
    catch(e){clear();setFormError(e.message);}
    finally{setBusy(false);}
  }
  return <section className="config-section own-keypad" aria-label="Your keypad PIN"><div className="user-features-heading"><h3>Keypad PIN</h3>{status?<Badge tone={status.pinSet?'healthy':'neutral'}>{status.pinSet?'PIN set':'No PIN set'}</Badge>:null}</div><p className="muted">Use your personal four-digit PIN on the security keypad. It is separate from your dashboard password.</p>
    {loading?<p className="small muted user-keypad-loading" role="status">Loading keypad access…</p>:null}
    {error?<div className="notice critical" role="alert">{error}<button type="button" onClick={()=>void reload()}>Retry</button></div>:null}
    {status&&!loading?<><div className="keypad-own-areas"><h4>PIN disarm areas</h4><KeypadAreaList status={status}/></div>{!status.canControl?<div className="notice">This account does not currently have security control access. An administrator must enable that feature before you can set or use a keypad PIN.</div>:null}
      {!operation?<div className="record-actions keypad-actions"><button type="button" disabled={busy||!status.canControl||!currentUser?.enabled} onClick={()=>choose('set')}>{status.pinSet?'Change keypad PIN':'Set keypad PIN'}</button>{status.pinSet?<button type="button" disabled={busy} onClick={()=>choose('remove')}>Remove keypad PIN…</button>:null}</div>:<form className="account-password-form keypad-own-form" onSubmit={submit}>
        <h4>{operation==='set'?(status.pinSet?'Change keypad PIN':'Set keypad PIN'):'Remove keypad PIN'}</h4><Field label="Current password for PIN change" type="password" autoComplete="current-password" required disabled={busy} maxLength={128} value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/>
        {operation==='set'?<PinFields pin={pin} setPin={setPin} repeat={repeat} setRepeat={setRepeat} disabled={busy}/>:<><div className="notice warning">Removing your PIN prevents keypad disarming with this account until a new PIN is set.</div><label className="checkbox-field user-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>I confirm removal of my keypad PIN.</label></>}
        {formError?<div className="notice critical" role="alert">{formError}</div>:null}<div className="form-actions"><button type="button" disabled={busy} onClick={()=>choose(null)}>Cancel</button><button className="primary" disabled={busy||!currentPassword||(operation==='set'?(pin.length!==4||pin!==repeat):!confirmed)}>{busy?'Saving…':operation==='set'?'Save keypad PIN':'Remove keypad PIN'}</button></div>
      </form>}
    </>:null}{message?<div className="notice" role="status">{message}</div>:null}
  </section>;
}

function KeypadAccessDialog({user,onClose,onSave}){
  const {status,loading,error,reload}=useKeypadStatus('users/keypad?id='+encodeURIComponent(user.id));
  const [areaIds,setAreaIds]=useState([]),[operation,setOperation]=useState('save'),[pin,setPin]=useState(''),[repeat,setRepeat]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[formError,setFormError]=useState('');
  useEffect(()=>{if(status)setAreaIds([...status.areaIds]);},[status]);
  const areasChanged=status&&!status.allAreas&&!sameFeatures(areaIds,status.areaIds),changed=operation!=='save'||areasChanged;
  function close(){if(!busy){setPin('');setRepeat('');onClose();}}
  function choose(value){setOperation(value);setPin('');setRepeat('');setConfirmed(false);setFormError('');}
  function toggleArea(id,checked){setAreaIds(value=>checked?[...new Set([...value,id])]:value.filter(areaId=>areaId!==id));setConfirmed(false);}
  async function submit(event){
    event.preventDefault();setFormError('');
    if(operation==='set'&&(pin.length!==4||pin!==repeat)){setFormError('Enter the same four-digit PIN twice.');return;}
    if(!confirmed){setFormError('Confirm the keypad access change before continuing.');return;}
    setBusy(true);
    try{await onSave('users/keypad',{id:user.id,operation,...(!status.allAreas?{areaIds}:{}),...(operation==='set'?{pin}:{})},operation==='remove'?'Keypad PIN removed and access saved.':'Keypad access saved.');setPin('');setRepeat('');}
    catch(e){setPin('');setRepeat('');setConfirmed(false);setFormError(e.message);}
    finally{setBusy(false);}
  }
  return <Modal title="Keypad access" onClose={close}><form className="user-form keypad-access-form" onSubmit={submit}><p className="user-dialog-identity"><strong>{user.displayName}</strong><span className="muted">{user.username}</span></p>
    {loading?<p role="status" className="small muted">Loading keypad access…</p>:null}{error?<div className="notice critical" role="alert">{error}<button type="button" onClick={()=>void reload()}>Retry</button></div>:null}
    {status&&!loading?<><div className="keypad-status-row"><span>Keypad PIN</span><Badge tone={status.pinSet?'healthy':'neutral'}>{status.pinSet?'PIN set':'No PIN set'}</Badge></div><fieldset className="user-keypad-areas" disabled={status.allAreas||busy}><legend>PIN disarm areas</legend>{status.allAreas?<KeypadAreaList status={status}/>:status.areas.length?status.areas.map(area=><label className="checkbox-field" key={area.id}><input type="checkbox" checked={areaIds.includes(area.id)} onChange={e=>toggleArea(area.id,e.target.checked)}/>{area.name}</label>):<p className="small muted">No security areas exist yet. Add an area in Security setup before assigning keypad access.</p>}</fieldset>
      {!status.allAreas?<p className="small muted keypad-area-hint">Only the selected areas can be disarmed with this person’s PIN. No selection permits no PIN disarming.</p>:null}
      {!status.enabled||!status.canControl?<div className="notice">This account {status.enabled?'does not have security control access':'is disabled'}. You can prepare its PIN and areas, but the PIN cannot be used until the account is enabled and security control is permitted.</div>:null}
      <Field label="PIN action"><select value={operation} disabled={busy} onChange={e=>choose(e.target.value)}><option value="save">{status.pinSet?'Keep current PIN':'Leave PIN unset'}</option><option value="set">{status.pinSet?'Set a replacement PIN':'Set a PIN'}</option>{status.pinSet?<option value="remove">Remove PIN</option>:null}</select></Field>
      {operation==='set'?<PinFields pin={pin} setPin={setPin} repeat={repeat} setRepeat={setRepeat} disabled={busy}/>:null}
      {operation==='remove'?<div className="notice warning">Remove this person’s PIN. They will not be able to disarm from a keypad until a new PIN is set.</div>:null}
      {operation==='set'?<p className="small muted keypad-pin-hint">Each person needs a unique PIN. The saved code cannot be viewed later. Share a replacement privately.</p>:null}
      {changed?<label className="checkbox-field user-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>I confirm these keypad access changes.</label>:null}
    </>:null}{formError?<div className="notice critical" role="alert">{formError}</div>:null}<div className="form-actions"><button type="button" disabled={busy} onClick={close}>Cancel</button><button className="primary" disabled={busy||loading||!status||!changed||!confirmed||(operation==='set'&&(pin.length!==4||pin!==repeat))}>{busy?'Saving…':'Save keypad access'}</button></div>
  </form></Modal>;
}
