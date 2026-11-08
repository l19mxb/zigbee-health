import React,{useEffect,useRef,useState} from 'react';
import {request} from './api.jsx';
import {Badge,Icon,Pagination,date} from './ui.jsx';
import {SortHead,useTable} from './tables.jsx';
import {SecurityBypassDialog,SecurityCommandDialog,SecurityForm,SecurityRemoveDialog} from './security-forms.jsx';
import './security.css';

const tabs=[['overview','Overview'],['zones','Zones'],['schedules','Schedules'],['actions','Alert actions']];
const modeName={disarmed:'Disarmed',home:'Armed Home',away:'Armed Away'};
const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const canConfigure=area=>area?.mode==='disarmed'&&!['exit_delay','entry_delay'].includes(area.status);
const membershipIds=zone=>Array.isArray(zone.areaIds)&&zone.areaIds.length?zone.areaIds:zone.areaId?[zone.areaId]:[];
function zoneForArea(zone,areaId){
  const context=zone.areaStates?.find(state=>state.areaId===areaId);
  if(context)return {...zone,...context,areaId};
  return membershipIds(zone).length>1?{...zone,areaId,known:false,active:null,status:'unknown',ready:false,homeExcluded:false,trouble:'Area state unavailable'}:{...zone,areaId};
}
const zonesForArea=(zones,areaId)=>zones.filter(zone=>membershipIds(zone).includes(areaId)).map(zone=>zoneForArea(zone,areaId));
const zoneEditable=(zone,areas)=>membershipIds(zone).length>0&&membershipIds(zone).every(id=>canConfigure(areas.get(id)));
const areaRemovable=(area,zones,areas,incidents)=>canConfigure(area)&&!area.activeAlarmCount&&zones.filter(zone=>membershipIds(zone).includes(area.id)).every(zone=>zoneEditable(zone,areas)&&!incidents.some(incident=>incident.zoneId===zone.id&&incident.resetAt==null));
const plural=(number,noun)=>number+' '+noun+(number===1?'':noun==='bypass'?'es':'s');
function areaStatus(area){return area.status==='alarm'?'Alarm':area.status==='exit_delay'?'Exit delay':area.status==='entry_delay'?'Entry delay':modeName[area.mode]||'Disarmed';}
function zoneLabel(zone){if(zone.bypassed||zone.status==='bypassed')return 'Bypassed';if(!zone.enabled)return 'Disabled';if(zone.trouble||zone.status==='trouble')return 'Trouble';if(!zone.known||zone.status==='unknown')return 'Waiting for reading';if(zone.active)return zone.property==='contact'?'Open':'Active';return zone.property==='contact'?'Closed':['occupancy','vibration'].includes(zone.property)?'Clear':'Normal';}
function zoneTone(zone){return zone.bypassed||zone.status==='bypassed'||!zone.enabled?'neutral':zone.trouble||!zone.known?'warning':zone.active?'critical':'healthy';}
function Shield({alert=false}){return <svg className="security-shield" viewBox="0 0 80 92" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M40 5 69 18v24c0 22-18 36-29 43C29 78 11 64 11 42V18L40 5Z"/>{alert?<path d="M40 28v23m0 10v2"/>:null}</svg>;}
function PanelHeading({title,count,children}){return <header className="security-panel-heading"><h2>{title}{count!==undefined?<span className="count">{count}</span>:null}</h2>{children}</header>;}
function SearchBox({label,table}){return <label className="search compact"><Icon name="search"/><input aria-label={label} placeholder={label+'…'} value={table.search} onChange={event=>table.setSearch(event.target.value)}/></label>;}
function EmptyPanel({title,children,action}){return <div className="security-empty"><Icon name="shield" size={34}/><h3>{title}</h3><p>{children}</p>{action}</div>;}

export default function Security({permissions={},demo=false}){
  const [state,setState]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[tab,setTab]=useState('overview'),[areaId,setAreaId]=useState(''),[dialog,setDialog]=useState(null),[clock,setClock]=useState(Date.now());
  const active=useRef(null),received=useRef(Date.now());
  async function refresh(){
    active.current?.abort();const controller=new AbortController();active.current=controller;
    try{const value=await request('security',undefined,controller.signal);received.current=Date.now();setState(value);setError('');}
    catch(error){if(error.name!=='AbortError')setError(error.message);}
    finally{if(!controller.signal.aborted)setLoading(false);}
  }
  useEffect(()=>{void refresh();const interval=setInterval(()=>void refresh(),5000);const seconds=setInterval(()=>setClock(Date.now()),1000);return()=>{clearInterval(interval);clearInterval(seconds);active.current?.abort();};},[]);
  async function save(route,body){
    if(error)throw Error('Reconnect to security before applying this change.');
    setBusy(true);setMessage('');
    try{const result=await request(route,body);await refresh();setDialog(null);setMessage(route.includes('command')?'Area command applied.':route.includes('bypass')?'Zone bypass updated.':'Security configuration saved.');return result;}
    finally{setBusy(false);}
  }
  if(!state)return <div className="security-loading" role={error?'alert':'status'}>{loading?'Opening security…':error}{error?<button onClick={refresh}>Try again</button>:null}</div>;
  const areas=state.areas||[],zones=state.zones||[],selected=areas.find(area=>area.id===areaId)||areas[0]||null;
  const p=state.permissions||permissions,manage=p.manageSecurity,control=p.controlSecurity;
  const now=(state.now??Date.now())+Math.max(0,clock-received.current);
  const openForm=(kind,item=null)=>setDialog({type:'form',kind,item});
  const openCommand=(action,area=selected)=>{if(area)setDialog({type:'command',area,action});};
  const currentAreas=new Map(areas.map(area=>[area.id,area]));
  const safeState={...state,areas,zones,schedules:state.schedules||[],actions:state.actions||[],incidents:state.incidents||[],events:state.events||[],deliveries:state.deliveries||[],networks:state.networks||[]};
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
      <SecurityAlarmStack state={safeState} areas={currentAreas} control={control&&!busy&&!error} onCommand={openCommand}/>
      <RecentActivity state={safeState} areas={currentAreas}/>
    </>:tab==='zones'?<Zones state={safeState} manage={manage&&!busy&&!error} control={control&&!busy&&!error} onAdd={()=>openForm('zone')} onEdit={item=>openForm('zone',item)} onRemove={item=>setDialog({type:'remove',kind:'zone',item})} onBypass={(item,clear)=>setDialog({type:'bypass',item,clear})}/>:tab==='schedules'?<Schedules state={safeState} manage={manage&&!busy&&!error} onAdd={()=>openForm('schedule')} onEdit={item=>openForm('schedule',item)} onRemove={item=>setDialog({type:'remove',kind:'schedule',item})}/>:<AlertActions state={safeState} manage={manage&&!busy&&!error} onAdd={()=>openForm('action')} onEdit={item=>openForm('action',item)} onRemove={item=>setDialog({type:'remove',kind:'action',item})}/>}
    {demo?<p className="security-demo-note"><Icon name="flask" size={15}/>Simulation only. Security actions do not publish MQTT messages or send email.</p>:null}
    {dialog?.type==='form'?<SecurityForm key={dialog.kind+(dialog.item?.id||'new')} kind={dialog.kind} item={dialog.item} state={safeState} areaId={selected&&canConfigure(selected)?selected.id:areas.find(canConfigure)?.id} onClose={()=>setDialog(null)} onSave={save}/>:dialog?.type==='command'?<SecurityCommandDialog area={areas.find(area=>area.id===dialog.area.id)||dialog.area} action={dialog.action} zones={zonesForArea(zones,dialog.area.id)} onClose={()=>setDialog(null)} onSave={save}/>:dialog?.type==='bypass'?<SecurityBypassDialog zone={dialog.item} clear={dialog.clear} onClose={()=>setDialog(null)} onSave={save}/>:dialog?.type==='remove'?<SecurityRemoveDialog kind={dialog.kind} item={dialog.item} onClose={()=>setDialog(null)} onSave={save}/>:null}
  </div>;
}

