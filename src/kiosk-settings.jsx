import React,{useEffect,useState} from 'react';
import {request} from './api.jsx';
import {Badge,Field,Icon} from './ui.jsx';
import './kiosk-settings.css';

const draftOf=value=>({enabled:value.enabled===true,origin:value.origin||'',cidrText:(value.cidrs||[]).join('\n'),allAreas:value.allAreas!==false,areaIds:value.areaIds||[]});
const configOf=value=>({enabled:value.enabled,origin:value.origin.trim(),cidrs:value.cidrText.split(/\r?\n/).map(line=>line.trim()).filter(Boolean),allAreas:value.allAreas,areaIds:value.allAreas?[]:[...value.areaIds].sort()});
const equal=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
export default function KioskSettings(){
  const [saved,setSaved]=useState(null),[draft,setDraft]=useState(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false);
  async function load(signal){const value=await request('kiosk/settings',undefined,signal);setSaved(value);setDraft(draftOf(value));setConfirmed(false);return value;}
  useEffect(()=>{const controller=new AbortController();load(controller.signal).catch(error=>{if(error.name!=='AbortError')setError(error.message);});return()=>controller.abort();},[]);
  const change=(key,value)=>{setDraft(current=>({...current,[key]:value}));setConfirmed(false);setMessage('');setError('');};
  if(!draft)return <section className="panel config-panel kiosk-settings"><header className="panel-heading"><h2>Local kiosk</h2></header><p role={error?'alert':'status'}>{error||'Loading local kiosk settings…'}</p>{error?<button onClick={()=>{setError('');void load().catch(error=>setError(error.message));}}>Try again</button>:null}</section>;
  const value=configOf(draft),previous=configOf(draftOf(saved)),dirty=!equal(value,previous);
  const scopeChanged=value.origin!==previous.origin||!equal(value.cidrs,previous.cidrs)||value.allAreas!==previous.allAreas||!equal(value.areaIds,previous.areaIds);
  const needsConfirmation=dirty&&(value.enabled&&!previous.enabled||scopeChanged);
  const areas=saved.areas||[],missing=draft.areaIds.filter(id=>!areas.some(area=>area.id===id));
  const savedAddress=saved.origin?saved.origin.replace(/\/$/,'')+'/kiosk':'';
  async function submit(event){
    event.preventDefault();setError('');setMessage('');
    if(needsConfirmation&&!confirmed){setError('Confirm the local access and area scope before saving.');return;}
    if(value.enabled&&(!value.origin||!value.cidrs.length)){setError('Enter the direct local app origin and at least one permitted client CIDR before enabling the kiosk.');return;}
    if(value.enabled&&!value.allAreas&&!value.areaIds.length){setError('Select at least one area, or include all security areas.');return;}
    if(missing.length&&!value.allAreas){setError('Remove unavailable areas from the selection before saving.');return;}
    setBusy(true);
    try{await request('kiosk/settings',value);await load();setMessage('Local kiosk settings saved.');}
    catch(error){setError(error.message);}
    finally{setBusy(false);}
  }
  return <form className="panel config-panel kiosk-settings" onSubmit={submit}><header className="panel-heading"><h2>Local kiosk <Badge tone={saved.enabled?'healthy':'neutral'}>{saved.enabled?'Enabled':'Disabled'}</Badge></h2><button className="primary" disabled={busy||!dirty||needsConfirmation&&!confirmed}><Icon name="check"/>Save kiosk settings</button></header>
    <p className="config-intro">A dedicated keypad for a trusted local tablet. The main dashboard keeps its normal sign-in.</p>
    <div className="notice warning"><strong>Local viewing and arming without sign-in</strong><p>When enabled, anyone meeting the origin and network rules can view the selected areas and arm them. Disarming still requires a valid four-digit PIN with permission for those areas.</p></div>
    <section className="config-section"><h3>Local access</h3><label className="checkbox-field"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event=>change('enabled',event.target.checked)}/>Enable local kiosk</label>
      <Field label="Direct local app origin" type="url" maxLength={300} value={draft.origin} disabled={busy} onChange={event=>change('origin',event.target.value)} placeholder="http://192.168.1.20:18920" hint="Exact scheme, literal local IP and optional port. Do not include /kiosk or another path."/>
      <Field label="Permitted client CIDRs" hint="One CIDR per line, for the local clients or networks allowed to use the keypad."><textarea rows={4} maxLength={2048} spellCheck={false} value={draft.cidrText} disabled={busy} onChange={event=>change('cidrText',event.target.value)} placeholder="192.168.1.0/24"/></Field>
      <p className="small muted">Open the keypad through the direct local IP address. Hostnames, tunnels and reverse proxies are blocked. Settings start disabled with no app origin or permitted networks.</p>
      {savedAddress?<div className="kiosk-settings-address"><span>Saved kiosk address</span><code>{savedAddress}</code>{saved.enabled?<a className="button" href={savedAddress} target="_blank" rel="noreferrer"><Icon name="link"/>Open local keypad</a>:null}</div>:null}
    </section>
    <section className="config-section"><h3>Visible and armable areas</h3><label className="checkbox-field"><input type="checkbox" checked={draft.allAreas} disabled={busy} onChange={event=>change('allAreas',event.target.checked)}/>Include all security areas, including areas created later</label>
      {!draft.allAreas?<fieldset className="kiosk-settings-areas" disabled={busy}><legend>Selected kiosk areas</legend>{areas.length?areas.map(area=><label className="checkbox-field" key={area.id}><input type="checkbox" aria-label={'Allow kiosk area '+area.name} checked={draft.areaIds.includes(area.id)} onChange={event=>change('areaIds',event.target.checked?[...draft.areaIds,area.id]:draft.areaIds.filter(id=>id!==area.id))}/>{area.name}</label>):<p className="small muted">No security areas are available yet.</p>}{missing.map((id,index)=><label className="checkbox-field" key={id}><input type="checkbox" checked onChange={()=>change('areaIds',draft.areaIds.filter(value=>value!==id))}/>Unavailable area {index+1} · remove this selection</label>)}</fieldset>:<p className="small muted">All {areas.length} current security areas are included.</p>}
      <p className="small muted">A PIN can disarm only areas permitted by both its owner and this kiosk. Existing readiness checks still apply when arming.</p>
    </section>
    {needsConfirmation?<label className="checkbox-field kiosk-settings-confirm"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} disabled={busy}/>I confirm the local network and area scope. When enabled, people meeting these rules can view and arm without signing in; disarming requires an authorised PIN.</label>:null}
    {error?<div className="notice critical" role="alert">{error}</div>:null}{message?<div className="notice" role="status">{message}</div>:null}
    <footer className="kiosk-settings-footer"><span className="small muted">Only an administrator can change these settings.</span><button className="primary" disabled={busy||!dirty||needsConfirmation&&!confirmed}>{busy?'Saving…':'Save kiosk settings'}</button></footer>
  </form>;
}
