import React,{useEffect,useState} from 'react';
import {request} from './api.jsx';
import {Badge,Field,date} from './ui.jsx';
import {applicationKey,getInstallPrompt,installApp,serviceWorkerReady} from './pwa.js';

export default function Notifications({demo,admin=true,canReceive=true}){
  const [status,setStatus]=useState(null),[value,setValue]=useState(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[registration,setRegistration]=useState(null),[install,setInstall]=useState(!!getInstallPrompt()),[label,setLabel]=useState('My Android'),[currentId,setCurrentId]=useState(()=>localStorage.getItem('zh-push-id')||'');
  async function reload(){const s=await request('push');setStatus(s);return s;}
  useEffect(()=>{let active=true;request('push').then(s=>{if(active){setStatus(s);setValue(s);}}).catch(e=>{if(active)setError(e.message);});serviceWorkerReady.then(r=>{if(active)setRegistration(r);});const update=()=>setInstall(!!getInstallPrompt());window.addEventListener('zh-install-ready',update);return()=>{active=false;window.removeEventListener('zh-install-ready',update);};},[]);
  const supported=window.isSecureContext&&'Notification' in window&&'PushManager' in window;
  const canonical=status?.publicOrigin===location.origin;
  const ready=supported&&canonical&&status?.enabled&&!demo&&!!registration&&canReceive;
  async function run(fn){setError('');setMessage('');setBusy(true);try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}}
  const change=key=>e=>setValue({...value,[key]:e.target.type==='checkbox'?e.target.checked:e.target.value});
  async function enable(){
    // Request permission directly in the click handler, before asynchronous work.
    const permission=Notification.permission==='granted'?Promise.resolve('granted'):Notification.requestPermission();
    await run(async()=>{
      if(await permission!=='granted')throw Error('Notifications were not allowed. Review this siteâ€™s notification permission in Android Chrome.');
      let sub=await registration.pushManager.getSubscription();const key=applicationKey(status.publicKey);
      if(sub&&sub.options.applicationServerKey&&!Array.from(new Uint8Array(sub.options.applicationServerKey)).every((v,i)=>v===key[i])){await sub.unsubscribe();sub=null;}
      sub=sub||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
      const result=await request('push/subscribe',{subscription:sub.toJSON(),label});localStorage.setItem('zh-push-id',result.id);setCurrentId(result.id);await reload();setMessage('Enabled for future alarms. Use Send test to check this device.');
    });
  }
  if(!value)return <section className="panel config-panel"><h2>App & notifications</h2><p role={error?'alert':undefined}>{error||'Loading notification settingsâ€¦'}</p></section>;
  return <section className="panel config-panel"><header className="panel-heading"><h2>App & notifications</h2></header>
    <section className="config-section"><h3>Install on Android</h3><p>Open the HTTPS app address in Chrome, then install Zigbee Health from the browser menu. It opens in its own window.</p>{install?<button type="button" onClick={()=>run(installApp)} disabled={busy}>Install app</button>:<p className="small muted">Chrome menu â†’ Add to Home screen â†’ Install. If already installed, open it from your app drawer.</p>}</section>
    {admin?<form onSubmit={e=>{e.preventDefault();void run(async()=>{await request('push/settings',{publicOrigin:value.publicOrigin,enabled:value.enabled,recovery:value.recovery,includeDeviceNames:value.includeDeviceNames});setValue(await reload());setMessage('Notification settings saved.');});}}>
      <section className="config-section"><h3>HTTPS app address</h3><Field label="Public app address" type="url" placeholder="https://health.example.test" value={value.publicOrigin} onChange={change('publicOrigin')}/><p className="small muted">Use the hostname you route through your tunnel. Changing it disables existing browser subscriptions; enable them again at the new address.</p>
        <label className="checkbox-field"><input type="checkbox" disabled={demo} checked={value.enabled} onChange={change('enabled')}/>Enable browser push delivery</label>
        <label className="checkbox-field"><input type="checkbox" checked={value.recovery} onChange={change('recovery')}/>Send recovery notifications</label>
        <label className="checkbox-field"><input type="checkbox" checked={value.includeDeviceNames} onChange={change('includeDeviceNames')}/>Include device names and descriptions on the lock screen</label><button className="primary" disabled={busy}>Save notification settings</button>
      </section>
    </form>:<section className="config-section"><h3>Notification delivery</h3><p className="muted">An administrator manages the app address and global delivery settings. You can manage notifications for your own browsers below.</p><p><Badge tone={status.enabled?'healthy':'neutral'}>{status.enabled?'Push delivery enabled':'Push delivery disabled'}</Badge></p></section>}
    <section className="config-section"><h3>This device</h3><p>Push can arrive while the dashboard is closed. Android, browser permissions, connectivity and battery settings affect delivery. Email remains configured separately.</p>
      {!canReceive?<div className="notice">Health monitor access is required for browser alarm notifications.</div>:demo?<div className="notice">Push delivery is disabled in simulation.</div>:!canonical||!supported?<div className="notice">Open the saved HTTPS app address in a browser that supports Web Push to enable notifications.</div>:!status.enabled?<div className="notice">Save and enable browser push delivery first.</div>:null}
      <Field label="Device / browser name" maxLength={80} value={label} onChange={e=>setLabel(e.target.value)}/><button className="primary" disabled={!ready||busy||!label.trim()} onClick={enable}>Enable on this device</button>
      <p className="small muted">New subscriptions receive future alarms, without replaying the current stack. Acknowledgements and shunts suppress pending fault notifications. Signing out does not disable push; remove the browser below to stop it.</p>
    </section>
    <section className="config-section"><h3>Subscribed browsers</h3><div className="table-scroll"><table><thead><tr><th>Browser</th><th>Status</th><th>Last accepted</th><th>Actions</th></tr></thead><tbody>{status.subscriptions.map(s=><tr key={s.id}><td><strong>{s.label}</strong>{s.id===currentId?<span className="small muted"> Â· this device</span>:null}{s.last_error?<p className="small error-text">{s.last_error}</p>:null}</td><td><Badge tone={s.disabled_at?'warning':'healthy'}>{s.disabled_at?'Disabled':'Enabled'}</Badge></td><td>{date(s.last_success_at,true)}</td><td><div className="button-row"><button disabled={busy||!status.enabled||!!s.disabled_at||demo||!canReceive} onClick={()=>run(async()=>{const r=await request('push/test',{id:s.id});await reload();setMessage(r.status==='accepted'?'Push service accepted the test. Check the named device.':r.error||r.status);})}>Send test</button><button disabled={busy} onClick={()=>run(async()=>{await request('push/remove',{id:s.id});if(s.id===currentId){localStorage.removeItem('zh-push-id');setCurrentId('');const sub=await registration?.pushManager.getSubscription();await sub?.unsubscribe();}await reload();setMessage('Browser removed.');})}>Remove</button></div></td></tr>)}</tbody></table></div>{!status.subscriptions.length?<p className="muted">No browsers enabled yet.</p>:null}</section>
    <section className="config-section"><h3>Push delivery history</h3><p className="small muted">Accepted means the push service accepted the message; it does not prove it appeared on the phone. Uncertain attempts are retained without automatic retries.</p><div className="table-scroll"><table><thead><tr><th>Time</th><th>Type</th><th>Result</th><th>Detail</th></tr></thead><tbody>{status.deliveries.slice(0,20).map(d=><tr key={d.id}><td>{date(d.created_at,true)}</td><td>{d.kind}</td><td>{d.status}</td><td>{d.error||'â€”'}</td></tr>)}</tbody></table></div></section>
    {error?<div className="notice critical" role="alert">{error}</div>:null}{message?<div className="notice" role="status">{message}</div>:null}
  </section>;
}