function AreaPanel({area,zones,incidents,now,control,manage,removeAllowed,onCommand,onEdit,onRemove,onZones}){
  const memory=area.activeAlarmCount>0,alarm=area.status==='alarm',waiting=['entry_delay','exit_delay'].includes(area.status);
  const countdown=Math.max(0,Math.ceil((((area.status==='entry_delay'?area.entryAt:area.exitAt)||now)-now)/1000));
  const attentionCount=(area.blockingZones||[]).length||area.troubleCount||1;
  const subtitle=alarm?(modeName[area.mode]+' · Alarm memory latched'):memory?'Alarm memory requires attention':area.status==='entry_delay'?'Disarm before the entry delay expires':area.status==='exit_delay'?'Leave the area before the exit delay expires':area.ready?'Ready to arm':!area.enabled?'Area disabled':!zones.filter(zone=>zone.enabled).length?'Add zones to this area':plural(attentionCount,'zone')+(attentionCount===1?' needs':' need')+' attention';
  const tone=alarm||memory?'alarm':area.ready?'ready':'attention';
  return <section className={'security-area-panel security-tone-'+tone} aria-label={area.name+' security panel'}>
    <div className="security-area-panel-heading"><h2>{area.name}</h2>{manage?<div className="security-area-tools"><button className="icon-button" aria-label={'Edit area '+area.name} title={canConfigure(area)?'Edit area':'Disarm this area before editing'} disabled={!canConfigure(area)} onClick={onEdit}><Icon name="settings" size={17}/></button><button className="icon-button" aria-label={'Remove area '+area.name} title={removeAllowed?'Remove area':'Disarm all linked areas and reset shared-zone alarm memory before removing this area'} disabled={!removeAllowed} onClick={onRemove}><Icon name="close" size={16}/></button></div>:null}</div>
    <div className="security-area-main"><div className="security-area-controls">
      <div className="security-status-display" aria-live="polite"><Shield alert={alarm||memory}/><div><strong>{areaStatus(area)}</strong><p>{subtitle}</p>{waiting?<b className="security-countdown" role="timer" aria-live="off">{Math.floor(countdown/60)}:{String(Math.floor(countdown%60)).padStart(2,'0')}</b>:null}</div></div>
      <div className="security-mode-buttons"><button className={area.mode==='disarmed'&&!waiting?'current-mode':''} disabled={!control||area.mode==='disarmed'&&!waiting} onClick={()=>onCommand('disarm',area)}>Disarm</button><button className="primary" disabled={!control||!canConfigure(area)||!area.enabled} onClick={()=>onCommand('arm_home',area)}>Arm Home</button><button className="primary" disabled={!control||!canConfigure(area)||!area.enabled} onClick={()=>onCommand('arm_away',area)}>Arm Away</button></div>
      <p className="security-zone-count"><strong>{plural(area.zoneCount??zones.length,'zone')}</strong><span>·</span>{area.ready?'All ready':(area.readyCount??zones.filter(zone=>zone.known&&!zone.active&&!zone.trouble&&!zone.bypassed).length)+' ready'}</p>
      <p className="security-delays">Entry delay {area.entryDelaySec}s · Exit delay {area.exitDelaySec}s{area.bypassedCount?' · '+plural(area.bypassedCount,'bypass'):''}</p>
      {memory&&control?<div className="security-memory-actions"><button onClick={()=>onCommand('acknowledge',area)}>Acknowledge alarms</button><button disabled={area.mode!=='disarmed'||!incidents.every(incident=>incident.ackAt)||!zones.every(zone=>zone.ready)} onClick={()=>onCommand('reset',area)}>Reset memory</button></div>:null}
    </div><div className="security-zone-preview"><h3>Zone status</h3><div className="security-zone-list">{zones.length?zones.slice(0,4).map(zone=><div key={zone.id}><span>{zone.name}</span><span className={'security-zone-state '+zoneTone(zone)} title={zone.trouble||undefined}>{zoneLabel(zone)}</span></div>):<p className="security-no-zones">No zones assigned.</p>}<button onClick={onZones}>View all zones<Icon name="chevron" size={14}/></button></div></div></div>
  </section>;
}

