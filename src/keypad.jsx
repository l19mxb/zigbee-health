import React,{useEffect,useMemo,useRef,useState} from 'react';
import {request} from './api.jsx';
import {Icon,Modal} from './ui.jsx';
import {ThemeControl} from './theme.jsx';
import './keypad.css';

const count=(number,word)=>number+' '+word+(number===1?'':'s');
const editable=area=>area.mode==='disarmed'&&!['exit_delay','entry_delay'].includes(area.status);
function indicator(area){
  const issues=Array.isArray(area.zoneIssues)?area.zoneIssues:area.blockingZones||[];
  const alarm=!!area.activeAlarmCount||area.status==='alarm',invalid=!area.enabled||!(area.zoneCount>0);
  const trouble=invalid||(area.zoneTroubleCount??area.troubleCount??0)>0||issues.some(zone=>zone.trouble||['trouble','unknown'].includes(zone.status));
  const armed=['home','away'].includes(area.mode)||['home','away'].includes(area.targetMode)||['entry_delay','exit_delay'].includes(area.status);
  const readyOn=alarm||!invalid,readyFlashing=alarm||!invalid&&issues.length>0;
  const readyLabel=alarm?'Alarm':invalid?area.enabled?'No enabled zones':'Disabled':issues.length?'Not ready':'Ready';
  const armedLabel=area.status==='exit_delay'?'Exit delay':area.status==='entry_delay'?'Entry delay':armed?(area.mode==='home'||area.targetMode==='home'?'Armed Home':'Armed Away'):'Disarmed';
  const label=alarm?(area.mode==='disarmed'?'Alarm memory':'Alarm'):armed?armedLabel:invalid?(area.enabled?'No enabled zones':'Disabled'):trouble?'Trouble':readyLabel;
  return {label,readyOn,readyFlashing,readyLabel,trouble,armed,armedLabel};
}
function Led({tone,on=true,flashing=false,label}){return <span className={'keypad-led '+tone+(on?'':' off')+(on&&flashing?' flashing':'')} role={label?'img':undefined} aria-label={label} aria-hidden={label?undefined:true} title={label}/>;}
function AreaIndicators({status}){return <span className="keypad-led-cluster" role="group" aria-label="Area indicators"><span><Led tone="ready" on={status.readyOn} flashing={status.readyFlashing} label={'Ready indicator: '+status.readyLabel+(status.readyFlashing?', flashing green':status.readyOn?', steady green':', off')}/><small>{status.readyLabel==='Not ready'?'Not ready':status.readyLabel==='Alarm'?'Alarm':'Ready'}</small></span><span><Led tone="trouble" on={status.trouble} label={'Trouble indicator: '+(status.trouble?'on':'off')}/><small>Trouble</small></span><span><Led tone="armed" on={status.armed} label={'Armed indicator: '+status.armedLabel+(status.armed?', on':', off')}/><small>Armed</small></span></span>;}
function notReadyZones(areas){
  const zones=new Map();
  for(const area of areas)for(const zone of Array.isArray(area.zoneIssues)?area.zoneIssues:area.blockingZones||[]){
    const previous=zones.get(zone.id),areaNames=previous?[...previous.areaNames,area.name]:[area.name];
    const notes=[zone.bypassed?'Bypassed':null,zone.homeExcluded?'Bypassed in Home':null].filter(Boolean),contextNames=[...(previous?.contextNames||[]),...(notes.length?[area.name+': '+notes.join(', ')]:[])];
    zones.set(zone.id,{...zone,areaNames,contextNames,reason:zone.trouble||(zone.status==='unknown'?'Waiting for a fresh reading':zone.status==='active'?'Open / active':'Not ready')});
  }
  return [...zones.values()];
}
function PinPad({pin,onChange,disabled}){
  return <div className="keypad-pin-controls"><div className="keypad-pin-entry">
    <div className="keypad-pin-field"><input type="password" className="keypad-pin-input" aria-label="4-digit disarm PIN" aria-describedby="keypad-pin-help" inputMode="numeric" autoComplete="off" maxLength={4} pattern="[0-9]{4}" value={pin} disabled={disabled} onChange={event=>onChange(event.target.value.replace(/[^0-9]/g,'').slice(0,4))}/><span className="keypad-pin-dots" aria-hidden="true">{[0,1,2,3].map(index=><i key={index} className={index<pin.length?'filled':''}/>)}</span></div>
    <p id="keypad-pin-help">Enter your 4-digit PIN to disarm</p><span className="sr-only" role="status" aria-live="polite">{pin.length} of 4 digits entered</span>
  </div><div className="keypad-digits" aria-label="PIN keypad">{[1,2,3,4,5,6,7,8,9].map(number=><button key={number} type="button" aria-label={'PIN digit '+number} disabled={disabled||pin.length===4} onClick={()=>onChange(pin+number)}>{number}</button>)}<button type="button" className="keypad-edit-digit" disabled={disabled||!pin} onClick={()=>onChange('')}>Clear</button><button type="button" aria-label="PIN digit 0" disabled={disabled||pin.length===4} onClick={()=>onChange(pin+'0')}>0</button><button type="button" className="keypad-edit-digit" aria-label="Backspace PIN digit" disabled={disabled||!pin} onClick={()=>onChange(pin.slice(0,-1))}>Backspace</button></div></div>;
}

