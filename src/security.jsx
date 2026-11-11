import React,{useEffect,useRef,useState} from 'react';
import {request} from './api.jsx';
import {Badge,Field,Icon,Pagination,date} from './ui.jsx';
import {SortHead,useTable} from './tables.jsx';
import {SecurityClearBypassDialog,SecurityCommandDialog,SecurityCycleBypassDialog,SecurityForm,SecurityRemoveDialog} from './security-forms.jsx';
import './security.css';

const tabs=[['overview','Overview'],['zones','Zones'],['settings','Settings'],['schedules','Schedules'],['actions','Alert actions']];
const modeName={disarmed:'Disarmed',home:'Armed Home',away:'Armed Away'};
const deliveryName={mqtt:'MQTT event',email:'Email',push:'Browser push'};
const zoneTypeName={instant:'Instant',entry:'Entry','24hour':'24-hour'};
const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const canConfigure=area=>area?.mode==='disarmed'&&!['exit_delay','entry_delay'].includes(area.status);
const manualBypass=zone=>zone.manualBypassed===true;
const membershipIds=zone=>Array.isArray(zone.areaIds)&&zone.areaIds.length?zone.areaIds:zone.areaId?[zone.areaId]:[];
function zoneForArea(zone,areaId){
  const context=zone.areaStates?.find(state=>state.areaId===areaId);
  if(context)return {...zone,...context,areaId};
  return membershipIds(zone).length>1?{...zone,areaId,known:false,active:null,status:'unknown',ready:false,homeExcluded:false,trouble:'Area state unavailable'}:{...zone,areaId};
}
const zonesForArea=(zones,areaId)=>zones.filter(zone=>membershipIds(zone).includes(areaId)).map(zone=>zoneForArea(zone,areaId));
const zoneEditable=(zone,areas)=>membershipIds(zone).length>0&&membershipIds(zone).every(id=>canConfigure(areas.get(id)));
const areaRemovable=(area,zones,areas,incidents)=>canConfigure(area)&&!area.activeAlarmCount&&zones.filter(zone=>membershipIds(zone).includes(area.id)).every(zone=>zoneEditable(zone,areas)&&!incidents.some(incident=>incident.zoneId===zone.id&&incident.resetAt==null));
function bypassChoices(zone,areas,canOpenKeypad){
  if(!zone?.enabled||zone.type==='24hour'||manualBypass(zone))return [];
  return membershipIds(zone).flatMap(id=>{
    const area=areas.get(id),membership=zone.areaStates?.find(view=>view.areaId===id);
    if(!area?.enabled||area.targetMode||area.activeAlarmCount!==0||!(area.includedCount>1)
      ||!membership||membership.bypassed||membership.homeExcluded)return [];
    if(canOpenKeypad&&area.mode==='disarmed'&&area.status==='disarmed'){
      return [{id,name:area.name,mode:'disarmed',cycleId:null}];
    }
    if(area.status==='armed'&&['home','away'].includes(area.mode)&&area.cycleId){
      return [{id,name:area.name,mode:area.mode,cycleId:area.cycleId}];
    }
    return [];
  });
}
const plural=(number,noun)=>number+' '+noun+(number===1?'':noun==='bypass'?'es':'s');
const validReadingTimeout=minutes=>Number.isInteger(minutes)&&minutes>=1&&minutes<=43200;
function timeoutDuration(minutes){
  return [[Math.floor(minutes/1440),'day'],[Math.floor(minutes%1440/60),'hour'],[minutes%60,'minute']]
    .filter(([count])=>count>0).map(([count,unit])=>plural(count,unit)).join(' ');
}
function areaStatus(area){
  if(area.status==='alarm')return area.mode==='disarmed'&&area.active24HourAlarmCount>0?'24-hour alarm':'Alarm';
  return area.status==='exit_delay'?'Exit delay':area.status==='entry_delay'?'Entry delay':modeName[area.mode]||'Disarmed';
}
function zoneLabel(zone){if(manualBypass(zone))return 'Manual bypass';if(zone.cycleBypassed)return 'Cycle bypass';if(zone.homeExcluded)return 'Home bypass';if(zone.bypassed||zone.status==='bypassed')return 'Bypassed';if(!zone.enabled)return 'Disabled';if(zone.trouble||zone.status==='trouble')return 'Trouble';if(!zone.known||zone.status==='unknown')return 'Waiting for reading';if(zone.active)return zone.property==='contact'?'Open':'Active';return zone.property==='contact'?'Closed':['occupancy','vibration'].includes(zone.property)?'Clear':'Normal';}
function zoneTone(zone){return zone.bypassed||zone.status==='bypassed'||!zone.enabled?'neutral':zone.trouble||!zone.known?'warning':zone.active?'critical':'healthy';}
function Shield({alert=false}){return <svg className="security-shield" viewBox="0 0 80 92" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M40 5 69 18v24c0 22-18 36-29 43C29 78 11 64 11 42V18L40 5Z"/>{alert?<path d="M40 28v23m0 10v2"/>:null}</svg>;}
function PanelHeading({title,count,children}){return <header className="security-panel-heading"><h2>{title}{count!==undefined?<span className="count">{count}</span>:null}</h2>{children}</header>;}
function SearchBox({label,table}){return <label className="search compact"><Icon name="search"/><input aria-label={label} placeholder={label+'…'} value={table.search} onChange={event=>table.setSearch(event.target.value)}/></label>;}
function EmptyPanel({title,children,action}){return <div className="security-empty"><Icon name="shield" size={34}/><h3>{title}</h3><p>{children}</p>{action}</div>;}

export default function Security({permissions={},demo=false,onAccount,onKeypadBypass,openIncidentId,openRequestKey=0}){
  const [state,setState]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[tab,setTab]=useState('overview'),[areaId,setAreaId]=useState(''),[dialog,setDialog]=useState(null),[clock,setClock]=useState(Date.now());
  const [acknowledgeError,setAcknowledgeError]=useState('');
  const active=useRef(null),received=useRef(Date.now()),openedIncident=useRef(null),openRefresh=useRef(null);
  async function refresh(){
    active.current?.abort();const controller=new AbortController();active.current=controller;
    try{const value=await request('security',undefined,controller.signal);received.current=Date.now();setState(value);setError('');}
    catch(error){if(error.name!=='AbortError')setError(error.message);}
    finally{if(!controller.signal.aborted)setLoading(false);}
  }
  useEffect(()=>{void refresh();const interval=setInterval(()=>void refresh(),5000);const seconds=setInterval(()=>setClock(Date.now()),1000);return()=>{clearInterval(interval);clearInterval(seconds);active.current?.abort();};},[]);
  useEffect(()=>{
    if(!state||openIncidentId===undefined||openedIncident.current?.id===openIncidentId&&openedIncident.current?.key===openRequestKey)return;
    setTab('overview');setDialog(null);
    const incident=(state.incidents||[]).find(item=>item.id===openIncidentId);
    if(openIncidentId&&!incident&&(openRefresh.current?.id!==openIncidentId||openRefresh.current?.key!==openRequestKey)){
      openRefresh.current={id:openIncidentId,key:openRequestKey};void refresh();return;
    }
    openedIncident.current={id:openIncidentId,key:openRequestKey};
    if(!openIncidentId)return;
    if(incident&&(state.areas||[]).some(area=>area.id===incident.areaId))setAreaId(incident.areaId);
    else setMessage('The requested security alarm is no longer in the available history. Showing the current overview.');
  },[state,openIncidentId,openRequestKey]);
  async function save(route,body,successMessage){
    if(error)throw Error('Reconnect to security before applying this change.');
    setBusy(true);setMessage('');
    try{const result=await request(route,body);await refresh();setDialog(null);setMessage(successMessage?successMessage(result):route==='security/settings'?'Zone reading timeout saved.':route.includes('command')?'Area command applied.':route.includes('bypass')?'Zone bypass updated.':'Security configuration saved.');return result;}
    catch(cause){if(['security/settings','security/cycle-bypass'].includes(route)&&cause.status===409)await refresh();throw cause;}
    finally{setBusy(false);}
  }
  async function acknowledgeAll(){
    if(busy||error)return;
    setAcknowledgeError('');
    try{
      await save('security/acknowledge-all',{},result=>result.acknowledged
        ?'Acknowledged '+plural(result.acknowledged,'security alarm')+'.'
        :'No security alarms needed acknowledgement.');
    }catch(cause){setAcknowledgeError(cause.message);}
  }
  if(!state)return <div className="security-loading" role={error?'alert':'status'}>{loading?'Opening security…':error}{error?<button onClick={refresh}>Try again</button>:null}</div>;
  const areas=state.areas||[],zones=state.zones||[],selected=areas.find(area=>area.id===areaId)||areas[0]||null;
  const p=state.permissions||permissions,manage=p.manageSecurity,control=p.controlSecurity;
  const now=(state.now??Date.now())+Math.max(0,clock-received.current);
  const openForm=(kind,item=null)=>setDialog({type:'form',kind,item});
  const openCommand=(action,area=selected)=>{if(area)setDialog({type:'command',area,action});};
  const currentAreas=new Map(areas.map(area=>[area.id,area]));
  const safeState={...state,areas,zones,schedules:state.schedules||[],actions:state.actions||[],incidents:state.incidents||[],events:state.events||[],deliveries:state.deliveries||[],networks:state.networks||[]};
  const canOpenKeypad=typeof onKeypadBypass==='function';
  const bypassZone=dialog?.type==='cycle-bypass'?zones.find(zone=>zone.id===dialog.item.id):null;
  const currentBypassChoices=control&&!error&&bypassZone?bypassChoices(bypassZone,currentAreas,canOpenKeypad):[];
  const availableBypassIds=dialog?.type==='cycle-bypass'
    ?dialog.choices.filter(choice=>currentBypassChoices.some(current=>current.id===choice.id&&current.mode===choice.mode
      &&current.cycleId===choice.cycleId)).map(choice=>choice.id)
    :[];
  function openBypass(zone,choices){
    if(manualBypass(zone)){setDialog({type:'clear-bypass',item:zone});return;}
    if(choices.length===1&&choices[0].mode==='disarmed'){
      onKeypadBypass({areaId:choices[0].id,zoneId:zone.id});
    }else if(choices.length){
      setDialog({type:'cycle-bypass',item:zone,choices});
    }
  }
  async function confirmCycleBypass(choice){
    if(!bypassZone||busy||!availableBypassIds.includes(choice.id)){
      throw Error('The area or zone changed. Review its current status before bypassing.');
    }
    if(choice.mode==='disarmed'){
      setDialog(null);
      onKeypadBypass({areaId:choice.id,zoneId:bypassZone.id});
      return;
    }
    await save('security/cycle-bypass',{areaId:choice.id,zoneId:bypassZone.id,cycleId:choice.cycleId},
      ()=>bypassZone.name+' is bypassed in '+choice.name+' until disarm.');
  }
  return <div className="security-workspace">
    <nav className="security-tabs" aria-label="Security pages">{tabs.map(([id,label])=><button key={id} aria-current={tab===id?'page':undefined} className={tab===id?'active':''} onClick={()=>setTab(id)}>{label}</button>)}</nav>
    {error?<div className="notice critical" role="alert"><strong>Security connection lost.</strong> Showing the last received state. Controls are unavailable until reconnection.<button onClick={refresh}>Reconnect</button></div>:null}
    {message?<div className="security-message" role="status"><Icon name="check" size={16}/>{message}<button className="icon-button" aria-label="Dismiss security message" onClick={()=>setMessage('')}><Icon name="close" size={15}/></button></div>:null}
    {tab==='overview'?<>
      <div className="security-console">
        <section className="security-area-rail" aria-label="Security areas"><PanelHeading title="Areas">{manage?<button className="security-add" aria-label="Add area" onClick={()=>openForm('area')} disabled={busy||!!error}><span aria-hidden="true">+</span> Add area</button>:null}</PanelHeading>
          {areas.length?<div className="security-area-list">{areas.map(area=><button key={area.id} className={'security-area-row '+(area.id===selected?.id?'selected':'')} aria-pressed={area.id===selected?.id} onClick={()=>setAreaId(area.id)}><Icon name="shield" size={23}/><span><strong>{area.name}</strong><small className={area.status==='alarm'?'security-alarm-text':''}>{areaStatus(area)}{area.activeAlarmCount>0&&area.status!=='alarm'?' · Alarm memory':''}</small></span><Icon name="chevron" size={14}/></button>)}</div>:<p className="security-rail-empty">No areas yet.</p>}
        </section>
        {selected?<AreaPanel area={selected} zones={zonesForArea(zones,selected.id)} incidents={safeState.incidents.filter(incident=>incident.areaId===selected.id&&incident.resetAt==null)} now={now} control={control&&!error&&!busy} manage={manage&&!error&&!busy} removeAllowed={areaRemovable(selected,zones,currentAreas,safeState.incidents)} onCommand={openCommand} onEdit={()=>openForm('area',selected)} onRemove={()=>setDialog({type:'remove',kind:'area',item:selected})} onZones={()=>setTab('zones')}/>:<section className="security-area-panel"><EmptyPanel title="Create your first security area" action={manage?<button className="primary" onClick={()=>openForm('area')} disabled={busy||!!error}>Add area</button>:null}>{manage?'Add an area, then select its Zigbee devices as zones. New areas start disarmed.':'An administrator can add areas and assign devices as security zones.'}</EmptyPanel></section>}
      </div>
      <SecurityAlarmStack state={safeState} areas={currentAreas} control={control&&!busy&&!error} onCommand={openCommand}
        onAcknowledgeAll={control?acknowledgeAll:undefined} acknowledgeError={acknowledgeError}/>
      <RecentActivity state={safeState} areas={currentAreas}/>
    </>:tab==='zones'?<Zones state={safeState} manage={manage&&!busy&&!error} control={control&&!busy&&!error}
      canOpenKeypad={canOpenKeypad} onAdd={()=>openForm('zone')} onEdit={item=>openForm('zone',item)}
      onRemove={item=>setDialog({type:'remove',kind:'zone',item})} onBypass={openBypass}
    />:tab==='schedules'?<Schedules state={safeState} manage={manage&&!busy&&!error} onAdd={()=>openForm('schedule')} onEdit={item=>openForm('schedule',item)} onRemove={item=>setDialog({type:'remove',kind:'schedule',item})}/>:tab==='actions'?<AlertActions state={safeState} manage={manage&&!busy&&!error} onAdd={()=>openForm('action')} onEdit={item=>openForm('action',item)} onRemove={item=>setDialog({type:'remove',kind:'action',item})}/>:<SecuritySettings timeout={state.readingTimeoutMin} canChange={state.canChangeReadingTimeout===true} manage={manage} busy={busy} disconnected={!!error} onSave={save}/>}
    {demo?<p className="security-demo-note"><Icon name="flask" size={15}/>Simulation only. Security actions do not publish MQTT messages or send email.</p>:null}
    {dialog?.type==='form'?<SecurityForm key={dialog.kind+(dialog.item?.id||'new')} kind={dialog.kind} item={dialog.item} state={safeState} areaId={selected&&canConfigure(selected)?selected.id:areas.find(canConfigure)?.id} onClose={()=>setDialog(null)} onSave={save} onAccount={onAccount}/>:dialog?.type==='command'?<SecurityCommandDialog area={areas.find(area=>area.id===dialog.area.id)||dialog.area} action={dialog.action} zones={zonesForArea(zones,dialog.area.id)} onClose={()=>setDialog(null)} onSave={save}/>:dialog?.type==='clear-bypass'?<SecurityClearBypassDialog zone={dialog.item} onClose={()=>setDialog(null)} onSave={save}/>:dialog?.type==='cycle-bypass'?
      <SecurityCycleBypassDialog zone={dialog.item} choices={dialog.choices} availableIds={availableBypassIds}
        onClose={()=>setDialog(null)} onConfirm={confirmCycleBypass}/>
      :dialog?.type==='remove'?<SecurityRemoveDialog kind={dialog.kind} item={dialog.item} onClose={()=>setDialog(null)} onSave={save}/>:null}
  </div>;
}

function SecuritySettings({timeout,canChange,manage,busy,disconnected,onSave}){
  const [draft,setDraft]=useState(null),[error,setError]=useState('');
  const available=validReadingTimeout(timeout);
  const value=draft?.value??(available?String(timeout):'');
  const minutes=Number(value);
  const changed=minutes!==timeout;
  const conflict=draft!==null&&draft.base!==timeout&&changed;
  const blocked=busy||disconnected||!canChange||!available;
  const canSave=draft!==null&&!blocked&&!conflict&&changed&&validReadingTimeout(minutes);

  function reset(){
    setDraft(null);
    setError('');
  }
  async function submit(event){
    event.preventDefault();
    if(!canSave)return;
    setError('');
    try{
      await onSave('security/settings',{readingTimeoutMin:minutes,expectedReadingTimeoutMin:draft.base});
      setDraft(null);
    }catch(cause){
      setError(cause.message);
    }
  }

  return <section className="security-section" aria-label="Security settings">
    <PanelHeading title="Security settings"/>
    <div className="security-settings-content">
      <h3>Zone reading timeout</h3>
      <p id="security-timeout-help">This applies to every security zone. When the last report for a zone’s activation property exceeds the timeout, the zone becomes unknown and blocks standard arming until it receives a fresh reading.</p>
      {available?<dl className="security-timeout-current">
        <dt>Current timeout</dt>
        <dd>{timeoutDuration(timeout)}{timeout>=60?<span className="muted"> ({timeout.toLocaleString()} minutes)</span>:null}</dd>
      </dl>:<p className="notice warning" role="status">The reading timeout is unavailable.</p>}
      {manage&&available?<form className="security-settings-form" onSubmit={submit}>
        {!disconnected&&!canChange?<p className="notice warning" role="status">Disarm every area before changing the reading timeout.</p>:null}
        <Field label="Reading timeout" type="number" min={1} max={43200} step={1} required inputMode="numeric" unit="minutes"
          disabled={blocked||conflict} value={value} aria-describedby="security-timeout-help"
          onChange={event=>{setDraft({value:event.target.value,base:draft&&Number(draft.value)!==timeout?draft.base:timeout});setError('');}}/>
        {conflict&&!busy?<p className="notice warning" role="status">The saved timeout changed while you were editing. Reset your draft to use the current value.</p>:null}
        {error&&!conflict?<p className="notice critical" role="alert">{error}</p>:null}
        <div className="security-settings-actions">
          <button type="submit" className="primary" disabled={!canSave}>{busy?'Saving…':'Save reading timeout'}</button>
          {draft!==null?<button type="button" onClick={reset} disabled={busy}>Reset draft</button>:null}
        </div>
      </form>:null}
    </div>
  </section>;
}

function AreaPanel({area,zones,incidents,now,control,manage,removeAllowed,onCommand,onEdit,onRemove,onZones}){
  const memory=area.activeAlarmCount>0,alarm=area.status==='alarm',waiting=['entry_delay','exit_delay'].includes(area.status);
  const enabledZones=zones.filter(zone=>zone.enabled);
  const alwaysActiveCount=area.alwaysActiveZoneCount??enabledZones.filter(zone=>zone.type==='24hour').length;
  const armingCount=(area.zoneCount??enabledZones.length)-alwaysActiveCount;
  const armingReady=area.readyCount??enabledZones.filter(zone=>zone.type!=='24hour'&&zone.known&&!zone.active&&!zone.trouble&&!zone.bypassed).length;
  const disarmed24HourAlarm=area.mode==='disarmed'&&area.active24HourAlarmCount>0;
  const countdown=Math.max(0,Math.ceil((((area.status==='entry_delay'?area.entryAt:area.exitAt)||now)-now)/1000));
  const attentionCount=(area.blockingZones||[]).length||area.troubleCount||1;
  let alarmDetail='Alarm memory latched';
  if(disarmed24HourAlarm&&area.unacknowledged24HourAlarmCount>0){
    alarmDetail=incidents.some(incident=>incident.zoneType==='24hour'&&incident.restoredAt==null)?'24-hour zone active':'Awaiting acknowledgement';
  }
  const subtitle=alarm?(modeName[area.mode]+' · '+alarmDetail):memory?'Alarm memory requires attention':area.status==='entry_delay'?'Disarm before the entry delay expires':area.status==='exit_delay'?'Leave the area before the exit delay expires':area.ready?'Ready to arm':!area.enabled?'Area disabled':!enabledZones.length?'Add zones to this area':!armingCount?'No zones configured for arming':plural(attentionCount,'zone')+(attentionCount===1?' needs':' need')+' attention';
  const tone=alarm||memory?'alarm':area.ready?'ready':'attention';
  return <section className={'security-area-panel security-tone-'+tone} aria-label={area.name+' security panel'}>
    <div className="security-area-panel-heading"><h2>{area.name}</h2>{manage?<div className="security-area-tools"><button className="icon-button" aria-label={'Edit area '+area.name} title={canConfigure(area)?'Edit area':'Disarm this area before editing'} disabled={!canConfigure(area)} onClick={onEdit}><Icon name="settings" size={17}/></button><button className="icon-button" aria-label={'Remove area '+area.name} title={removeAllowed?'Remove area':'Disarm all linked areas and reset shared-zone alarm memory before removing this area'} disabled={!removeAllowed} onClick={onRemove}><Icon name="close" size={16}/></button></div>:null}</div>
    <div className="security-area-main"><div className="security-area-controls">
      <div className="security-status-display" aria-live="polite"><Shield alert={alarm||memory}/><div><strong>{areaStatus(area)}</strong><p>{subtitle}</p>{waiting?<b className="security-countdown" role="timer" aria-live="off">{Math.floor(countdown/60)}:{String(Math.floor(countdown%60)).padStart(2,'0')}</b>:null}</div></div>
      <div className="security-mode-buttons"><button className={area.mode==='disarmed'&&!waiting?'current-mode':''} disabled={!control||area.mode==='disarmed'&&!waiting} onClick={()=>onCommand('disarm',area)}>Disarm</button><button className="primary" disabled={!control||!canConfigure(area)||!area.enabled} onClick={()=>onCommand('arm_home',area)}>Arm Home</button><button className="primary" disabled={!control||!canConfigure(area)||!area.enabled} onClick={()=>onCommand('arm_away',area)}>Arm Away</button></div>
      <p className="security-zone-count"><strong>{plural(armingCount,alwaysActiveCount?'arming zone':'zone')}</strong>{armingCount||!alwaysActiveCount?<><span>·</span>{area.ready?'All ready':armingReady+' ready'}</>:null}{alwaysActiveCount>0?<><span>·</span>{plural(alwaysActiveCount,'24-hour zone')}</>:null}</p>
      <p className="security-delays">Entry delay {area.entryDelaySec}s · Exit delay {area.exitDelaySec}s{area.bypassedCount?' · '+plural(area.bypassedCount,'bypass'):''}</p>
      {area.cycleBypassCount>0?<div className="notice warning" style={{overflowWrap:'anywhere'}}><strong>{area.cycleBypassCount} cycle {area.cycleBypassCount===1?'bypass':'bypasses'} until disarm</strong><p>{(area.cycleBypasses||[]).map(zone=>zone.name).join(', ')}</p></div>:null}
      {memory&&control?<div className="security-memory-actions"><button onClick={()=>onCommand('acknowledge',area)}>Acknowledge alarms</button><button disabled={area.mode!=='disarmed'||!incidents.every(incident=>incident.ackAt)||!zones.every(zone=>zone.ready)} onClick={()=>onCommand('reset',area)}>Reset memory</button></div>:null}
    </div><div className="security-zone-preview"><h3>Zone status</h3><div className="security-zone-list">{zones.length?zones.slice(0,4).map(zone=><div key={zone.id}><span>{zone.name}</span><span className={'security-zone-state '+zoneTone(zone)} title={zone.trouble||undefined}>{zoneLabel(zone)}</span></div>):<p className="security-no-zones">No zones assigned.</p>}<button onClick={onZones}>View all zones<Icon name="chevron" size={14}/></button></div></div></div>
  </section>;
}

function SecurityAlarmStack({state,areas,control,onCommand,onAcknowledgeAll,acknowledgeError}){
  const incidents=state.incidents.filter(incident=>incident.resetAt===null||incident.resetAt===undefined);
  const unacknowledged=incidents.some(incident=>incident.ackAt==null&&areas.has(incident.areaId));
  const canResetArea=id=>areas.get(id)?.mode==='disarmed'&&incidents.filter(incident=>incident.areaId===id).every(incident=>incident.ackAt)&&zonesForArea(state.zones,id).every(zone=>zone.ready);
  const table=useTable(incidents.map(incident=>({...incident,name:incident.zoneName||incident.deviceName||'Zone',areaName:incident.areaName||areas.get(incident.areaId)?.name||'Removed area',networkLabel:[incident.areaName,incident.zoneName,incident.deviceName,incident.description].join(' '),alarmState:incident.ackAt?'Acknowledged':'Unacknowledged'})),'raisedAt');
  return <section className="security-section security-alarm-stack" aria-label="Security alarm stack">
    <PanelHeading title="Security alarm stack" count={incidents.length||undefined}>
      {onAcknowledgeAll?<button type="button" disabled={!control||!unacknowledged} onClick={onAcknowledgeAll}>Acknowledge all</button>:null}
    </PanelHeading>
    {acknowledgeError?<p className="notice critical" role="alert">{acknowledgeError}</p>:null}
    {incidents.length?<><div className="table-scroll security-table"><table><thead><tr><SortHead column="raisedAt" table={table}>Raised</SortHead><SortHead column="areaName" table={table}>Area / zone</SortHead><SortHead column="alarmState" table={table}>State</SortHead><th>Actions</th></tr></thead><tbody>{table.rows.map(incident=><tr key={incident.id}><td>{date(incident.raisedAt,true)}</td><td><strong>{incident.areaName}</strong><span className="row-subtitle">{incident.name}</span></td><td><Badge tone={incident.ackAt?'acknowledged':'critical'}>{incident.alarmState}</Badge>{incident.zoneType==='24hour'?<span className="row-subtitle">24-hour alarm</span>:null}{incident.restoredAt?<span className="security-restored">Zone restored</span>:null}</td><td><div className="record-actions">{areas.get(incident.areaId)&&control?<><button disabled={!!incident.ackAt} onClick={()=>onCommand('acknowledge',areas.get(incident.areaId))}>Acknowledge</button><button disabled={!canResetArea(incident.areaId)} onClick={()=>onCommand('reset',areas.get(incident.areaId))}>Reset memory</button></>:<span className="muted">—</span>}</div></td></tr>)}</tbody></table></div>{incidents.length>10?<Pagination total={table.filtered.length} {...table}/>:null}</>:<div className="security-clear-state"><Icon name="check" size={24}/><p>No active <strong>security alarms</strong></p></div>}
  </section>;
}

function RecentActivity({state,areas}){
  const table=useTable(state.events.map(event=>({...event,order:-event.at,name:event.message,areaName:event.areaName||areas.get(event.areaId)?.name||'System',networkLabel:[event.message,event.actor,event.type].join(' ')})),'order');
  return <section className="security-section security-activity" aria-label="Recent security activity"><PanelHeading title="Recent activity"/>{table.filtered.length?<><div className="table-scroll security-table"><table><thead><tr><SortHead column="at" table={table}>Time</SortHead><SortHead column="areaName" table={table}>Area</SortHead><th>Event</th><SortHead column="actor" table={table}>By</SortHead></tr></thead><tbody>{table.rows.map(event=><tr key={event.id}><td>{date(event.at,true)}</td><td>{event.areaName}</td><td>{event.message}</td><td>{event.actor||'System'}</td></tr>)}</tbody></table></div>{table.filtered.length>10?<Pagination total={table.filtered.length} {...table}/>:null}</>:<p className="security-table-empty">Area changes, zone alarms and schedule activity appear here.</p>}</section>;
}

function MembershipStatus({zone}){
  const ids=membershipIds(zone);
  if(ids.length<2)return <Badge tone={zoneTone(zone)}>{zoneLabel(zone)}</Badge>;
  return <div className="security-shared-statuses">{ids.map((id,index)=>{const view=zoneForArea(zone,id);return <span key={id}><span>{zone.areaNames[index]}</span><Badge tone={zoneTone(view)}>{zoneLabel(view)}</Badge></span>;})}</div>;
}

function Zones({state,manage,control,canOpenKeypad,onAdd,onEdit,onRemove,onBypass}){
  const areas=new Map(state.areas.map(area=>[area.id,area]));
  const table=useTable(state.zones.map(zone=>{const areaNames=membershipIds(zone).map(id=>areas.get(id)?.name||'Removed area');return {...zone,areaNames,areaName:areaNames.join(', '),networkLabel:[zone.deviceName,zone.networkLabel,...areaNames,zone.property].join(' ')};}));
  return <section className="security-section" aria-label="Security zones">
    <PanelHeading title="Zones" count={state.zones.length}><div className="security-table-tools"><SearchBox label="Search zones" table={table}/>{manage?<button className="primary" onClick={onAdd} disabled={!state.areas.some(canConfigure)}>+ Add zone</button>:null}</div></PanelHeading>
    {state.zones.some(zone=>membershipIds(zone).length>1)?<p className="security-section-intro">A shared zone protects every listed area. Each area has its own arming cycle, bypasses, delays and alarms.</p>:null}
    {!state.areas.length?<p className="security-table-empty">Create an area first, then assign its Zigbee devices as zones.</p>:table.filtered.length?<>
      <div className="table-scroll security-table"><table><thead><tr><SortHead column="name" table={table}>Zone</SortHead><SortHead column="areaName" table={table}>Areas</SortHead><SortHead column="deviceName" table={table}>Device</SortHead><SortHead column="type" table={table}>Type</SortHead><SortHead column="status" table={table}>Status by area</SortHead><th>Actions</th></tr></thead><tbody>{table.rows.map(zone=>{
        const editable=zoneEditable(zone,areas),shared=membershipIds(zone).length>1,alarmMemory=state.incidents.some(incident=>incident.zoneId===zone.id&&incident.resetAt==null),manual=manualBypass(zone),cycleNames=membershipIds(zone).filter(id=>zoneForArea(zone,id).cycleBypassed).map(id=>areas.get(id)?.name||'Removed area');
        const choices=control?bypassChoices(zone,areas,canOpenKeypad):[];
        const showBypass=control&&(zone.type!=='24hour'||manual);
        const bypassLabel=manual?'Clear manual bypass':choices.length===1
          ?choices[0].mode==='disarmed'?'Bypass for Arm Away':'Bypass until disarm…'
          :'Bypass zone…';
        return <tr key={zone.id}>
          <td><strong>{zone.name}</strong>{zone.type!=='24hour'&&zone.homeBypass?<span className="row-subtitle">Bypassed in Home mode</span>:null}</td>
          <td className="security-zone-memberships">{zone.areaName}{shared?<span className="row-subtitle">Shared zone · {membershipIds(zone).length} areas</span>:null}</td>
          <td>{zone.deviceName||'Device unavailable'}<span className="row-subtitle">{zone.networkLabel}</span></td>
          <td>{zoneTypeName[zone.type]||'Instant'}{zone.type==='24hour'&&zone.silent?<span className="row-subtitle">Silent on keypad</span>:null}</td>
          <td><MembershipStatus zone={zone}/>{zone.trouble?<span className="row-subtitle">{zone.trouble}</span>:null}{manual?<span className="row-subtitle">{zone.bypassUntil?'Manual bypass until '+date(zone.bypassUntil,true):'Until manually cleared'}</span>:null}{cycleNames.length?<span className="row-subtitle">Cycle bypass until disarm: {cycleNames.join(', ')}</span>:null}</td>
          <td><div className="record-actions">{manage?<>
            <button aria-label={'Edit zone '+zone.name} title={editable?'Edit shared zone settings':'Disarm every linked area before editing this zone'} disabled={!editable} onClick={()=>onEdit(zone)}>Edit</button>
            <button aria-label={'Remove zone '+zone.name} title={alarmMemory?'Reset this zone’s alarm memory before removing it':editable?'Remove this zone from every linked area':'Disarm every linked area before removing this zone'} disabled={!editable||alarmMemory} onClick={()=>onRemove(zone)}>Remove</button>
          </>:null}{showBypass?<button type="button" aria-label={bypassLabel+' · '+zone.name} disabled={!manual&&!choices.length}
            title={manual&&shared?'Clear the existing bypass in every linked area':!manual&&!choices.length?'No linked area can bypass this zone right now':undefined}
            onClick={()=>onBypass(zone,choices)}>{bypassLabel}</button>:null}{!manage&&!showBypass?<span className="muted">Read only</span>:null}</div></td>
        </tr>;
      })}</tbody></table></div><Pagination total={table.filtered.length} {...table}/>
    </>:<p className="security-table-empty">{table.search?'No zones match this search.':'No zones yet. Select a Zigbee device, its activation and one or more areas it protects.'}</p>}
  </section>;
}
function Schedules({state,manage,onAdd,onEdit,onRemove}){
  const areas=new Map(state.areas.map(area=>[area.id,area]));
  const table=useTable(state.schedules.map(schedule=>({...schedule,areaName:areas.get(schedule.areaId)?.name||'Removed area',networkLabel:[areas.get(schedule.areaId)?.name,schedule.time,schedule.timezone].join(' ')})));
  return <section className="security-section" aria-label="Arm and disarm schedules"><PanelHeading title="Schedules" count={state.schedules.length}><div className="security-table-tools"><SearchBox label="Search schedules" table={table}/>{manage?<button className="primary" disabled={!state.areas.some(canConfigure)} onClick={onAdd}>+ Add schedule</button>:null}</div></PanelHeading><p className="security-section-intro">Arm or disarm an area at a local time on selected days. New schedules start disabled; missed times are not replayed.</p>
    {table.filtered.length?<><div className="table-scroll security-table"><table><thead><tr><SortHead column="name" table={table}>Schedule</SortHead><SortHead column="areaName" table={table}>Area</SortHead><th>When</th><SortHead column="mode" table={table}>Set area to</SortHead><SortHead column="enabled" table={table}>Status</SortHead><th>Actions</th></tr></thead><tbody>{table.rows.map(schedule=><tr key={schedule.id}><td><strong>{schedule.name}</strong></td><td>{schedule.areaName}</td><td>{schedule.time} · {schedule.days.map(day=>days[day]).join(', ')}<span className="row-subtitle">{schedule.timezone}</span></td><td>{modeName[schedule.mode]}</td><td><Badge tone={schedule.enabled?'healthy':'neutral'}>{schedule.enabled?'Enabled':'Disabled'}</Badge></td><td>{manage?<div className="record-actions"><button aria-label={'Edit schedule '+schedule.name} disabled={!canConfigure(areas.get(schedule.areaId))} onClick={()=>onEdit(schedule)}>Edit</button><button aria-label={'Remove schedule '+schedule.name} disabled={!canConfigure(areas.get(schedule.areaId))} onClick={()=>onRemove(schedule)}>Remove</button></div>:<span className="muted">Read only</span>}</td></tr>)}</tbody></table></div><Pagination total={table.filtered.length} {...table}/></>:<p className="security-table-empty">{table.search?'No schedules match this search.':'No schedules configured.'}</p>}
  </section>;
}

function AlertActions({state,manage,onAdd,onEdit,onRemove}){
  const areas=new Map(state.areas.map(area=>[area.id,area])),networks=new Map(state.networks.map(network=>[network.id,network])),recipients=new Map((state.securityPushRecipients||[]).map(recipient=>[recipient.id,recipient.label]));
  const table=useTable(state.actions.map(action=>({...action,areaName:areas.get(action.areaId)?.name||'Removed area',networkLabel:[areas.get(action.areaId)?.name,deliveryName[action.kind],action.topic,...(action.subscriptionIds||[]).map(id=>recipients.get(id))].join(' ')})));
  return <>
    <section className="security-section" aria-label="Security alert actions"><PanelHeading title="Alert actions" count={state.actions.length}><div className="security-table-tools"><SearchBox label="Search alert actions" table={table}/>{manage?<button className="primary" disabled={!state.areas.some(canConfigure)} onClick={onAdd}>+ Add alert action</button>:null}</div></PanelHeading><p className="security-section-intro">Send an MQTT event, email or browser push when a zone activates in an armed area. Security alerts use the actions configured here, separately from health notifications.</p>
      {table.filtered.length?<><div className="table-scroll security-table"><table><thead><tr><SortHead column="name" table={table}>Action</SortHead><SortHead column="areaName" table={table}>Area</SortHead><SortHead column="kind" table={table}>Delivery</SortHead><th>Destination</th><SortHead column="enabled" table={table}>Status</SortHead><th>Actions</th></tr></thead><tbody>{table.rows.map(action=><tr key={action.id}><td><strong>{action.name}</strong></td><td>{action.areaName}</td><td>{deliveryName[action.kind]||action.kind}</td><td>{action.kind==='mqtt'?<>{networks.get(action.networkId)?.label||'Configured broker'}<span className="row-subtitle monospace">{action.topic}</span></>:action.kind==='push'?<PushDestination action={action} recipients={recipients}/>:action.kind==='email'?'Existing SMTP settings':'—'}</td><td><Badge tone={action.enabled?'healthy':'neutral'}>{action.enabled?'Enabled':'Disabled'}</Badge></td><td>{manage?<div className="record-actions"><button aria-label={'Edit alert action '+action.name} disabled={!canConfigure(areas.get(action.areaId))} onClick={()=>onEdit(action)}>Edit</button><button aria-label={'Remove alert action '+action.name} disabled={!canConfigure(areas.get(action.areaId))} onClick={()=>onRemove(action)}>Remove</button></div>:<span className="muted">Read only</span>}</td></tr>)}</tbody></table></div><Pagination total={table.filtered.length} {...table}/></>:<p className="security-table-empty">{table.search?'No alert actions match this search.':'No alert actions configured. New actions start disabled.'}</p>}
    </section>
    {state.deliveries.length?<section className="security-section" aria-label="Security delivery log"><PanelHeading title="Delivery log"/><div className="table-scroll security-table"><table><thead><tr><th>Time</th><th>Action</th><th>Result</th><th>Details</th></tr></thead><tbody>{state.deliveries.slice(0,20).map(delivery=><tr key={delivery.id}><td>{date(delivery.createdAt||delivery.at,true)}</td><td>{delivery.name||delivery.actionName||delivery.kind||'Security alert'}</td><td><Badge tone={['accepted','sent','delivered'].includes(delivery.status)?'healthy':['uncertain','failed'].includes(delivery.status)?'warning':'neutral'}>{delivery.status}</Badge></td><td>{delivery.results?.length?<div className="security-push-results">{delivery.results.map(result=><span key={result.id}><strong>{result.label||'Registered browser'}</strong>: {result.status}{result.error?' · '+result.error:''}</span>)}</div>:delivery.error||delivery.detail||'—'}</td></tr>)}</tbody></table></div></section>:null}
  </>;
}

function PushDestination({action,recipients}){
  const ids=action.subscriptionIds||[],names=ids.map(id=>recipients.get(id)).filter(Boolean),unavailable=ids.length-names.length;
  return <div className="security-push-destination">{plural(ids.length,'browser')}{names.length?<span className="row-subtitle">{names.join(', ')}</span>:null}{unavailable?<span className="row-subtitle">{plural(unavailable,'registration')} unavailable{names.length?'': ' or hidden by your access'}</span>:null}</div>;
}