function SecurityAlarmStack({state,areas,control,onCommand}){
  const incidents=state.incidents.filter(incident=>incident.resetAt===null||incident.resetAt===undefined);
  const canResetArea=id=>areas.get(id)?.mode==='disarmed'&&incidents.filter(incident=>incident.areaId===id).every(incident=>incident.ackAt)&&zonesForArea(state.zones,id).every(zone=>zone.ready);
  const table=useTable(incidents.map(incident=>({...incident,name:incident.zoneName||incident.deviceName||'Zone',areaName:incident.areaName||areas.get(incident.areaId)?.name||'Removed area',networkLabel:[incident.areaName,incident.zoneName,incident.deviceName,incident.description].join(' '),alarmState:incident.ackAt?'Acknowledged':'Unacknowledged'})),'raisedAt');
  return <section className="security-section security-alarm-stack" aria-label="Security alarm stack"><PanelHeading title="Security alarm stack" count={incidents.length||undefined}/>{incidents.length?<><div className="table-scroll security-table"><table><thead><tr><SortHead column="raisedAt" table={table}>Raised</SortHead><SortHead column="areaName" table={table}>Area / zone</SortHead><SortHead column="alarmState" table={table}>State</SortHead><th>Actions</th></tr></thead><tbody>{table.rows.map(incident=><tr key={incident.id}><td>{date(incident.raisedAt,true)}</td><td><strong>{incident.areaName}</strong><span className="row-subtitle">{incident.name}</span></td><td><Badge tone={incident.ackAt?'acknowledged':'critical'}>{incident.alarmState}</Badge>{incident.restoredAt?<span className="security-restored">Zone restored</span>:null}</td><td><div className="record-actions">{areas.get(incident.areaId)&&control?<><button disabled={!!incident.ackAt} onClick={()=>onCommand('acknowledge',areas.get(incident.areaId))}>Acknowledge</button><button disabled={!canResetArea(incident.areaId)} onClick={()=>onCommand('reset',areas.get(incident.areaId))}>Reset memory</button></>:<span className="muted">—</span>}</div></td></tr>)}</tbody></table></div>{incidents.length>10?<Pagination total={table.filtered.length} {...table}/>:null}</>:<div className="security-clear-state"><Icon name="check" size={24}/><p>No active <strong>security alarms</strong></p></div>}</section>;
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

function Zones({state,manage,control,onAdd,onEdit,onRemove,onBypass}){
  const areas=new Map(state.areas.map(area=>[area.id,area]));
  const table=useTable(state.zones.map(zone=>{const areaNames=membershipIds(zone).map(id=>areas.get(id)?.name||'Removed area');return {...zone,areaNames,areaName:areaNames.join(', '),networkLabel:[zone.deviceName,zone.networkLabel,...areaNames,zone.property].join(' ')};}));
  return <section className="security-section" aria-label="Security zones">
    <PanelHeading title="Zones" count={state.zones.length}><div className="security-table-tools"><SearchBox label="Search zones" table={table}/>{manage?<button className="primary" onClick={onAdd} disabled={!state.areas.some(canConfigure)}>+ Add zone</button>:null}</div></PanelHeading>
    {state.zones.some(zone=>membershipIds(zone).length>1)?<p className="security-section-intro">A shared zone protects every listed area. Activation settings and manual bypass are shared; arming, delays and alarms remain independent in each area.</p>:null}
    {!state.areas.length?<p className="security-table-empty">Create an area first, then assign its Zigbee devices as zones.</p>:table.filtered.length?<>
      <div className="table-scroll security-table"><table><thead><tr><SortHead column="name" table={table}>Zone</SortHead><SortHead column="areaName" table={table}>Areas</SortHead><SortHead column="deviceName" table={table}>Device</SortHead><SortHead column="type" table={table}>Type</SortHead><SortHead column="status" table={table}>Status by area</SortHead><th>Actions</th></tr></thead><tbody>{table.rows.map(zone=>{
        const editable=zoneEditable(zone,areas),shared=membershipIds(zone).length>1,alarmMemory=state.incidents.some(incident=>incident.zoneId===zone.id&&incident.resetAt==null);
        return <tr key={zone.id}>
          <td><strong>{zone.name}</strong>{zone.homeBypass?<span className="row-subtitle">Bypassed in Home mode</span>:null}</td>
          <td className="security-zone-memberships">{zone.areaName}{shared?<span className="row-subtitle">Shared zone · {membershipIds(zone).length} areas</span>:null}</td>
          <td>{zone.deviceName||'Device unavailable'}<span className="row-subtitle">{zone.networkLabel}</span></td>
          <td>{zone.type==='entry'?'Entry':'Instant'}</td>
          <td><MembershipStatus zone={zone}/>{zone.trouble?<span className="row-subtitle">{zone.trouble}</span>:zone.bypassed?<span className="row-subtitle">{zone.bypassUntil?'Until '+date(zone.bypassUntil,true):'Until manually cleared'}</span>:null}</td>
          <td><div className="record-actions">{manage?<>
            <button aria-label={'Edit zone '+zone.name} title={editable?'Edit shared zone settings':'Disarm every linked area before editing this zone'} disabled={!editable} onClick={()=>onEdit(zone)}>Edit</button>
            <button aria-label={'Remove zone '+zone.name} title={alarmMemory?'Reset this zone’s alarm memory before removing it':editable?'Remove this zone from every linked area':'Disarm every linked area before removing this zone'} disabled={!editable||alarmMemory} onClick={()=>onRemove(zone)}>Remove</button>
          </>:null}{control?<button aria-label={(zone.bypassed?'Clear bypass for ':'Bypass zone ')+zone.name} title={shared?'Affects every linked area':undefined} onClick={()=>onBypass(zone,!!zone.bypassed)}>{zone.bypassed?'Clear bypass':'Bypass…'}</button>:null}{!manage&&!control?<span className="muted">Read only</span>:null}</div></td>
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
  const areas=new Map(state.areas.map(area=>[area.id,area])),networks=new Map(state.networks.map(network=>[network.id,network]));
  const table=useTable(state.actions.map(action=>({...action,areaName:areas.get(action.areaId)?.name||'Removed area',networkLabel:[areas.get(action.areaId)?.name,action.kind,action.topic].join(' ')})));
  return <>
    <section className="security-section" aria-label="Security alert actions"><PanelHeading title="Alert actions" count={state.actions.length}><div className="security-table-tools"><SearchBox label="Search alert actions" table={table}/>{manage?<button className="primary" disabled={!state.areas.some(canConfigure)} onClick={onAdd}>+ Add alert action</button>:null}</div></PanelHeading><p className="security-section-intro">Send an MQTT event or an email when a zone activates in an armed area. Actions are separate from health notifications.</p>
      {table.filtered.length?<><div className="table-scroll security-table"><table><thead><tr><SortHead column="name" table={table}>Action</SortHead><SortHead column="areaName" table={table}>Area</SortHead><SortHead column="kind" table={table}>Delivery</SortHead><th>Destination</th><SortHead column="enabled" table={table}>Status</SortHead><th>Actions</th></tr></thead><tbody>{table.rows.map(action=><tr key={action.id}><td><strong>{action.name}</strong></td><td>{action.areaName}</td><td>{action.kind==='mqtt'?'MQTT event':'Email'}</td><td>{action.kind==='mqtt'?<>{networks.get(action.networkId)?.label||'Configured broker'}<span className="row-subtitle monospace">{action.topic}</span></>:'Existing SMTP settings'}</td><td><Badge tone={action.enabled?'healthy':'neutral'}>{action.enabled?'Enabled':'Disabled'}</Badge></td><td>{manage?<div className="record-actions"><button aria-label={'Edit alert action '+action.name} disabled={!canConfigure(areas.get(action.areaId))} onClick={()=>onEdit(action)}>Edit</button><button aria-label={'Remove alert action '+action.name} disabled={!canConfigure(areas.get(action.areaId))} onClick={()=>onRemove(action)}>Remove</button></div>:<span className="muted">Read only</span>}</td></tr>)}</tbody></table></div><Pagination total={table.filtered.length} {...table}/></>:<p className="security-table-empty">{table.search?'No alert actions match this search.':'No alert actions configured. New actions start disabled.'}</p>}
    </section>
    {state.deliveries.length?<section className="security-section" aria-label="Security delivery log"><PanelHeading title="Delivery log"/><div className="table-scroll security-table"><table><thead><tr><th>Time</th><th>Action</th><th>Result</th><th>Details</th></tr></thead><tbody>{state.deliveries.slice(0,20).map(delivery=><tr key={delivery.id}><td>{date(delivery.createdAt||delivery.at,true)}</td><td>{delivery.name||delivery.actionName||delivery.kind||'Security alert'}</td><td><Badge tone={['accepted','sent','delivered'].includes(delivery.status)?'healthy':['uncertain','failed'].includes(delivery.status)?'warning':'neutral'}>{delivery.status}</Badge></td><td>{delivery.error||delivery.detail||'—'}</td></tr>)}</tbody></table></div></section>:null}
  </>;
}
