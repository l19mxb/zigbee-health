import React,{useState} from 'react';
import {Field,Modal} from './ui.jsx';

const week=[['Sun',0],['Mon',1],['Tue',2],['Wed',3],['Thu',4],['Fri',5],['Sat',6]];
const modeNames={disarmed:'Disarm',home:'Arm Home',away:'Arm Away'};
const payloadExample=JSON.stringify({event:'security_alarm',area:'{{area}}',zone:'{{zone}}',device:'{{device}}',mode:'{{mode}}',timestamp:'{{timestamp}}',incidentId:'{{incidentId}}'},null,2);
const presets={contact:{property:'contact',operator:'eq',value:false},motion:{property:'occupancy',operator:'eq',value:true},vibration:{property:'vibration',operator:'eq',value:true}};
function zonePreset(item){return Object.entries(presets).find(([,value])=>value.property===item?.property&&value.operator===item?.operator&&value.value===item?.value)?.[0]||'custom';}
const availableDevices=state=>state.eligibleDevices||state.candidates||state.devices||[];
const initial=(kind,item,state,areaId)=>{
  if(kind==='area')return {name:'',entryDelaySec:30,exitDelaySec:45,enabled:true,...item};
  if(kind==='zone')return {name:'',areaId:areaId||state.areas[0]?.id||'',deviceId:'',property:'contact',operator:'eq',value:false,type:'instant',homeBypass:false,enabled:true,freshnessMin:1500,...item};
  if(kind==='schedule')return {name:'',areaId:areaId||state.areas[0]?.id||'',days:[1,2,3,4,5],time:'22:00',timezone:state.timezone||'UTC',mode:'away',enabled:false,...item};
  return {name:'',areaId:areaId||state.areas[0]?.id||'',kind:'mqtt',networkId:state.networks[0]?.id||'',topic:'security/alerts',payloadTemplate:payloadExample,subject:'Security alarm: {{area}}',text:'Security alarm in {{area}}.\nZone: {{zone}}\nDevice: {{device}}\nMode: {{mode}}\nTime: {{timestamp}}',enabled:false,...item};
};
const fieldsFor={area:['id','name','entryDelaySec','exitDelaySec','enabled'],zone:['id','name','areaId','deviceId','property','operator','value','type','homeBypass','enabled','freshnessMin'],schedule:['id','name','areaId','days','time','timezone','mode','enabled'],action:['id','name','areaId','kind','networkId','topic','payloadTemplate','subject','text','enabled']};
function AreaSelect({draft,change,state}){return <Field label="Area"><select required value={draft.areaId} onChange={e=>change('areaId',e.target.value)}><option value="" disabled>Choose an area</option>{state.areas.map(area=><option value={area.id} key={area.id} disabled={area.mode!=='disarmed'||['exit_delay','entry_delay'].includes(area.status)}>{area.name}{area.mode!=='disarmed'?' · armed':''}</option>)}</select></Field>;}
function Check({children,checked,onChange,disabled=false}){return <label className="checkbox-field"><input type="checkbox" checked={checked} disabled={disabled} onChange={e=>onChange(e.target.checked)}/>{children}</label>;}

