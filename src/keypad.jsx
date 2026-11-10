import React,{useEffect,useMemo,useRef,useState} from 'react';
import {request} from './api.jsx';
import {Field,Icon,Modal} from './ui.jsx';
import {ThemeControl} from './theme.jsx';
import {createKeypadAudio,keypadSoundKey,readKeypadSound,writeKeypadSound} from './keypad-audio.mjs';
import './keypad.css';

const count=(number,word)=>number+' '+word+(number===1?'':'s');
const editable=area=>area.mode==='disarmed'&&!['exit_delay','entry_delay'].includes(area.status);
const mayBypassForForce=zone=>zone.status==='active'&&zone.trouble===null;
const mayAwaitForForce=zone=>zone.status==='unknown'&&zone.awaitingReading===true;
const validBypassComment=comment=>typeof comment==='string'&&comment.length<=300&&!/[\u0000-\u001f\u007f]/.test(comment);

function forceArmBlock(areas){
  for(const area of areas){
    if(!editable(area))return 'Select disarmed areas for Force Arm.';
    if(!area.enabled)return area.name+' is disabled.';
    if(area.activeAlarmCount)return 'Reset alarm memory in '+area.name+' before arming.';
    if(!area.zoneCount)return 'Add an enabled zone to '+area.name+' before arming.';
    const blockers=area.blockingZones||[];
    const fault=blockers.find(zone=>!mayBypassForForce(zone)&&!mayAwaitForForce(zone));
    if(fault)return 'Resolve the issue with '+fault.name+' in '+area.name+' before using Force Arm.';
    if(!(area.includedCount>blockers.filter(mayBypassForForce).length))return 'Keep at least one included zone in '+area.name+'.';
  }
  return '';
}
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
  for(const area of areas){
    const cycleIds=new Set((area.cycleBypasses||[]).map(zone=>zone.id));
    const awaitingIds=new Set((area.awaitingZones||[]).map(zone=>zone.id));
    for(const zone of Array.isArray(area.zoneIssues)?area.zoneIssues:area.blockingZones||[]){
      const previous=zones.get(zone.id),areaNames=previous?[...previous.areaNames,area.name]:[area.name];
      const notes=[(zone.manualBypassed??(zone.bypassed&&!zone.cycleBypassed))?'Manually bypassed':null,zone.homeExcluded?'Bypassed in Home':null,zone.cycleBypassed||cycleIds.has(zone.id)?'Bypassed until disarm':null,awaitingIds.has(zone.id)?'Included by Force Arm':null].filter(Boolean),contextNames=[...(previous?.contextNames||[]),...(notes.length?[area.name+': '+notes.join(', ')]:[])];
      zones.set(zone.id,{...zone,areaNames,contextNames,reason:zone.trouble||(zone.status==='unknown'?'Waiting for a fresh reading':zone.status==='active'?'Open / active':'Not ready')});
    }
  }
  return [...zones.values()];
}
const zoneConditions=zones=>zones.map(zone=>({id:zone.id,status:zone.status,trouble:zone.trouble||null})).sort((a,b)=>a.id.localeCompare(b.id));
function reviewSignature(areas,force,preview=false){
  const plans=areas.map(area=>{
    const blockers=area.blockingZones||[];
    const bypass=force&&!preview?blockers.filter(mayBypassForForce):blockers;
    const awaiting=force?(preview?area.awaitingZones:blockers.filter(mayAwaitForForce)):[];
    return {id:area.id,bypass:zoneConditions(bypass),awaiting:zoneConditions(awaiting),
      protectedZoneCount:preview?area.protectedZoneCount:area.includedCount-bypass.length};
  });
  return JSON.stringify(plans.sort((a,b)=>a.id.localeCompare(b.id)));
}
const armingContext=value=>JSON.stringify({ids:(value.areas||[]).map(area=>area.id).sort(),revision:value.armingRevision||null,canArm:!!value.canArm,canBypassArm:!!value.canBypassArm,canForceArm:!!value.canForceArm,readOnly:!!value.readOnly});
function reviewMatches(review,value){
  const areas=review.areaIds.map(id=>(value?.areas||[]).find(area=>area.id===id));
  const force=review.intent==='force';
  const permitted=force?value?.canForceArm:value?.canBypassArm;
  if(!permitted||value.readOnly||value.armingRevision!==review.revision||!areas.every(area=>area&&editable(area)&&area.enabled&&!area.activeAlarmCount))return false;
  return (!force||!forceArmBlock(areas))&&reviewSignature(areas,force)===review.signature;
}
function CycleBypasses({areas}){
  const active=areas.filter(area=>area.cycleBypassCount>0||(area.cycleBypasses||[]).length);
  if(!active.length)return null;
  return <section className="keypad-cycle-bypasses" aria-label="Current arming cycle bypasses">{active.map(area=>{const number=area.cycleBypassCount??area.cycleBypasses.length;return <div key={area.id}><strong>{area.name} · {number} cycle {number===1?'bypass':'bypasses'}</strong><span>{(area.cycleBypasses||[]).map(zone=>zone.name).join(', ')}</span></div>;})}<p>These zones remain excluded until their area disarms.</p></section>;
}
function ReviewZones({title,zones}){
  return <><h4>{title}</h4><ul>{zones.map(zone=><li key={zone.id}><strong>{zone.name}</strong><span>{zone.trouble||(zone.status==='unknown'?'Waiting for a fresh reading':'Open / active')}</span></li>)}</ul></>;
}
function ArmBypassReview({review,now,busy,onClose,onConfirm}){
  const [comment,setComment]=useState('');
  const force=review.intent==='force';
  const remaining=Math.max(0,Math.ceil((review.expiresAt-now)/1000));
  const excluded=review.areas.some(area=>area.blockingZones.length);
  const awaiting=force&&review.areas.some(area=>area.awaitingZones.length);
  const ready=remaining>0&&validBypassComment(comment)&&review.areas.every(area=>area.protectedZoneCount>0);
  return <Modal title={force?'Force Arm Away':'Bypass and arm Away'} wide onClose={onClose}><form className="keypad-bypass-review" onSubmit={event=>{event.preventDefault();if(ready&&!busy)void onConfirm(comment.trim());}}>
    <div className={'notice'+(excluded?' warning':'')}>
      <strong>{excluded?'The listed bypasses last until each area disarms.':'All included zones stay in this arming cycle.'}</strong>
      {awaiting?<p>A waiting zone can raise an alarm when a fresh report shows it open or active.</p>:null}
    </div>
    <div className="keypad-bypass-review-areas">{review.areas.map(area=><section key={area.id}>
      <h3>{area.name}</h3>
      <p>{count(area.protectedZoneCount,'zone')} will stay included.</p>
      {area.blockingZones.length?<ReviewZones title="Bypassed until disarm" zones={area.blockingZones}/>:null}
      {force&&area.awaitingZones.length?<ReviewZones title="Awaiting a fresh reading · stays included" zones={area.awaitingZones}/>:null}
    </section>)}</div>
    <p className="keypad-review-expiry" aria-live="off">Review expires in {Math.floor(remaining/60)}:{String(remaining%60).padStart(2,'0')}</p>
    {!force?<Field label="Comment (optional)" hint="Recorded with the arming event." maxLength={300} value={comment} disabled={busy}
      onChange={event=>setComment(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')event.preventDefault();}}/>:null}
    <div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy||!ready}>{busy?'Arming…':force?'Force Arm selected':'Bypass and arm selected'}</button></div>
  </form></Modal>;
}
function PinPad({pin,onChange,disabled,onPhysicalKey}){
  return <div className="keypad-pin-controls"><div className="keypad-pin-entry">
    <div className="keypad-pin-field"><input type="password" className="keypad-pin-input" aria-label="4-digit disarm PIN" aria-describedby="keypad-pin-help" inputMode="numeric" autoComplete="off" maxLength={4} pattern="[0-9]{4}" value={pin} disabled={disabled} onChange={event=>onChange(event.target.value.replace(/[^0-9]/g,'').slice(0,4))} onKeyDown={event=>{if(disabled||!event.isTrusted||event.repeat||event.ctrlKey||event.metaKey||event.altKey)return;const start=event.currentTarget.selectionStart??pin.length,end=event.currentTarget.selectionEnd??start,selected=end>start;if(/^[0-9]$/.test(event.key)&&(pin.length<4||selected)||event.key==='Backspace'&&(selected||start>0)||event.key==='Delete'&&(selected||start<pin.length))onPhysicalKey?.();}}/><span className="keypad-pin-dots" aria-hidden="true">{[0,1,2,3].map(index=><i key={index} className={index<pin.length?'filled':''}/>)}</span></div>
    <p id="keypad-pin-help">Enter your 4-digit PIN to disarm</p><span className="sr-only" role="status" aria-live="polite">{pin.length} of 4 digits entered</span>
  </div><div className="keypad-digits" aria-label="PIN keypad">{[1,2,3,4,5,6,7,8,9].map(number=><button key={number} type="button" aria-label={'PIN digit '+number} disabled={disabled||pin.length===4} onClick={()=>onChange(pin+number)}>{number}</button>)}<button type="button" className="keypad-edit-digit" disabled={disabled||!pin} onClick={()=>onChange('')}>Clear</button><button type="button" aria-label="PIN digit 0" disabled={disabled||pin.length===4} onClick={()=>onChange(pin+'0')}>0</button><button type="button" className="keypad-edit-digit" aria-label="Backspace PIN digit" disabled={disabled||!pin} onClick={()=>onChange(pin.slice(0,-1))}>Backspace</button></div></div>;
}

export default function Keypad({onSecurity,kiosk=false,requestApi=request}){
  const [soundEnabled,setSoundEnabled]=useState(()=>readKeypadSound()),[soundStatus,setSoundStatus]=useState({unlocked:false,supported:null});
  const [state,setState]=useState(null),[loading,setLoading]=useState(true),[connectionError,setConnectionError]=useState(''),[commandError,setCommandError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[selection,setSelection]=useState(null),[pin,setPin]=useState(''),[carousel,setCarousel]=useState(0),[dialog,setDialog]=useState(null),[clock,setClock]=useState(Date.now()),[armReview,setArmReview]=useState(null);
  const pending=useRef(null),received=useRef(Date.now()),context=useRef(null),latestState=useRef(null),reviewRef=useRef(null),reviewEpoch=useRef(0),reviewFlight=useRef(false),sound=useRef(null);
  function feedback(method,value){try{sound.current?.[method](value);}catch{/* Audio never changes keypad operations. */}}
  useEffect(()=>{const audio=createKeypadAudio({enabled:soundEnabled,visible:!document.hidden,onStatus:setSoundStatus});sound.current=audio;const visibility=()=>audio.setVisible(!document.hidden),hide=()=>audio.setVisible(false),sync=event=>{if(event.key===keypadSoundKey||event.key===null){const enabled=readKeypadSound();setSoundEnabled(enabled);audio.setEnabled(enabled);}};document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',hide);window.addEventListener('pageshow',visibility);window.addEventListener('storage',sync);return()=>{audio.destroy();if(sound.current===audio)sound.current=null;document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',hide);window.removeEventListener('pageshow',visibility);window.removeEventListener('storage',sync);};},[]);
  function toggleSound(){const enabled=!soundEnabled;setSoundEnabled(enabled);writeKeypadSound(enabled);feedback('setEnabled',enabled);if(enabled)feedback('gesture',{pip:true});}
  function buttonFeedback(event){const button=event.target.closest?.('button');if(event.isTrusted&&button&&!button.disabled&&!button.hasAttribute('data-keypad-sound-toggle'))feedback('gesture',{pip:true});}
  function discardReview(){reviewEpoch.current++;reviewRef.current=null;setArmReview(null);setDialog(null);setPin('');}
  async function refresh(){
    pending.current?.abort();const controller=new AbortController();pending.current=controller;
    try{
      const value=await requestApi(kiosk?'kiosk/state':'keypad',undefined,controller.signal);if(controller.signal.aborted)return;const nextContext=armingContext(value);latestState.current=value;feedback('observe',value);
      if(context.current!==null&&context.current!==nextContext){const hadReview=!!reviewRef.current;discardReview();if(hadReview)setCommandError('Area settings or permissions changed. Review the zones again before arming.');}
      context.current=nextContext;
      if(reviewRef.current&&!reviewMatches(reviewRef.current,value)){discardReview();setCommandError('Zone conditions changed. Review the zones again before arming.');}
      received.current=Date.now();setState(value);setConnectionError('');return value;
    }
    catch(error){if(error.name!=='AbortError'){feedback('disconnect');setConnectionError(error.message);discardReview();if(kiosk){latestState.current=null;setState(null);}}}
    finally{if(!controller.signal.aborted)setLoading(false);}
  }
  useEffect(()=>{void refresh();const poll=setInterval(()=>void refresh(),3000),tick=setInterval(()=>setClock(Date.now()),1000);const clear=()=>{setPin('');if(reviewRef.current||reviewFlight.current)discardReview();},hidden=()=>{if(document.hidden)clear();};document.addEventListener('visibilitychange',hidden);window.addEventListener('pagehide',clear);return()=>{clearInterval(poll);clearInterval(tick);pending.current?.abort();document.removeEventListener('visibilitychange',hidden);window.removeEventListener('pagehide',clear);};},[]);
  useEffect(()=>{if(!pin)return;const timer=setTimeout(()=>setPin(''),30000);return()=>clearTimeout(timer);},[pin]);
  const timezone=state?.timezone||'UTC';
  const formats=useMemo(()=>({time:new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}),date:new Intl.DateTimeFormat('en-GB',{timeZone:timezone,weekday:'long',day:'numeric',month:'long'})}),[timezone]);
  const now=(state?.now??Date.now())+Math.max(0,clock-received.current),areas=state?.areas||[];
  useEffect(()=>{if(armReview&&now>=armReview.expiresAt){discardReview();setCommandError('Bypass review expired. Review the zones again before arming.');}},[armReview,now]);
  const selectedIds=(selection===null?areas.slice(0,1).map(area=>area.id):selection).filter(id=>areas.some(area=>area.id===id));
  const selected=areas.filter(area=>selectedIds.includes(area.id)),zones=notReadyZones(selected),index=Math.min(carousel,Math.max(0,zones.length-1)),zone=zones[index];
  const available=!!state&&!state.readOnly&&!connectionError&&!busy;
  const armReady=selected.length>0&&selected.every(area=>editable(area)&&area.enabled&&area.readyAway&&!area.activeAlarmCount);
  const mayArm=available&&state.canArm&&armReady,mayDisarm=available&&pin.length===4;
  const showBypassArm=!!state?.canBypassArm&&!armReady&&selected.length>0&&selected.every(editable);
  const mayBypassArm=available&&state.canArm&&showBypassArm&&typeof state.armingRevision==='string'&&selected.every(area=>area.enabled&&area.zoneCount>0&&!area.activeAlarmCount);
  const showForceArm=!!state?.canForceArm&&!armReady&&selected.length>0;
  const forceBlock=showForceArm&&(forceArmBlock(selected)||(!selected.some(area=>area.blockingZones?.length)?'Force Arm needs an open zone or a zone awaiting a reading.':''));
  const mayForceArm=available&&state.canArm&&showForceArm&&typeof state.armingRevision==='string'&&!forceBlock;
  const choose=ids=>{discardReview();setSelection(ids);setCarousel(0);setCommandError('');setMessage('');};
  async function command(action,all=false){
    if(!available)return;
    const body={action,...(all?{all:true}:{areaIds:selectedIds}),...(action==='disarm'?{pin}:{})};
    setBusy(true);setCommandError('');setMessage('');discardReview();
    try{const result=await requestApi(kiosk?'kiosk/command':'keypad/command',body);pending.current?.abort();feedback('accepted',result);setMessage((action==='disarm'?'Disarmed ':'Armed Away · ')+count(result.areaIds?.length||0,'area')+'.');await refresh();}
    catch(error){setCommandError(error.message);if(kiosk&&error.status===403){setState(null);await refresh();}}
    finally{setBusy(false);}
  }
  async function prepareBypass(intent){
    const force=intent==='force';
    if(!(force?mayForceArm:mayBypassArm)||reviewFlight.current)return;
    discardReview();const epoch=reviewEpoch.current,areaIds=[...selectedIds];reviewFlight.current=true;setBusy(true);setCommandError('');setMessage('');
    try{
      const action=force?'prepare_force_arm_away':'prepare_arm_away';
      const result=await requestApi(kiosk?'kiosk/command':'keypad/command',{action,areaIds}),preview=result.preview;
      if(epoch!==reviewEpoch.current)return;
      const fresh=await refresh();
      if(!fresh||epoch!==reviewEpoch.current)throw Error('Area settings changed. Review the current zones again.');
      const reviewError='The bypass review could not be verified. Review the current zones again.';
      if(result.action!==action)throw Error(reviewError);
      if(!preview||typeof preview.token!=='string'||!preview.token||!Number.isFinite(preview.expiresAt)||preview.expiresAt<=fresh.now||!Array.isArray(preview.areas)||preview.areas.length!==areaIds.length)throw Error(reviewError);
      const previewIds=new Set(preview.areas.map(area=>area.id));
      if(previewIds.size!==areaIds.length||preview.areas.some(area=>!areaIds.includes(area.id)||!Array.isArray(area.blockingZones)
        ||force&&!Array.isArray(area.awaitingZones)||!Number.isInteger(area.protectedZoneCount)||area.protectedZoneCount<1))throw Error(reviewError);
      const value={...preview,intent,areaIds,revision:fresh.armingRevision,signature:reviewSignature(preview.areas,force,true),epoch};
      if(!reviewMatches(value,fresh))throw Error('Zone conditions changed. Review the current zones again.');
      if(!preview.areas.some(area=>area.blockingZones.length||force&&area.awaitingZones.length)){setMessage('The selected areas are ready. Use Arm away.');return;}
      reviewRef.current=value;setArmReview(value);setDialog('bypass-arm');
    }catch(error){discardReview();setCommandError(error.message);if(kiosk&&error.status===403){setState(null);await refresh();}}
    finally{reviewFlight.current=false;setBusy(false);}
  }
  async function confirmBypass(comment){
    const review=reviewRef.current;
    if(reviewFlight.current||!available)return;
    const force=review?.intent==='force';
    if(!review||review.epoch!==reviewEpoch.current||now>=review.expiresAt||!reviewMatches(review,latestState.current)||!validBypassComment(comment)){discardReview();setCommandError('Bypass review is no longer current. Review the zones again before arming.');return;}
    const reason=force?'':comment.trim();
    const body={action:force?'force_arm_away':'arm_away',areaIds:[...review.areaIds],bypass:{token:review.token,...(reason?{reason}:{})}};
    const hadBypasses=review.areas.some(area=>area.blockingZones.length);
    reviewFlight.current=true;setBusy(true);discardReview();setCommandError('');setMessage('Applying the reviewed arm command…');
    try{const result=await requestApi(kiosk?'kiosk/command':'keypad/command',body);pending.current?.abort();feedback('accepted',result);setMessage('Away arming accepted for '+count(result.areaIds?.length||0,'area')+'.'+(hadBypasses?' Cycle bypasses end when each area disarms.':''));await refresh();}
    catch(error){discardReview();setMessage('');setCommandError(error.message+' Review the zones again before arming.');if(kiosk&&error.status===403){setState(null);await refresh();}}
    finally{reviewFlight.current=false;setBusy(false);}
  }
  const closeDialog=()=>{if(!busy){if(dialog==='bypass-arm')discardReview();else{setDialog(null);if(dialog==='disarm-all')setPin('');}}};
  return <div className="keypad-workspace" onPointerDownCapture={event=>{if(event.isTrusted)feedback('gesture',{pip:false});}} onClickCapture={buttonFeedback}><header className="keypad-header"><h1>Keypad</h1><div><div className="keypad-sound-control"><button type="button" data-keypad-sound-toggle aria-pressed={soundEnabled} aria-label={soundEnabled?'Mute keypad sound':'Enable keypad sound'} onClick={toggleSound}>{soundEnabled?'Sound on':'Sound off'}</button><small>{!soundEnabled?'Muted':soundStatus.supported===false?'Audio unavailable':soundStatus.unlocked?'Enabled':'Tap a key to enable'}</small></div><ThemeControl/><time dateTime={new Date(now).toISOString()} aria-live="off"><strong>{formats.time.format(now)}</strong><span>{formats.date.format(now)}</span></time></div></header>
    {connectionError&&!kiosk?<div className="notice critical" role="alert"><strong>Keypad connection lost.</strong> Showing the last received state. Controls are unavailable until reconnection.<button onClick={refresh}>Reconnect</button></div>:null}
    {state?.message?<div className="notice" role="status">{state.message}</div>:null}
    {commandError?<div className="notice critical" role="alert">{commandError}</div>:null}{message?<div className="notice" role="status">{message}</div>:null}
    {!state?kiosk&&connectionError?<section className="kiosk-unavailable"><Icon name="shield" size={35}/><h2>Local keypad unavailable</h2><p role="alert">{connectionError}</p><p>Open the configured direct local IP address from an allowed local network. Tunnels and reverse proxies cannot open this keypad.</p><button onClick={refresh}>Try again</button></section>:<div className="keypad-loading" role={connectionError?'alert':'status'}>{loading?'Opening keypad…':connectionError}{connectionError?<button onClick={refresh}>Try again</button>:null}</div>:!areas.length?<section className="keypad-empty"><Icon name="shield" size={35}/><h2>{kiosk?'No areas available on this kiosk':'No security areas configured'}</h2><p>{kiosk?'An administrator can update the local kiosk area selection.':'An administrator can add areas and zones under Security. New areas start disarmed.'}</p>{onSecurity&&!kiosk?<button onClick={onSecurity}>Open Security</button>:null}</section>:<div className="keypad-console">
      <section className="keypad-areas" aria-label="Keypad areas"><div className="keypad-areas-heading"><h2>Areas</h2><button disabled={busy} onClick={()=>choose(selectedIds.length===areas.length?[]:areas.map(area=>area.id))}>{selectedIds.length===areas.length?'Clear selection':'Select all'}</button></div><div className="keypad-area-list">{areas.map(area=>{const status=indicator(area),checked=selectedIds.includes(area.id);return <label key={area.id} className={'keypad-area-row '+(checked?'selected':'')}><input type="checkbox" aria-label={'Select area '+area.name} checked={checked} disabled={busy} onChange={event=>choose(event.target.checked?[...selectedIds,area.id]:selectedIds.filter(id=>id!==area.id))}/><span className="keypad-area-copy"><strong>{area.name}</strong><small>{status.label}</small>{area.cycleBypassCount>0?<small className="keypad-cycle-count">{area.cycleBypassCount} cycle {area.cycleBypassCount===1?'bypass':'bypasses'}</small>:null}</span><AreaIndicators status={status}/></label>;})}</div></section>
      <section className="keypad-control-panel" aria-label="Area keypad"><header className="keypad-selection"><h2>{selected.length===1?selected[0].name:selected.length?count(selected.length,'area')+' selected':'Select areas'}</h2><p>{selected.length===1?'1 area selected':selected.length?selected.map(area=>area.name).join(', '):'Choose one or more areas from the list.'}</p></header>
        <CycleBypasses areas={selected}/>
        <div className="keypad-not-ready-carousel" aria-live="polite"><button className="icon-button" aria-label="Previous not ready zone" disabled={zones.length<2} onClick={()=>setCarousel((index+zones.length-1)%zones.length)}><Icon name="chevron" className="flip" size={25}/></button><div>{zone?<><strong>{zone.name}</strong><p>{zone.reason} · {index+1} of {zones.length} not ready</p>{selected.length>1?<small>{zone.areaNames.join(', ')}</small>:null}{zone.contextNames.length?<small>{zone.contextNames.join('; ')}</small>:null}</>:<><strong>{!selected.length?'Select an area':armReady?'All selected areas ready':selected.every(area=>area.mode!=='disarmed')?'Selected areas armed':'Area status'}</strong><p>{!selected.length?'Area selection is required for commands.':armReady?'Ready to arm Away':selected.some(area=>area.activeAlarmCount)?'Alarm memory must be acknowledged and reset in Security.':selected.some(area=>!area.enabled)?'One or more selected areas are disabled.':selected.some(area=>!area.zoneCount)?'Add an enabled zone before arming.':'Review the selected area status before arming.'}</p></>}</div><button className="icon-button" aria-label="Next not ready zone" disabled={zones.length<2} onClick={()=>setCarousel((index+1)%zones.length)}><Icon name="chevron" size={25}/></button></div>
        <button className="text-button keypad-all-zones" disabled={!zones.length} onClick={()=>setDialog('zones')}>Show all not ready zones</button>
        <div className="keypad-entry-grid">
          <PinPad pin={pin} onChange={setPin} disabled={busy||!!connectionError||state.readOnly} onPhysicalKey={()=>feedback('gesture',{pip:true})}/>
          <div className="keypad-command-buttons">
            <button className="primary" disabled={!mayArm} title={!state.canArm?'Security control access is required':!armReady?'Select only disarmed, ready areas to arm':undefined} onClick={()=>void command('arm_away')}>Arm away</button>
            {showBypassArm||showForceArm?<div className="keypad-arm-options">
              {showForceArm?<button className="keypad-force-arm" disabled={!mayForceArm} aria-describedby={forceBlock?'keypad-force-block':undefined} title="Review open and waiting zones before Force Arm" onClick={()=>void prepareBypass('force')}>Force Arm</button>:null}
              {showBypassArm?<button className="keypad-bypass-arm" disabled={!mayBypassArm} title="Review exact cycle exclusions before arming" onClick={()=>void prepareBypass('bypass')}>Bypass and arm…</button>:null}
              {forceBlock?<p id="keypad-force-block" className="keypad-force-block">{forceBlock}</p>:null}
            </div>:null}
            <button className="keypad-disarm-selected" disabled={!mayDisarm||!selected.length} onClick={()=>void command('disarm')}>Disarm selected</button>
            <button className="keypad-disarm-all" disabled={!mayDisarm} onClick={()=>setDialog('disarm-all')}>{kiosk?'Disarm all permitted':'Disarm all assigned'}</button>
          </div>
        </div>
        <p className="keypad-footnote">{kiosk?'Local kiosk: arm selected ready areas without a PIN. Disarming requires an authorised PIN.':<>Arm away does not need a PIN.{!state.canArm?' Your session needs security control access to arm areas.':''}</>}</p>
      </section>
    </div>}
    {dialog==='bypass-arm'&&armReview?<ArmBypassReview review={armReview} now={now} busy={busy} onClose={closeDialog} onConfirm={confirmBypass}/>:dialog==='zones'?<Modal title="Not ready zones" wide onClose={closeDialog}><p className="keypad-zone-help">Enabled zones that are open or have trouble, including zones bypassed manually or in Home mode. Arming follows the existing area rules.</p><div className="table-scroll keypad-zone-table"><table><thead><tr><th>Zone</th><th>Area</th><th>Reason</th></tr></thead><tbody>{zones.map(item=><tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.areaNames.join(', ')}</td><td>{item.reason}{item.contextNames.length?<span className="row-subtitle">{item.contextNames.join('; ')}</span>:null}</td></tr>)}</tbody></table></div><div className="form-actions"><button onClick={closeDialog}>Close</button></div></Modal>:dialog==='disarm-all'?<Modal title={kiosk?'Disarm all permitted kiosk areas':'Disarm all assigned areas'} onClose={closeDialog}><p>{kiosk?'Disarm every area permitted by both this kiosk and the entered PIN, including permitted areas not selected on this screen.':'Disarm every area assigned to the entered PIN, including areas not selected on this screen. The PIN owner must have security control access.'}</p><div className="form-actions"><button disabled={busy} onClick={closeDialog}>Cancel</button><button className="primary" disabled={!mayDisarm} onClick={()=>void command('disarm',true)}>{kiosk?'Disarm all permitted':'Disarm all assigned'}</button></div></Modal>:null}
  </div>;
}
