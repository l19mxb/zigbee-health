import React,{useRef,useState} from 'react';
import {Field,Modal} from './ui.jsx';

const week=[['Sun',0],['Mon',1],['Tue',2],['Wed',3],['Thu',4],['Fri',5],['Sat',6]];
const modeNames={disarmed:'Disarm',home:'Arm Home',away:'Arm Away'};
const payloadExample=JSON.stringify({event:'security_alarm',area:'{{area}}',zone:'{{zone}}',device:'{{device}}',mode:'{{mode}}',timestamp:'{{timestamp}}',incidentId:'{{incidentId}}'},null,2);
const presets={contact:{property:'contact',operator:'eq',value:false},motion:{property:'occupancy',operator:'eq',value:true},vibration:{property:'vibration',operator:'eq',value:true}};
function zonePreset(item){return Object.entries(presets).find(([,value])=>value.property===item?.property&&value.operator===item?.operator&&value.value===item?.value)?.[0]||'custom';}
const availableDevices=state=>state.eligibleDevices||state.candidates||state.devices||[];
const memberIds=zone=>Array.isArray(zone?.areaIds)&&zone.areaIds.length?zone.areaIds:zone?.areaId?[zone.areaId]:[];
const editableArea=area=>area?.mode==='disarmed'&&!['exit_delay','entry_delay'].includes(area.status);
const initial=(kind,item,state,areaId)=>{
  if(kind==='area')return {name:'',entryDelaySec:30,exitDelaySec:45,enabled:true,...item};
  if(kind==='zone')return {name:'',deviceId:'',property:'contact',operator:'eq',value:false,type:'instant',homeBypass:false,enabled:true,...item,areaIds:item?memberIds(item):[areaId||state.areas.find(editableArea)?.id].filter(Boolean)};
  if(kind==='schedule')return {name:'',areaId:areaId||state.areas[0]?.id||'',days:[1,2,3,4,5],time:'22:00',timezone:state.timezone||'UTC',mode:'away',enabled:false,...item};
  return {name:'',areaId:areaId||state.areas[0]?.id||'',kind:'mqtt',networkId:state.networks[0]?.id||'',topic:'security/alerts',payloadTemplate:payloadExample,subject:'Security alarm: {{area}}',text:'Security alarm in {{area}}.\nZone: {{zone}}\nDevice: {{device}}\nMode: {{mode}}\nTime: {{timestamp}}',subscriptionIds:[],enabled:false,...item};
};
const fieldsFor={area:['id','name','entryDelaySec','exitDelaySec','enabled'],zone:['id','name','areaIds','deviceId','property','operator','value','type','homeBypass','enabled'],schedule:['id','name','areaId','days','time','timezone','mode','enabled'],action:['id','name','areaId','kind','networkId','topic','payloadTemplate','subject','text','subscriptionIds','enabled']};
function AreaSelect({draft,change,state}){return <Field label="Area"><select required value={draft.areaId} onChange={e=>change('areaId',e.target.value)}><option value="" disabled>Choose an area</option>{state.areas.map(area=><option value={area.id} key={area.id} disabled={area.mode!=='disarmed'||['exit_delay','entry_delay'].includes(area.status)}>{area.name}{area.mode!=='disarmed'?' · armed':''}</option>)}</select></Field>;}
function Check({children,checked,onChange,disabled=false}){return <label className="checkbox-field"><input type="checkbox" checked={checked} disabled={disabled} onChange={e=>onChange(e.target.checked)}/>{children}</label>;}