export function SecurityForm({kind,item,state,areaId,onClose,onSave}){
  const [draft,setDraft]=useState(()=>initial(kind,item,state,areaId));
  const [preset,setPreset]=useState(()=>kind==='zone'?(item?zonePreset(item):'contact'):'custom');
  const [valueType,setValueType]=useState(()=>typeof(item?.value??false));
  const [customValue,setCustomValue]=useState(()=>String(item?.value??false));
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const change=(key,value)=>setDraft(current=>({...current,[key]:value}));
  const label=kind==='area'?'area':kind==='zone'?'zone':kind==='schedule'?'schedule':'alert action';
  const devices=availableDevices(state),chosenDevice=devices.find(device=>device.id===draft.deviceId);
  const properties=(chosenDevice?.properties||[]).map(value=>typeof value==='string'?value:value.property).filter(Boolean);
  async function submit(event){
    event.preventDefault();setError('');
    const body=Object.fromEntries(fieldsFor[kind].filter(key=>draft[key]!==undefined).map(key=>[key,draft[key]]));
    if(kind==='zone'){
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
    </>:<AreaSelect draft={draft} change={change} state={state}/>}
    {kind==='zone'?<>
      <Field label="Zigbee device"><select required value={draft.deviceId} onChange={e=>{const device=devices.find(value=>value.id===e.target.value);change('deviceId',e.target.value);if(!draft.name&&device)change('name',device.name);}}><option value="" disabled>Choose a device</option>{devices.map(device=><option value={device.id} key={device.id} disabled={!!device.retiredAt||device.disabled}>{device.name} · {device.networkLabel||'Zigbee network'}{device.retiredAt?' · retired':''}</option>)}</select></Field>
      <Field label="Activation"><select value={preset} onChange={e=>{const next=e.target.value,condition=presets[next]||presets[preset];if(condition){setDraft(current=>({...current,...condition}));setValueType(typeof condition.value);setCustomValue(String(condition.value));}setPreset(next);}}><option value="contact">Door / window opens</option><option value="motion">Motion / presence detected</option><option value="vibration">Vibration detected</option><option value="custom">Custom condition</option></select></Field>
      {preset!=='custom'?<p className="security-condition-preview">{preset==='contact'?'Open (contact = false)':preset==='motion'?'Motion detected (occupancy = true)':'Vibration detected (vibration = true)'}</p>:<>
        <Field label="Activation property" hint="Choose a reported property or enter its exact name."><input required list="security-zone-properties" maxLength={80} value={draft.property} onChange={e=>change('property',e.target.value)}/></Field><datalist id="security-zone-properties">{properties.map(property=><option key={property} value={property}/>)}</datalist>
        <div className="security-field-pair"><Field label="Condition"><select value={draft.operator} onChange={e=>{change('operator',e.target.value);if(!['eq','ne'].includes(e.target.value)&&valueType!=='number'){setValueType('number');setCustomValue('');}}}><option value="eq">Equals</option><option value="ne">Does not equal</option><option value="gt">Greater than</option><option value="gte">At least</option><option value="lt">Less than</option><option value="lte">At most</option></select></Field><Field label="Value type"><select value={valueType} onChange={e=>{setValueType(e.target.value);setCustomValue(e.target.value==='boolean'?'true':'');if(e.target.value!=='number'&&!['eq','ne'].includes(draft.operator))change('operator','eq');}}><option value="boolean">On / off</option><option value="number">Number</option><option value="string">Text</option></select></Field></div>
        <Field label="Activation value">{valueType==='boolean'?<select value={customValue} onChange={e=>setCustomValue(e.target.value)}><option value="true">True</option><option value="false">False</option></select>:<input required type={valueType==='number'?'number':'text'} step={valueType==='number'?'any':undefined} maxLength={200} value={customValue} onChange={e=>setCustomValue(e.target.value)}/>}</Field>
      </>}
      <Field label="Zone type"><select value={draft.type} onChange={e=>change('type',e.target.value)}><option value="instant">Instant</option><option value="entry">Entry</option></select></Field>
      <Check checked={draft.homeBypass} onChange={value=>change('homeBypass',value)}>Bypass in Home mode</Check>
      <Check checked={draft.enabled} onChange={value=>change('enabled',value)}>Zone enabled</Check>
      <details className="security-advanced"><summary>Advanced zone settings</summary><Field label="Reading timeout" type="number" min={1} max={43200} unit="minutes" required value={draft.freshnessMin} onChange={e=>change('freshnessMin',Number(e.target.value))} hint="An older reading makes the zone unknown and blocks arming. Choose a period appropriate for this sensor's reporting interval."/></details>
      <p className="security-form-footnote">Only a fresh device activation can raise an alarm. The zone waits for a fresh reading before it is ready to arm.</p>
    </>:null}
    {kind==='schedule'?<>
      <div className="security-field-pair"><Field label="Time"><input type="time" required value={draft.time} onInput={e=>change('time',e.currentTarget.value)} onChange={e=>change('time',e.target.value)}/></Field><Field label="Set area to"><select value={draft.mode} onChange={e=>change('mode',e.target.value)}>{Object.entries(modeNames).map(([value,name])=><option key={value} value={value}>{name}</option>)}</select></Field></div>
      <fieldset className="security-days"><legend>Repeat on</legend>{week.map(([name,day])=><Check key={day} checked={draft.days.includes(day)} onChange={checked=>change('days',checked?[...draft.days,day].sort():draft.days.filter(value=>value!==day))}>{name}</Check>)}</fieldset>
      <Field label="Timezone" required maxLength={100} value={draft.timezone} onChange={e=>change('timezone',e.target.value)} hint="An IANA timezone, for example Europe/London. Daylight saving follows that timezone."/>
      <Check checked={draft.enabled} onChange={value=>change('enabled',value)}>Schedule enabled</Check>
      <p className="security-form-footnote">A schedule runs at its next matching time. Missed times are not replayed. Arming still requires the area's zones to be ready.</p>
    </>:null}
    {kind==='action'?<>
      <Field label="Send alert by"><select value={draft.kind} onChange={e=>change('kind',e.target.value)}><option value="mqtt">MQTT event</option><option value="email">Email</option></select></Field>
      {draft.kind==='mqtt'?<>
        <Field label="MQTT broker"><select required value={draft.networkId} onChange={e=>change('networkId',e.target.value)}><option value="" disabled>Choose a configured broker</option>{state.networks.map(network=><option value={network.id} key={network.id}>{network.label}{!network.enabled?' · disabled':''}</option>)}</select></Field>
        <Field label="Event topic" required maxLength={255} value={draft.topic} onChange={e=>change('topic',e.target.value)} hint="Publish security events here. Device command topics and MQTT wildcards are not accepted."/>
        <Field label="JSON payload"><textarea className="security-json" required rows={7} maxLength={8000} spellCheck={false} value={draft.payloadTemplate} onChange={e=>change('payloadTemplate',e.target.value)}/></Field>
      </>:<>
        <p className="notice">Uses the existing SMTP server, sender and recipient configured under Email settings.</p>
        <Field label="Email subject" required maxLength={200} value={draft.subject} onChange={e=>change('subject',e.target.value)}/>
        <Field label="Email message"><textarea required rows={5} maxLength={8000} value={draft.text} onChange={e=>change('text',e.target.value)}/></Field>
      </>}
      <p className="small muted security-template-help">Available values: {'{{area}}'}, {'{{zone}}'}, {'{{device}}'}, {'{{mode}}'}, {'{{timestamp}}'}, {'{{incidentId}}'}.</p>
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
  return <Modal title={(clear?'Clear bypass':'Bypass zone')+' · '+zone.name} onClose={()=>{if(!busy)onClose();}}><form className="security-form" onSubmit={async event=>{event.preventDefault();setBusy(true);setError('');try{await onSave('security/'+(clear?'clear-bypass':'bypass'),{id:zone.id,...(!clear?{reason,durationMin:duration==='indefinite'?null:Number(duration)}:{})});}catch(error){setError(error.message);}finally{setBusy(false);}}}>
    <p>{clear?'Return this zone to normal security monitoring. A fresh reading may be needed before it is ready.':'Activations from this zone will not raise new security alarms while it is bypassed.'}</p>
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
    {kind==='area'?<p className="notice warning">This also removes the area's zones, schedules and alert actions.</p>:null}
    <Check checked={confirmed} onChange={setConfirmed}>I understand and want to remove this {label}.</Check>
    {error?<div className="notice critical" role="alert">{error}</div>:null}
    <div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="danger" disabled={busy||!confirmed}>{busy?'Removing…':'Remove '+label}</button></div>
  </form></Modal>;
}