export default function Keypad({onSecurity}){
  const [state,setState]=useState(null),[loading,setLoading]=useState(true),[connectionError,setConnectionError]=useState(''),[commandError,setCommandError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[selection,setSelection]=useState(null),[pin,setPin]=useState(''),[carousel,setCarousel]=useState(0),[dialog,setDialog]=useState(null),[clock,setClock]=useState(Date.now());
  const pending=useRef(null),received=useRef(Date.now());
  async function refresh(){
    pending.current?.abort();const controller=new AbortController();pending.current=controller;
    try{const value=await request('keypad',undefined,controller.signal);received.current=Date.now();setState(value);setConnectionError('');return value;}
    catch(error){if(error.name!=='AbortError'){setConnectionError(error.message);setPin('');}}
    finally{if(!controller.signal.aborted)setLoading(false);}
  }
  useEffect(()=>{void refresh();const poll=setInterval(()=>void refresh(),3000),tick=setInterval(()=>setClock(Date.now()),1000);const clear=()=>setPin(''),hidden=()=>{if(document.hidden)clear();};document.addEventListener('visibilitychange',hidden);window.addEventListener('pagehide',clear);return()=>{clearInterval(poll);clearInterval(tick);pending.current?.abort();document.removeEventListener('visibilitychange',hidden);window.removeEventListener('pagehide',clear);};},[]);
  useEffect(()=>{if(!pin)return;const timer=setTimeout(()=>setPin(''),30000);return()=>clearTimeout(timer);},[pin]);
  const timezone=state?.timezone||'UTC';
  const formats=useMemo(()=>({time:new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}),date:new Intl.DateTimeFormat('en-GB',{timeZone:timezone,weekday:'long',day:'numeric',month:'long'})}),[timezone]);
  const now=(state?.now??Date.now())+Math.max(0,clock-received.current),areas=state?.areas||[];
  const selectedIds=(selection===null?areas.slice(0,1).map(area=>area.id):selection).filter(id=>areas.some(area=>area.id===id));
  const selected=areas.filter(area=>selectedIds.includes(area.id)),zones=notReadyZones(selected),index=Math.min(carousel,Math.max(0,zones.length-1)),zone=zones[index];
  const available=!!state&&!state.readOnly&&!connectionError&&!busy;
  const armReady=selected.length>0&&selected.every(area=>editable(area)&&area.enabled&&area.readyAway&&!area.activeAlarmCount);
  const mayArm=available&&state.canArm&&armReady,mayDisarm=available&&pin.length===4;
  const choose=ids=>{setSelection(ids);setCarousel(0);setPin('');setCommandError('');setMessage('');};
  async function command(action,all=false){
    if(!available)return;
    const body={action,...(all?{all:true}:{areaIds:selectedIds}),...(action==='disarm'?{pin}:{})};
    setBusy(true);setCommandError('');setMessage('');setPin('');setDialog(null);
    try{const result=await request('keypad/command',body);setMessage((action==='disarm'?'Disarmed ':'Armed Away · ')+count(result.areaIds?.length||0,'area')+'.');await refresh();}
    catch(error){setCommandError(error.message);}
    finally{setBusy(false);}
  }
  const closeDialog=()=>{if(!busy){setDialog(null);if(dialog==='disarm-all')setPin('');}};
  return <div className="keypad-workspace"><header className="keypad-header"><h1>Keypad</h1><div><ThemeControl/><time dateTime={new Date(now).toISOString()} aria-live="off"><strong>{formats.time.format(now)}</strong><span>{formats.date.format(now)}</span></time></div></header>
    {connectionError?<div className="notice critical" role="alert"><strong>Keypad connection lost.</strong> Showing the last received state. Controls are unavailable until reconnection.<button onClick={refresh}>Reconnect</button></div>:null}
    {state?.message?<div className="notice" role="status">{state.message}</div>:null}
    {commandError?<div className="notice critical" role="alert">{commandError}</div>:null}{message?<div className="notice" role="status">{message}</div>:null}
    {!state?<div className="keypad-loading" role={connectionError?'alert':'status'}>{loading?'Opening keypad…':connectionError}{connectionError?<button onClick={refresh}>Try again</button>:null}</div>:!areas.length?<section className="keypad-empty"><Icon name="shield" size={35}/><h2>No security areas configured</h2><p>An administrator can add areas and zones under Security. New areas start disarmed.</p>{onSecurity?<button onClick={onSecurity}>Open Security</button>:null}</section>:<div className="keypad-console">
      <section className="keypad-areas" aria-label="Keypad areas"><div className="keypad-areas-heading"><h2>Areas</h2><button disabled={busy} onClick={()=>choose(selectedIds.length===areas.length?[]:areas.map(area=>area.id))}>{selectedIds.length===areas.length?'Clear selection':'Select all'}</button></div><div className="keypad-area-list">{areas.map(area=>{const status=indicator(area),checked=selectedIds.includes(area.id);return <label key={area.id} className={'keypad-area-row '+(checked?'selected':'')}><input type="checkbox" aria-label={'Select area '+area.name} checked={checked} disabled={busy} onChange={event=>choose(event.target.checked?[...selectedIds,area.id]:selectedIds.filter(id=>id!==area.id))}/><span className="keypad-area-copy"><strong>{area.name}</strong><small>{status.label}</small></span><AreaIndicators status={status}/></label>;})}</div><div className="keypad-legend" aria-label="Area status legend"><span><Led tone="ready"/>Ready</span><span><Led tone="ready" flashing/>Not ready / alarm</span><span><Led tone="trouble"/>Trouble</span><span><Led tone="armed"/>Armed</span></div></section>
      <section className="keypad-control-panel" aria-label="Area keypad"><header className="keypad-selection"><h2>{selected.length===1?selected[0].name:selected.length?count(selected.length,'area')+' selected':'Select areas'}</h2><p>{selected.length===1?'1 area selected':selected.length?selected.map(area=>area.name).join(', '):'Choose one or more areas from the list.'}</p></header>
        <div className="keypad-not-ready-carousel" aria-live="polite"><button className="icon-button" aria-label="Previous not ready zone" disabled={zones.length<2} onClick={()=>setCarousel((index+zones.length-1)%zones.length)}><Icon name="chevron" className="flip" size={25}/></button><div>{zone?<><strong>{zone.name}</strong><p>{zone.reason} · {index+1} of {zones.length} not ready</p>{selected.length>1?<small>{zone.areaNames.join(', ')}</small>:null}{zone.contextNames.length?<small>{zone.contextNames.join('; ')}</small>:null}</>:<><strong>{!selected.length?'Select an area':armReady?'All selected areas ready':selected.every(area=>area.mode!=='disarmed')?'Selected areas armed':'Area status'}</strong><p>{!selected.length?'Area selection is required for commands.':armReady?'Ready to arm Away':selected.some(area=>area.activeAlarmCount)?'Alarm memory must be acknowledged and reset in Security.':selected.some(area=>!area.enabled)?'One or more selected areas are disabled.':selected.some(area=>!area.zoneCount)?'Add an enabled zone before arming.':'Review the selected area status before arming.'}</p></>}</div><button className="icon-button" aria-label="Next not ready zone" disabled={zones.length<2} onClick={()=>setCarousel((index+1)%zones.length)}><Icon name="chevron" size={25}/></button></div>
        <button className="text-button keypad-all-zones" disabled={!zones.length} onClick={()=>setDialog('zones')}>Show all not ready zones</button>
        <div className="keypad-entry-grid"><PinPad pin={pin} onChange={setPin} disabled={busy||!!connectionError||state.readOnly}/><div className="keypad-command-buttons"><button className="primary" disabled={!mayArm} title={!state.canArm?'Security control access is required':!armReady?'Select only disarmed, ready areas to arm':undefined} onClick={()=>void command('arm_away')}>Arm away</button><button className="keypad-disarm-selected" disabled={!mayDisarm||!selected.length} onClick={()=>void command('disarm')}>Disarm selected</button><button className="keypad-disarm-all" disabled={!mayDisarm} onClick={()=>setDialog('disarm-all')}>Disarm all assigned</button></div></div>
        <p className="keypad-footnote">Arm away does not need a PIN.{!state.canArm?' Your session needs security control access to arm areas.':''}</p>
      </section>
    </div>}
    {dialog==='zones'?<Modal title="Not ready zones" wide onClose={closeDialog}><p className="keypad-zone-help">Enabled zones that are open or have trouble, including zones bypassed manually or in Home mode. Arming follows the existing area rules.</p><div className="table-scroll keypad-zone-table"><table><thead><tr><th>Zone</th><th>Area</th><th>Reason</th></tr></thead><tbody>{zones.map(item=><tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.areaNames.join(', ')}</td><td>{item.reason}{item.contextNames.length?<span className="row-subtitle">{item.contextNames.join('; ')}</span>:null}</td></tr>)}</tbody></table></div><div className="form-actions"><button onClick={closeDialog}>Close</button></div></Modal>:dialog==='disarm-all'?<Modal title="Disarm all assigned areas" onClose={closeDialog}><p>Disarm every area assigned to the entered PIN, including areas not selected on this screen. The PIN owner must have security control access.</p><div className="form-actions"><button disabled={busy} onClick={closeDialog}>Cancel</button><button className="primary" disabled={!mayDisarm} onClick={()=>void command('disarm',true)}>Disarm all assigned</button></div></Modal>:null}
  </div>;
}