function PushRecipients({draft,change,state,onAccount}){
  const recipients=state.securityPushRecipients||[],selected=draft.subscriptionIds||[];
  const unavailable=selected.filter(id=>!recipients.some(recipient=>recipient.id===id));
  const toggle=(id,checked)=>change('subscriptionIds',checked?[...selected,id]:selected.filter(value=>value!==id));
  return <fieldset className="security-push-recipients"><legend>Registered browsers</legend>
    <p>Select the phones or browsers that should receive alarms from this area. Only enabled registrations with security view access appear here.</p>
    {recipients.length?<div className="security-push-recipient-list">{recipients.map(recipient=><Check key={recipient.id} checked={selected.includes(recipient.id)} onChange={checked=>toggle(recipient.id,checked)}>{recipient.label}</Check>)}</div>:<p className="notice">No eligible browsers are registered yet. On each phone, open My account &amp; app and enable notifications, then return here to select it.</p>}
    {unavailable.map((id,index)=><Check key={id} checked onChange={()=>toggle(id,false)}>Unavailable browser {index+1}<span className="small muted"> · remove this selection before saving</span></Check>)}
    {onAccount?<button type="button" onClick={onAccount}>Open My account &amp; app</button>:null}
    <p className="small muted">Choose up to 32 browsers. Enabling notifications on a phone does not automatically add it to security alert actions.</p>
    {state.securityPushSettings?.enabled===false?<p className="notice warning">Global browser push delivery is disabled. An administrator must enable it under App &amp; notifications before these alerts can be sent.</p>:null}
    <p className="security-push-privacy">{state.securityPushSettings?.includeDeviceNames===true?'Lock-screen notifications include area, zone and device details. An administrator can turn this off in the global privacy setting.':state.securityPushSettings?.includeDeviceNames===false?'Lock-screen notifications use a generic security alarm message. Area, zone and device details stay inside the app.':'Lock-screen text follows the global notification privacy setting. Names appear only when that setting allows them.'}</p>
  </fieldset>;
}

function AreaMemberships({draft,change,state,locked}){
  return <fieldset className="security-membership-fieldset" aria-describedby="security-membership-help"><legend>Areas</legend><p id="security-membership-help">Select one or more areas this zone protects.</p><div className="security-membership-options">{state.areas.map(area=><label className="checkbox-field" key={area.id}><input type="checkbox" aria-label={'Include area '+area.name} checked={draft.areaIds.includes(area.id)} disabled={locked||!editableArea(area)} onChange={event=>change('areaIds',event.target.checked?[...draft.areaIds,area.id]:draft.areaIds.filter(id=>id!==area.id))}/><span>{area.name}<small>{editableArea(area)?'Disarmed':area.mode==='disarmed'?'Arming':'Armed · disarm to change'}</small></span></label>)}</div><p className="small muted">{locked?'Reset this zone’s alarm memory before changing its area membership.':'Every linked area must be disarmed before this zone can be changed.'}</p>{draft.areaIds.length>1?<p className="security-shared-warning">Shared zone: activation, zone type, Home-mode bypass and manual bypass apply to every linked area. Each area arms and raises alarms independently.</p>:null}</fieldset>;
}

function DevicePicker({devices,selectedId,fallback,onChange}){
  const [search,setSearch]=useState('');
  const select=useRef(null);
  const selected=devices.find(device=>device.id===selectedId)||(selectedId?{id:selectedId,name:fallback?.deviceName||'Unavailable device',networkLabel:fallback?.networkLabel||'',disabled:true}:null);
  const terms=search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered=devices.filter(device=>{
    const text=[device.name,device.networkLabel,device.ieee,device.model,device.room].filter(Boolean).join(' ').toLowerCase();
    const ieee=String(device.ieee||'').toLowerCase().replace(/[\s:.-]/g,'');
    return terms.every(term=>text.includes(term)||/^(?:0x)?[0-9a-f]{3,}$/.test(term.replace(/[\s:.-]/g,''))&&ieee.includes(term.replace(/[\s:.-]/g,'')));
  }).toSorted((a,b)=>String(a.name).localeCompare(String(b.name))||String(a.networkLabel).localeCompare(String(b.networkLabel))||a.id.localeCompare(b.id));
  const retained=selected&&!filtered.some(device=>device.id===selected.id);
  const option=device=><option key={device.id} value={device.id} disabled={!!device.retiredAt||device.disabled}>{device.name} · {device.networkLabel||'Zigbee network'}{device.retiredAt?' · retired':device.disabled?' · unavailable':''}</option>;
  return <div className="security-device-picker"><Field label="Search Zigbee devices" hint="Search by friendly name, network, model or IEEE address."><input type="search" autoComplete="off" maxLength={160} value={search} onChange={event=>setSearch(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();select.current?.focus();}}}/></Field>
    <Field label="Zigbee device"><select ref={select} required size={Math.min(5,Math.max(2,filtered.length+(retained?1:0)+1))} value={selectedId} onChange={event=>onChange(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')event.preventDefault();}}><option value="" disabled>Choose a device</option>{retained?<optgroup label="Selected device (kept)">{option(selected)}</optgroup>:null}{filtered.length?<optgroup label={terms.length?'Matching devices':'Available devices'}>{filtered.map(option)}</optgroup>:null}</select></Field>
    <p className={'security-device-results '+(!filtered.length?'no-results':'')} role="status" aria-live="polite">{filtered.length?filtered.length+' matching '+(filtered.length===1?'device':'devices'):'No devices match this search.'}{retained?' Your selected device is unchanged.':''}</p>
    {selected?<p className="security-device-selection"><strong>Selected:</strong> {selected.name}{selected.networkLabel?' · '+selected.networkLabel:''}{selected.ieee?<code>{selected.ieee}</code>:null}{selected.disabled||selected.retiredAt?<span className="security-device-unavailable">Choose a current device before saving.</span>:null}</p>:null}
  </div>;
}

export function SecurityForm({kind,item,state,areaId,onClose,onSave,onAccount}){
  const [draft,setDraft]=useState(()=>initial(kind,item,state,areaId));
  const [preset,setPreset]=useState(()=>kind==='zone'?(item?zonePreset(item):'contact'):'custom');
  const [valueType,setValueType]=useState(()=>typeof(item?.value??false));
  const [customValue,setCustomValue]=useState(()=>String(item?.value??false));
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const change=(key,value)=>setDraft(current=>({...current,[key]:value}));
  const label=kind==='area'?'area':kind==='zone'?'zone':kind==='schedule'?'schedule':'alert action';
  const devices=availableDevices(state),chosenDevice=devices.find(device=>device.id===draft.deviceId);
  const properties=(chosenDevice?.properties||[]).map(value=>typeof value==='string'?value:value.property).filter(Boolean);
  const membershipLocked=kind==='zone'&&!!item&&(state.incidents||[]).some(incident=>incident.zoneId===item.id&&incident.resetAt==null);
  async function submit(event){
    event.preventDefault();setError('');
    const body=Object.fromEntries(fieldsFor[kind].filter(key=>draft[key]!==undefined).map(key=>[key,draft[key]]));
    if(kind==='zone'){
      if(!body.areaIds.length){setError('Select at least one area for this zone.');return;}
      const linkedIds=new Set([...memberIds(item),...body.areaIds]);
      if([...linkedIds].some(id=>!editableArea(state.areas.find(area=>area.id===id)))){setError('Disarm every linked area before changing this zone.');return;}
      if(preset!=='custom')Object.assign(body,presets[preset]);
      else{
        body.value=valueType==='boolean'?customValue==='true':valueType==='number'?Number(customValue):customValue;
        if(valueType==='number'&&(!customValue.trim()||!Number.isFinite(body.value))){setError('Enter a finite activation number.');return;}
      }
    }
    if(kind==='action'&&body.kind==='mqtt'){
      if(!body.topic.trim()||/[+#\u0000-\u0020\u007f]/.test(body.topic)||body.topic.length>255||body.topic.startsWith('$')||body.topic.startsWith('/')||body.topic.endsWith('/')||/(^|\/)(set|get)(\/|$)|(^|\/)bridge\/request(\/|$)/i.test(body.topic)){setError('Choose a security event topic without whitespace, wildcards or device command paths.');return;}
      try{const payload=JSON.parse(body.payloadTemplate);if(!payload||Array.isArray(payload)||typeof payload!=='object')throw Error();}catch{setError('The MQTT payload must be a valid JSON object.');return;}
    }
    if(kind==='action'&&body.kind==='push'){
      if(!body.subscriptionIds?.length){setError('Select at least one registered browser.');return;}
      if(body.subscriptionIds.length>32){setError('Choose no more than 32 registered browsers.');return;}
      if(body.subscriptionIds.some(id=>!(state.securityPushRecipients||[]).some(recipient=>recipient.id===id))){setError('Remove unavailable browsers and select a current registration before saving.');return;}
    }
    setBusy(true);
    try{await onSave('security/'+({area:'areas',zone:'zones',schedule:'schedules',action:'actions'}[kind]),body);}
    catch(error){setError(error.message);}
    finally{setBusy(false);}
  }
  const close=()=>{if(!busy)onClose();};
  return <Modal title={(item?'Edit ':'Add ')+label} onClose={close} wide><form className="security-form" onSubmit={submit}>
    <Field label={kind==='zone'?'Zone name':kind==='area'?'Area name':kind==='schedule'?'Schedule name':'Action name'} required autoFocus maxLength={80} value={draft.name} onChange={e=>change('name',e.target.value)}/>
    {kind==='area'?<>
      <div className="security-field-pair"><Field label="Entry delay" type="number" min={0} max={600} required unit="seconds" value={draft.entryDelaySec} onChange={e=>change('entryDelaySec',Number(e.target.value))}/><Field label="Exit delay" type="number" min={0} max={600} required unit="seconds" value={draft.exitDelaySec} onChange={e=>change('exitDelaySec',Number(e.target.value))}/></div>
      <p className="small muted">Entry zones use the entry delay. Instant zones raise an alarm immediately after the area is armed.</p>
      <Check checked={draft.enabled} onChange={value=>change('enabled',value)}>Area enabled</Check>
    </>:kind==='zone'?<AreaMemberships draft={draft} change={change} state={state} locked={membershipLocked}/>:<AreaSelect draft={draft} change={change} state={state}/>}
    {kind==='zone'?<>
      <DevicePicker devices={devices} selectedId={draft.deviceId} fallback={item} onChange={id=>{const device=devices.find(value=>value.id===id);change('deviceId',id);if(!draft.name&&device)change('name',device.name);}}/>
      <Field label="Activation"><select value={preset} onChange={e=>{const next=e.target.value,condition=presets[next]||presets[preset];if(condition){setDraft(current=>({...current,...condition}));setValueType(typeof condition.value);setCustomValue(String(condition.value));}setPreset(next);}}><option value="contact">Door / window opens</option><option value="motion">Motion / presence detected</option><option value="vibration">Vibration detected</option><option value="custom">Custom condition</option></select></Field>
      {preset!=='custom'?<p className="security-condition-preview">{preset==='contact'?'Open (contact = false)':preset==='motion'?'Motion detected (occupancy = true)':'Vibration detected (vibration = true)'}</p>:<>
        <Field label="Activation property" hint="Choose a reported property or enter its exact name."><input required list="security-zone-properties" maxLength={80} value={draft.property} onChange={e=>change('property',e.target.value)}/></Field><datalist id="security-zone-properties">{properties.map(property=><option key={property} value={property}/>)}</datalist>
        <div className="security-field-pair"><Field label="Condition"><select value={draft.operator} onChange={e=>{change('operator',e.target.value);if(!['eq','ne'].includes(e.target.value)&&valueType!=='number'){setValueType('number');setCustomValue('');}}}><option value="eq">Equals</option><option value="ne">Does not equal</option><option value="gt">Greater than</option><option value="gte">At least</option><option value="lt">Less than</option><option value="lte">At most</option></select></Field><Field label="Value type"><select value={valueType} onChange={e=>{setValueType(e.target.value);setCustomValue(e.target.value==='boolean'?'true':'');if(e.target.value!=='number'&&!['eq','ne'].includes(draft.operator))change('operator','eq');}}><option value="boolean">On / off</option><option value="number">Number</option><option value="string">Text</option></select></Field></div>
        <Field label="Activation value">{valueType==='boolean'?<select value={customValue} onChange={e=>setCustomValue(e.target.value)}><option value="true">True</option><option value="false">False</option></select>:<input required type={valueType==='number'?'number':'text'} step={valueType==='number'?'any':undefined} maxLength={200} value={customValue} onChange={e=>setCustomValue(e.target.value)}/>}</Field>
      </>}
      <Field label="Zone type"><select value={draft.type} onChange={e=>change('type',e.target.value)}><option value="instant">Instant</option><option value="entry">Entry</option></select></Field>
      <Check checked={draft.homeBypass} onChange={value=>change('homeBypass',value)}>Bypass in Home mode</Check>
      <Check checked={draft.enabled} onChange={value=>change('enabled',value)}>Zone enabled</Check>
      <p className="security-form-footnote">This zone uses the shared reading timeout under Security → Settings. It waits for a fresh reading before it is ready to arm.</p>
    </>:null}
    {kind==='schedule'?<>
      <div className="security-field-pair"><Field label="Time"><input type="time" required value={draft.time} onInput={e=>change('time',e.currentTarget.value)} onChange={e=>change('time',e.target.value)}/></Field><Field label="Set area to"><select value={draft.mode} onChange={e=>change('mode',e.target.value)}>{Object.entries(modeNames).map(([value,name])=><option key={value} value={value}>{name}</option>)}</select></Field></div>
      <fieldset className="security-days"><legend>Repeat on</legend>{week.map(([name,day])=><Check key={day} checked={draft.days.includes(day)} onChange={checked=>change('days',checked?[...draft.days,day].sort():draft.days.filter(value=>value!==day))}>{name}</Check>)}</fieldset>
      <Field label="Timezone" required maxLength={100} value={draft.timezone} onChange={e=>change('timezone',e.target.value)} hint="An IANA timezone, for example Europe/London. Daylight saving follows that timezone."/>
      <Check checked={draft.enabled} onChange={value=>change('enabled',value)}>Schedule enabled</Check>
      <p className="security-form-footnote">A schedule runs at its next matching time. Missed times are not replayed. Arming still requires the area's zones to be ready.</p>
    </>:null}
    {kind==='action'?<>
      <Field label="Send alert by"><select value={draft.kind} onChange={e=>change('kind',e.target.value)}><option value="mqtt">MQTT event</option><option value="email">Email</option><option value="push">Browser push</option></select></Field>
      {draft.kind==='mqtt'?<>
        <Field label="MQTT broker"><select required value={draft.networkId} onChange={e=>change('networkId',e.target.value)}><option value="" disabled>Choose a configured broker</option>{state.networks.map(network=><option value={network.id} key={network.id}>{network.label}{!network.enabled?' · disabled':''}</option>)}</select></Field>
        <Field label="Event topic" required maxLength={255} value={draft.topic} onChange={e=>change('topic',e.target.value)} hint="Publish security events here. Device command topics and MQTT wildcards are not accepted."/>
        <Field label="JSON payload"><textarea className="security-json" required rows={7} maxLength={8000} spellCheck={false} value={draft.payloadTemplate} onChange={e=>change('payloadTemplate',e.target.value)}/></Field>
      </>:draft.kind==='email'?<>
        <p className="notice">Uses the existing SMTP server, sender and recipient configured under Email settings.</p>
        <Field label="Email subject" required maxLength={200} value={draft.subject} onChange={e=>change('subject',e.target.value)}/>
        <Field label="Email message"><textarea required rows={5} maxLength={8000} value={draft.text} onChange={e=>change('text',e.target.value)}/></Field>
      </>:<PushRecipients draft={draft} change={change} state={state} onAccount={onAccount}/>}
      {draft.kind!=='push'?<p className="small muted security-template-help">Available values: {'{{area}}'}, {'{{zone}}'}, {'{{device}}'}, {'{{mode}}'}, {'{{timestamp}}'}, {'{{incidentId}}'}.</p>:null}
      <Check checked={draft.enabled} onChange={value=>change('enabled',value)}>Alert action enabled</Check>
      <p className="security-form-footnote">Sends when a zone activates in this armed area. New actions start disabled. Delivery failures are recorded without an automatic resend.</p>
    </>:null}
    {error?<div className="notice critical" role="alert">{error}</div>:null}
    <div className="form-actions"><button type="button" disabled={busy} onClick={close}>Cancel</button><button className="primary" disabled={busy}>{busy?'Saving…':'Save '+label}</button></div>
  </form></Modal>;
}

export function SecurityCommandDialog({area,action,zones,onClose,onSave}){
  const [reason,setReason]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const arming=action==='arm_home'||action==='arm_away',home=action==='arm_home';
  const included=zones.filter(zone=>zone.enabled&&!zone.bypassed&&!(home&&zone.homeBypass));
  const blocking=included.filter(zone=>zone.trouble||!zone.known||zone.active||['unknown','trouble','active'].includes(zone.status));
  const title={arm_home:'Arm Home',arm_away:'Arm Away',disarm:'Disarm',acknowledge:'Acknowledge alarms',reset:'Reset alarm memory'}[action];
  const cannotArm=arming&&(!area.enabled||!included.length||blocking.length>0||area.activeAlarmCount>0);
  return <Modal title={title+' · '+area.name} onClose={()=>{if(!busy)onClose();}}><form className="security-form" onSubmit={async event=>{event.preventDefault();setError('');setBusy(true);try{await onSave('security/command',{areaId:area.id,action,reason});}catch(error){setError(error.message);}finally{setBusy(false);}}}>
    {arming?<>
      <p>{home?'Only zones included in Home mode will be armed.':'All enabled, unbypassed zones will be armed.'}{area.exitDelaySec?' The exit delay is '+area.exitDelaySec+' seconds.':''}</p>
      {cannotArm?<div className="notice warning"><strong>This area is not ready to arm.</strong>{!area.enabled?<p>The area is disabled.</p>:null}{!included.length?<p>Add an enabled zone first.</p>:null}{area.activeAlarmCount>0?<p>Acknowledge and reset existing alarm memory while disarmed.</p>:null}{blocking.length?<ul>{blocking.map(zone=><li key={zone.id}>{zone.name}: {zone.trouble||(!zone.known?'waiting for a fresh reading':zone.active?'active / open':zone.status)}</li>)}</ul>:null}</div>:<div className="notice"><strong>Ready to arm.</strong> {included.length} zones included{home&&zones.some(zone=>zone.homeBypass)?'; Home bypasses applied':''}.</div>}
    </>:<p>{action==='disarm'?'Stop monitoring new security activations in this area. Alarm memory remains until it is acknowledged and reset.':action==='acknowledge'?'Record that you have seen this area’s security alarms. Acknowledgement does not disarm the area.':'Clear acknowledged alarm memory. The area must be disarmed, with its zones restored or explicitly bypassed.'}</p>}
    <Field label="Reason / note" maxLength={300} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Optional"/>
    {error?<div className="notice critical" role="alert">{error}</div>:null}
    <div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy||cannotArm}>{busy?'Applying…':title}</button></div>
  </form></Modal>;
}

export function SecurityBypassDialog({zone,clear=false,onClose,onSave}){
  const [duration,setDuration]=useState('60'),[reason,setReason]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const linkedAreas=zone.areaNames||zone.areaStates?.map(area=>area.areaName).filter(Boolean)||[];
  return <Modal title={(clear?'Clear bypass':'Bypass zone')+' · '+zone.name} onClose={()=>{if(!busy)onClose();}}><form className="security-form" onSubmit={async event=>{event.preventDefault();setBusy(true);setError('');try{await onSave('security/'+(clear?'clear-bypass':'bypass'),{id:zone.id,...(!clear?{reason,durationMin:duration==='indefinite'?null:Number(duration)}:{})});}catch(error){setError(error.message);}finally{setBusy(false);}}}>
    <p>{clear?'Return this zone to normal security monitoring. A fresh reading may be needed before it is ready.':'Activations from this zone will not raise new security alarms while it is bypassed.'}</p>
    {linkedAreas.length?<div className={'notice '+(linkedAreas.length>1?'warning':'')}><strong>{clear?'Clears the bypass in':'Bypasses this zone in'} {linkedAreas.join(', ')}.</strong>{linkedAreas.length>1?' This is one shared zone; the change affects every linked area.':''}</div>:null}
    {!clear?<Field label="Bypass for"><select value={duration} onChange={e=>setDuration(e.target.value)}><option value="15">15 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option><option value="1440">24 hours</option><option value="indefinite">Until manually cleared</option></select></Field>:null}
    {!clear?<Field label="Reason" required maxLength={300} value={reason} onChange={e=>setReason(e.target.value)}/>:null}
    {error?<div className="notice critical" role="alert">{error}</div>:null}
    <div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy?'Applying…':clear?'Clear bypass':'Bypass zone'}</button></div>
  </form></Modal>;
}

export function SecurityRemoveDialog({kind,item,onClose,onSave}){
  const [confirmed,setConfirmed]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const label=kind==='action'?'alert action':kind;
  return <Modal title={'Remove '+label} onClose={()=>{if(!busy)onClose();}}><form className="security-form" onSubmit={async event=>{event.preventDefault();setBusy(true);setError('');try{await onSave('security/remove-'+kind,{id:item.id});}catch(error){setError(error.message);}finally{setBusy(false);}}}>
    <p>Remove <strong>{item.name}</strong> from security configuration? Existing alarm and activity history is retained.</p>
    {kind==='area'?<p className="notice warning">This removes the area's schedules and alert actions. Shared zones remain linked to their other areas; zones assigned only to this area are removed.</p>:kind==='zone'&&memberIds(item).length>1?<p className="notice warning">This removes the shared zone from every linked area: {(item.areaNames||item.areaStates?.map(area=>area.areaName)||[]).join(', ')}.</p>:null}
    <Check checked={confirmed} onChange={setConfirmed}>I understand and want to remove this {label}.</Check>
    {error?<div className="notice critical" role="alert">{error}</div>:null}
    <div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="danger" disabled={busy||!confirmed}>{busy?'Removing…':'Remove '+label}</button></div>
  </form></Modal>;
}
