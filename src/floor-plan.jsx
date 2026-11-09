import React,{useEffect,useMemo,useRef,useState} from 'react';
import {request} from './api.jsx';
import {Badge,Field,Icon,Modal} from './ui.jsx';
import {decodeFloorImage,importAlarmDashLayout,MAX_ALARM_DASH_LAYOUT_BYTES} from './floor-plan-import.mjs';
import {RoomDrawingControls,RoomDrawingPreview,useRoomDrawingStage} from './floor-plan-drawing.jsx';
import {roomLabelPosition,roomPolygonError,maximumRoomPoints} from './floor-plan-polygon.mjs';
import {RoomDetails,roomSummary} from './floor-plan-rooms.jsx';
import './floor-plan.css';

const maximumFloors=8;
const maximumMarkers=2048;
const maximumRooms=100;
const maximumRoomDevices=64;
const zoomLevels=[1,1.25,1.5,2,3,4];
const boardInset={width:44,height:50};
const healthLabels={healthy:'Healthy',offline:'Offline',stale:'Stale readings',issues:'Health issues',retired:'Retired',excluded:'Excluded',unknown:'Awaiting live readings'};
const clamp=value=>Math.max(0,Math.min(1,value));
const newId=()=>globalThis.crypto?.randomUUID?.()||'floor-'+Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
const samePermissions=(before,after)=>['edit','health','security'].every(key=>before?.[key]===after?.[key]);

function useFloorPlan(){
  const [plan,setPlan]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const latest=useRef(null),pending=useRef(null);
  function apply(value){
    latest.current=value;
    setPlan(value);
    setError('');
  }
  async function refresh(full=false){
    pending.current?.abort();
    const controller=new AbortController();
    pending.current=controller;
    try{
      const current=latest.current;
      if(!current||full){
        const value=await request('floor-plan',undefined,controller.signal);
        if(!controller.signal.aborted)apply(value);
        return;
      }
      const status=await request('floor-plan?status=1',undefined,controller.signal);
      if(controller.signal.aborted)return;
      if(status.revision===current.layout.revision&&samePermissions(current.permissions,status.permissions)){
        apply({...current,devices:status.devices,permissions:status.permissions});
        return;
      }
      const value=await request('floor-plan',undefined,controller.signal);
      if(!controller.signal.aborted)apply(value);
    }catch(cause){
      if(controller.signal.aborted)return;
      if(cause.status===401||cause.status===403){latest.current=null;setPlan(null);}
      setError(cause.message);
    }finally{
      if(!controller.signal.aborted)setLoading(false);
    }
  }
  useEffect(()=>{
    void refresh(true);
    const poll=setInterval(()=>{if(!document.hidden)void refresh();},5000);
    return ()=>{clearInterval(poll);pending.current?.abort();};
  },[]);
  function applySave(value){pending.current?.abort();apply(value);}
  return {plan,error,loading,refresh,applySave};
}

function deviceStatus(device,showHealth,showSecurity,unavailable){
  if(unavailable||!device)return {tone:'unknown',label:'Status unavailable',icon:'device'};
  const health=showHealth?device.health:null;
  const security=showSecurity?device.security:null;
  const zones=security?.zones||[];
  if(security?.alarm||zones.some(zone=>zone.alarm))return {tone:'alarm',label:'Security alarm',icon:'bell'};
  if(health?.status==='offline')return {tone:'alarm',label:'Offline',icon:'network'};
  if(zones.some(zone=>zone.known&&zone.active))return {tone:'open',label:'Open / active',icon:'shield'};
  if(zones.some(zone=>zone.trouble||zone.status==='trouble'||zone.status==='unknown'))return {tone:'warning',label:'Security trouble',icon:'warning'};
  if(health?.status==='issues'||health?.status==='stale')return {tone:'warning',label:healthLabels[health.status],icon:'warning'};
  if(health?.status==='retired'||health?.status==='excluded')return {tone:'unknown',label:healthLabels[health.status],icon:'device'};
  if(zones.some(zone=>zone.known))return {tone:'good',label:'Closed / normal',icon:'shield'};
  if(health?.status==='healthy')return {tone:'good',label:'Healthy',icon:'device'};
  if(health||security)return {tone:'unknown',label:healthLabels[health?.status]||'Awaiting live readings',icon:'device'};
  return {tone:'neutral',label:'Device marker',icon:'device'};
}

function openingGeometry(floor){
  const result=[];
  for(const room of floor.rooms){
    const points=room.points.map(([x,y])=>[x*floor.width,y*floor.height]);
    const winding=points.reduce((sum,[x,y],index)=>{
      const [nextX,nextY]=points[(index+1)%points.length];
      return sum+x*nextY-y*nextX;
    },0)>=0?1:-1;
    for(const opening of room.openings){
      const start=points[opening.edgeIndex],end=points[(opening.edgeIndex+1)%points.length];
      if(!start||!end)continue;
      const dx=end[0]-start[0],dy=end[1]-start[1],length=Math.hypot(dx,dy);
      if(!length)continue;
      const along=[dx/length,dy/length],inward=[-along[1]*winding,along[0]*winding];
      const half=Math.min(opening.size*floor.width/2000,length/2);
      const distance=Math.max(half,Math.min(length-half,length*opening.position));
      const center=start.map((value,index)=>value+along[index]*distance);
      const a=center.map((value,index)=>value-along[index]*half);
      const b=center.map((value,index)=>value+along[index]*half);
      const hinge=opening.swing?b:a,closed=opening.swing?a:b;
      const open=hinge.map((value,index)=>value+inward[index]*2*half);
      result.push({...opening,roomName:room.name,a,b,hinge,closed,open,inward,size:2*half,sweep:(opening.swing?-winding:winding)>0?1:0,positionOnFloor:[center[0]/floor.width,center[1]/floor.height]});
    }
  }
  return result;
}

function MapLine({from,to,className}){
  return <line x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} className={className} vectorEffect="non-scaling-stroke"/>;
}

function openingTone(device,unavailable){
  if(!device)return 'neutral';
  if(unavailable)return 'unknown';
  const contacts=new Map();
  for(const zone of device.security?.zones||[]){
    if(!/(?:^|\.)contact(?:$|_)/i.test(zone.property))continue;
    if(typeof zone.contactOpen==='boolean'||!contacts.has(zone.property))contacts.set(zone.property,zone.contactOpen);
  }
  const readings=[...contacts.values()];
  if(readings.includes(true))return 'open';
  return readings.length&&readings.every(value=>value===false)?'good':'unknown';
}

function FloorGeometry({floor,openings,openingDevices,showSecurity,unavailable,summaries,selectedRoom,onSelectRoom}){
  return <svg className="floor-geometry" viewBox={`0 0 ${floor.width} ${floor.height}`} preserveAspectRatio="none" aria-hidden="true">
    {floor.rooms.map(room=><polygon key={room.id}
      className={'floor-room'+(onSelectRoom?' selectable':'')+(room.id===selectedRoom?' selected':'')}
      data-tone={summaries.get(room.id).tone}
      points={room.points.map(([x,y])=>`${x*floor.width},${y*floor.height}`).join(' ')} vectorEffect="non-scaling-stroke"
      onClick={onSelectRoom?()=>onSelectRoom(room.id):undefined}/>)}
    {openings.map(opening=>{
      const tone=showSecurity?openingTone(openingDevices.get(opening.id),unavailable):'neutral';
      const offset=opening.inward.map(value=>value*Math.min(opening.size*.14,5));
      return <g key={opening.id} className="floor-opening" data-tone={tone}>
        <MapLine from={opening.a} to={opening.b} className="floor-opening-gap"/>
        {opening.type==='window'?<>
          <MapLine from={opening.a.map((value,index)=>value+offset[index])} to={opening.b.map((value,index)=>value+offset[index])} className="floor-opening-line"/>
          <MapLine from={opening.a.map((value,index)=>value-offset[index])} to={opening.b.map((value,index)=>value-offset[index])} className="floor-opening-line"/>
        </>:<>
          <path d={`M ${opening.closed.join(' ')} A ${opening.size} ${opening.size} 0 0 ${opening.sweep} ${opening.open.join(' ')}`} className="floor-door-sweep" vectorEffect="non-scaling-stroke"/>
          <MapLine from={opening.hinge} to={tone==='open'?opening.open:opening.closed} className="floor-opening-line"/>
        </>}
      </g>;
    })}
  </svg>;
}

function FloorMap({floor,markers,openings,devices,showHealth,showSecurity,unavailable,zoom,editing,placing,selectedPin,onPlace,onSelectPin,onMove,
  drawing,onRoomPoint,onRoomUndo,onRoomCancel,selectedRoom,onSelectRoom,hideMarkers}){
  const viewport=useRef(null),stage=useRef(null),drag=useRef(null);
  const [bounds,setBounds]=useState({width:0,height:0}),[moving,setMoving]=useState(null);
  const openingDevices=useMemo(()=>new Map(markers.filter(marker=>marker.openingId).map(marker=>[marker.openingId,devices.get(marker.deviceId)])),[markers,devices]);
  const labelPositions=useMemo(()=>new Map(floor.rooms.map(room=>[room.id,room.label??roomLabelPosition(room.points)])),[floor.rooms]);
  const summaries=useMemo(()=>new Map(floor.rooms.map(room=>[room.id,roomSummary(room,devices,{showHealth,showSecurity,unavailable})])),
    [floor.rooms,devices,showHealth,showSecurity,unavailable]);
  useEffect(()=>{
    const node=viewport.current;
    const measure=()=>setBounds(previous=>{
      const width=node.clientWidth,height=node.clientHeight;
      return previous.width===width&&previous.height===height?previous:{width,height};
    });
    measure();
    const observer=new ResizeObserver(measure);
    observer.observe(node);
    return ()=>observer.disconnect();
  },[]);
  const ratio=floor.width/floor.height;
  const width=Math.max(1,Math.min(bounds.width-boardInset.width,(bounds.height-boardInset.height)*ratio))*zoom;
  const height=width/ratio;
  function position(event){
    const rect=stage.current.getBoundingClientRect();
    return [clamp((event.clientX-rect.left)/rect.width),clamp((event.clientY-rect.top)/rect.height)];
  }
  const {cursor,stageProps}=useRoomDrawingStage({active:!!drawing,stage,position,onPoint:onRoomPoint,onUndo:onRoomUndo,onCancel:onRoomCancel});
  const selectRoom=drawing||placing?null:onSelectRoom;
  function beginDrag(event,marker){
    if(!editing||event.button!==0)return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current={id:marker.deviceId,pointer:event.pointerId,start:[event.clientX,event.clientY],original:marker.position,moved:false};
  }
  function dragPosition(event,current){
    const rect=stage.current.getBoundingClientRect();
    return [clamp(current.original[0]+(event.clientX-current.start[0])/rect.width),clamp(current.original[1]+(event.clientY-current.start[1])/rect.height)];
  }
  function moveDrag(event){
    const current=drag.current;
    if(!current||current.pointer!==event.pointerId)return;
    if(!current.moved&&Math.hypot(event.clientX-current.start[0],event.clientY-current.start[1])<4)return;
    current.moved=true;
    setMoving({id:current.id,position:dragPosition(event,current)});
  }
  function endDrag(event,commit){
    const current=drag.current;
    if(!current||current.pointer!==event.pointerId)return;
    drag.current=null;
    if(commit&&current.moved)onMove(current.id,dragPosition(event,current));
    setMoving(null);
  }
  function keyMove(event,marker){
    if(!editing)return;
    const shifts={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    const direction=shifts[event.key];
    if(!direction)return;
    event.preventDefault();
    const step=event.shiftKey?0.05:0.01;
    onMove(marker.deviceId,marker.position.map((value,index)=>clamp(value+direction[index]*step)));
  }
  return <div className="floor-viewport" ref={viewport} aria-label={`Map of ${floor.name}`}>
    <div className="floor-board" style={{minWidth:Math.max(bounds.width,width+boardInset.width),minHeight:Math.max(bounds.height,height+boardInset.height)}}>
      <div className={'floor-stage'+(floor.image?' has-image':'')+(placing?' placing':'')+(drawing?' drawing':'')}
        ref={stage} style={{width,height}} {...stageProps} onClick={event=>{
          if(drawing)onRoomPoint(position(event));
          else if(placing)onPlace(position(event));
        }}>
        {floor.image?<img className="floor-image" src={floor.image} alt="" draggable={false}/>:null}
        <FloorGeometry floor={floor} openings={openings} openingDevices={openingDevices} showSecurity={showSecurity} unavailable={unavailable}
          summaries={summaries} selectedRoom={selectedRoom} onSelectRoom={selectRoom}/>
        {!drawing&&floor.rooms.map(room=>{
          const [x,y]=labelPositions.get(room.id);
          const {tone,label,metrics}=summaries.get(room.id);
          return <button type="button" key={room.id} className="floor-room-label floor-room-live-label"
            data-tone={tone} disabled={!selectRoom} style={{left:x*100+'%',top:y*100+'%'}}
            aria-label={[room.name,label,...metrics].filter(Boolean).join(', ')}
            aria-pressed={editing?room.id===selectedRoom:undefined}
            onClick={()=>selectRoom?.(room.id)}>
            <strong className="floor-room-name">{room.name||'Unnamed room'}</strong>
            {metrics.length?<span className="floor-room-metrics">{metrics.join(' · ')}</span>:null}
          </button>;
        })}
        {drawing?<RoomDrawingPreview floor={floor} points={drawing.points} cursor={cursor}/>:null}
        {!drawing&&(!hideMarkers||editing)&&markers.map(marker=>{
          const device=devices.get(marker.deviceId),status=deviceStatus(device,showHealth,showSecurity,unavailable);
          const point=moving?.id===marker.deviceId?moving.position:marker.position;
          return <button type="button" key={marker.deviceId} className={'floor-pin'+(editing?' draggable':'')+(marker.deviceId===selectedPin?' selected':'')} data-tone={status.tone} style={{left:point[0]*100+'%',top:point[1]*100+'%'}} aria-label={`${device.name}, ${status.label}`} title={`${device.name} · ${status.label}`} onClick={event=>{event.stopPropagation();onSelectPin(marker.deviceId);}} onPointerDown={event=>beginDrag(event,marker)} onPointerMove={moveDrag} onPointerUp={event=>endDrag(event,true)} onPointerCancel={event=>endDrag(event,false)} onLostPointerCapture={event=>endDrag(event,false)} onKeyDown={event=>keyMove(event,marker)}>
            <Icon name={status.icon} size={17}/><span className="floor-pin-label">{device.name}</span>
          </button>;
        })}
      </div>
    </div>
  </div>;
}

function DeviceDetails({device,opening,unavailable,showHealth,showSecurity,onReport}){
  const status=deviceStatus(device,showHealth,showSecurity,unavailable);
  return <div className="floor-device-details">
    <div className="floor-detail-heading"><strong>{device.name}</strong><span className="floor-status-label" data-tone={status.tone}>{status.label}</span></div>
    {device.networkLabel?<p className="small muted">{device.networkLabel}</p>:null}
    {opening?<p className="small muted">{opening.roomName} · {opening.name}</p>:null}
    {unavailable?<p className="notice warning">Live device status is unavailable. Try refreshing the plan.</p>:<>
      {showHealth&&device.health?<section><h3>Health</h3><dl><dt>State</dt><dd>{healthLabels[device.health.status]||device.health.status}</dd>{device.health.battery!=null?<><dt>Battery</dt><dd>{device.health.battery}%</dd></>:null}{device.health.lqi!=null?<><dt>Link quality</dt><dd>{device.health.lqi} LQI</dd></>:null}</dl>{device.health.issues?.length?<ul>{device.health.issues.map((issue,index)=><li key={index}>{typeof issue==='string'?issue:issue.label||issue.category}</li>)}</ul>:null}</section>:null}
      {showSecurity&&device.security?.zones?.length?<section><h3>Security zones</h3>{device.security.zones.map(zone=><div className="floor-zone-detail" key={zone.id}><strong>{zone.name}</strong><p>{zone.alarm?'Alarm':zone.known?zone.active?'Open / active':'Closed / normal':zone.trouble||'Awaiting a fresh reading'}{zone.bypassed?' · Bypassed':''}</p>{zone.areas?.map(area=><p className="small muted" key={area.id}>{area.name} · {String(area.status||area.mode||'').replaceAll('_',' ')}{area.bypassed||area.homeExcluded?' · Excluded':''}</p>)}</div>)}</section>:null}
    </>}
    {onReport?<button type="button" onClick={()=>onReport(device.id)}>Open device report</button>:null}
  </div>;
}

function MapOnly({children,onClose}){
  const dialog=useRef(null);
  useEffect(()=>{dialog.current.showModal();},[]);
  return <dialog className="floor-map-only" ref={dialog} aria-label="Floor plan map only" onCancel={event=>{event.preventDefault();onClose();}}>{children}</dialog>;
}

function InventoryPicker({devices,placements,placing,onChoose}){
  const [search,setSearch]=useState(''),[limit,setLimit]=useState(60);
  const query=search.trim().toLowerCase();
  const matches=useMemo(()=>devices.filter(device=>`${device.name} ${device.networkLabel||''} ${device.id}`.toLowerCase().includes(query)),[devices,query]);
  return <section className="floor-editor-section" aria-label="Device inventory">
    <h3>Device inventory</h3>
    <label className="search compact"><Icon name="search"/><input aria-label="Search floor plan devices" placeholder="Search devices…" value={search} onChange={event=>{setSearch(event.target.value);setLimit(60);}}/></label>
    <div className="floor-inventory-list">{matches.slice(0,limit).map(device=>{
      const location=placements.get(device.id),inactive=device.placeable===false;
      return <button type="button" key={device.id} aria-pressed={placing===device.id} disabled={inactive&&!location} onClick={()=>onChoose(device.id)}><strong>{device.name}</strong><small>{location?`On ${location.name}`:inactive?'Unavailable for placement':device.networkLabel||'Ready to place'}</small></button>;
    })}</div>
    {!matches.length?<p className="small muted">{query?'No devices match this search.':'No devices are available for placement.'}</p>:null}
    {matches.length>limit?<button type="button" onClick={()=>setLimit(value=>value+60)}>Show more devices</button>:null}
  </section>;
}

function RoomDevicePicker({devices,selected,disabled,onToggle}){
  const [search,setSearch]=useState(''),[limit,setLimit]=useState(60);
  const query=search.trim().toLowerCase();
  const assigned=new Set(selected);
  const matching=devices.filter(device=>(device.placeable!==false||assigned.has(device.id))
    && `${device.name} ${device.networkLabel||''} ${device.id}`.toLowerCase().includes(query));
  const matches=[...matching.filter(device=>assigned.has(device.id)),...matching.filter(device=>!assigned.has(device.id))];
  return <>
    <label className="search compact"><Icon name="search"/><input aria-label="Search room devices" placeholder="Search room devices…" value={search}
      onChange={event=>{setSearch(event.target.value);setLimit(60);}}/></label>
    <div className="floor-room-device-list" aria-label="Devices assigned to room">
      {matches.slice(0,limit).map(device=>{
        const checked=assigned.has(device.id);
        return <label key={device.id}>
          <input type="checkbox" checked={checked} disabled={disabled||!checked&&selected.length>=maximumRoomDevices} onChange={()=>onToggle(device.id)}/>
          <span><strong>{device.name}</strong><small>{device.networkLabel}</small></span>
        </label>;
      })}
    </div>
    {!matches.length?<p className="small muted">{query?'No devices match this search.':'No devices are available to assign.'}</p>:null}
    {matches.length>limit?<button type="button" onClick={()=>setLimit(value=>value+60)}>Show more room devices</button>:null}
  </>;
}

export default function FloorPlan({onReport}){
  const {plan,error,loading,refresh,applySave}=useFloorPlan();
  const [draft,setDraft]=useState(null),[floorId,setFloorId]=useState(null),[pinId,setPinId]=useState(null),[placing,setPlacing]=useState(null);
  const [zoomIndex,setZoomIndex]=useState(0),[mapOnly,setMapOnly]=useState(false),[hideHealth,setHideHealth]=useState(false),[hideSecurity,setHideSecurity]=useState(false);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[actionError,setActionError]=useState(''),[removeId,setRemoveId]=useState(null);
  const [roomId,setRoomId]=useState(null),[drawing,setDrawing]=useState(null),[removeRoomId,setRemoveRoomId]=useState(null),[hideMarkers,setHideMarkers]=useState(false);
  const importInput=useRef(null),imageInput=useRef(null),mapOnlyButton=useRef(null),returnFocus=useRef(false),placeInstruction=useRef(null);
  const mapPanel=useRef(null),roomNameInput=useRef(null),focusRoomName=useRef(false);
  const editing=!!draft&&!!plan?.permissions.edit;
  const floors=(editing?draft.floors:plan?.layout.floors)||[];
  const floor=floors.find(item=>item.id===floorId)||floors[0];
  const room=floor?.rooms.find(item=>item.id===roomId);
  const deviceList=plan?.devices||[];
  const devices=useMemo(()=>new Map(deviceList.map(device=>[device.id,device])),[deviceList]);
  const placements=useMemo(()=>new Map(floors.flatMap(item=>item.markers.map(marker=>[marker.deviceId,item]))),[floors]);
  const openings=useMemo(()=>floor?openingGeometry(floor):[],[floor]);
  const markers=useMemo(()=>(floor?.markers||[]).filter(marker=>devices.has(marker.deviceId)),[floor,devices]);
  const marker=markers.find(item=>item.deviceId===pinId),device=marker?devices.get(marker.deviceId):null;
  const opening=openings.find(item=>item.id===marker?.openingId);
  const showHealth=!!plan?.permissions.health&&!hideHealth,showSecurity=!!plan?.permissions.security&&!hideSecurity;
  const stale=editing&&(draft.conflict||draft.revision!==plan.layout.revision);
  const drawingActive=!!drawing;
  useEffect(()=>{if(!mapOnly&&returnFocus.current){returnFocus.current=false;mapOnlyButton.current?.focus();}},[mapOnly]);
  useEffect(()=>{if(placing&&window.matchMedia('(max-width: 900px)').matches)placeInstruction.current?.scrollIntoView({block:'nearest'});},[placing]);
  useEffect(()=>{
    if(drawingActive&&window.matchMedia('(max-width: 900px)').matches)mapPanel.current?.scrollIntoView({block:'start'});
    if(!drawingActive&&focusRoomName.current){
      focusRoomName.current=false;
      roomNameInput.current?.focus();
    }
  },[drawingActive]);

  function selectFloor(id){setFloorId(id);setPinId(null);setRoomId(null);setPlacing(null);setDrawing(null);setZoomIndex(0);}
  function updateFloor(id,change){setDraft(previous=>previous?{...previous,changed:true,floors:previous.floors.map(item=>item.id===id?change(item):item)}:previous);}
  function beginEdit(){setDraft({...plan.layout,changed:false});setPinId(null);setRoomId(null);setPlacing(null);setNotice('');setActionError('');}
  function cancelEdit(){setDraft(null);setPinId(null);setRoomId(null);setDrawing(null);setPlacing(null);setNotice('');setActionError('');}
  function selectRoom(id){
    if(busy||drawing)return;
    setPinId(null);setRoomId(id||null);setPlacing(null);
  }
  function updateRoom(change){
    if(!editing||!room||busy||drawing)return;
    updateFloor(floor.id,item=>({...item,rooms:item.rooms.map(value=>value.id===room.id?change(value):value)}));
  }
  function toggleRoomDevice(id){
    updateRoom(item=>{
      const ids=item.deviceIds??[];
      return {...item,deviceIds:ids.includes(id)?ids.filter(value=>value!==id):[...ids,id]};
    });
  }
  function startDrawing(roomToRedraw=null){
    if(!editing||!floor||busy||drawing)return;
    setPinId(null);setPlacing(null);setActionError('');setNotice('');
    setDrawing({roomId:roomToRedraw?.id??null,points:[]});
  }
  function addRoomPoint(position){
    setDrawing(previous=>{
      if(!previous||previous.points.length>=maximumRoomPoints)return previous;
      const last=previous.points.at(-1);
      if(last&&Math.hypot(last[0]-position[0],last[1]-position[1])<1e-5)return previous;
      return {...previous,points:[...previous.points,position]};
    });
  }
  function undoRoomPoint(){
    setDrawing(previous=>previous?{...previous,points:previous.points.slice(0,-1)}:null);
  }
  function finishDrawing(){
    if(!editing||!drawing||!floor||busy)return;
    const {points,roomId:redrawnId}=drawing;
    if(roomPolygonError(points))return;
    const label=roomLabelPosition(points);
    if(redrawnId){
      updateFloor(floor.id,item=>({...item,rooms:item.rooms.map(value=>value.id===redrawnId?{...value,points,label}:value)}));
      setRoomId(redrawnId);
    }else{
      const names=new Set(floor.rooms.map(item=>item.name.toLowerCase()));
      let index=floor.rooms.length+1;
      while(names.has(`room ${index}`))index++;
      const next={id:newId(),name:`Room ${index}`,points,label,openings:[],deviceIds:[]};
      updateFloor(floor.id,item=>({...item,rooms:[...item.rooms,next]}));
      setRoomId(next.id);
    }
    focusRoomName.current=true;
    setDrawing(null);
    setNotice('Room outline ready. Name it and choose its devices.');
  }
  function confirmRemoveRoom(){
    const removed=floor?.rooms.find(item=>item.id===removeRoomId);
    if(!removed||busy||drawing)return;
    const openingIds=new Set(removed.openings.map(opening=>opening.id));
    updateFloor(floor.id,item=>({...item,rooms:item.rooms.filter(value=>value.id!==removed.id),markers:item.markers.map(marker=>{
      if(!openingIds.has(marker.openingId))return marker;
      const {openingId,...unlinked}=marker;
      return unlinked;
    })}));
    setRemoveRoomId(null);setRoomId(null);
  }
  function addFloor(){
    const names=new Set(floors.map(item=>item.name.toLowerCase()));
    let index=floors.length+1;
    while(names.has(`floor ${index}`))index++;
    const next={id:newId(),name:`Floor ${index}`,width:1000,height:700,image:null,rooms:[],markers:[]};
    setDraft(previous=>({...previous,changed:true,floors:[...previous.floors,next]}));
    selectFloor(next.id);
  }
  function confirmRemove(){
    setDraft(previous=>({...previous,changed:true,floors:previous.floors.filter(item=>item.id!==removeId)}));
    setRemoveId(null);
    selectFloor(null);
  }
  function chooseDevice(id){
    if(busy||drawing)return;
    const existing=placements.get(id);
    if(existing){selectFloor(existing.id);setPinId(id);return;}
    if(placements.size>=maximumMarkers||floor.markers.length>=1024){setActionError('This floor or plan has reached its marker limit. Remove a marker before placing another.');return;}
    setActionError('');
    setPinId(null);setRoomId(null);setPlacing(placing===id?null:id);
  }
  function place(position){
    if(!editing||!placing||!floor||busy||placements.has(placing)||placements.size>=maximumMarkers||floor.markers.length>=1024)return;
    updateFloor(floor.id,item=>({...item,markers:[...item.markers,{deviceId:placing,position}]}));
    setPinId(placing);setPlacing(null);
  }
  function moveMarker(id,position){
    if(!editing||!floor||busy)return;
    updateFloor(floor.id,item=>({...item,markers:item.markers.map(value=>value.deviceId===id?{...value,position}:value)}));
    setPinId(id);setPlacing(null);
  }
  function linkOpening(id){
    if(!marker||!floor||busy)return;
    const target=openings.find(value=>value.id===id);
    updateFloor(floor.id,item=>({...item,markers:item.markers.map(value=>{
      if(value.deviceId!==pinId)return value;
      if(target)return {...value,openingId:target.id,position:target.positionOnFloor};
      const {openingId,...unlinked}=value;
      return unlinked;
    })}));
  }
  async function importLayout(event){
    const file=event.target.files?.[0];event.target.value='';
    if(!file||busy||!editing||drawing)return;
    setBusy(true);setNotice('');setActionError('');
    try{
      if(file.size>MAX_ALARM_DASH_LAYOUT_BYTES)throw Error('Choose an Alarm Dash JSON file of 8 MiB or less.');
      const imported=importAlarmDashLayout(await file.text());
      if(!imported.length)throw Error('The file does not contain any floors.');
      if(floors.length+imported.length>maximumFloors)throw Error(`The plan can contain up to ${maximumFloors} floors. Remove a draft floor before importing.`);
      const existingIds=new Set(floors.map(item=>item.id));
      const fresh=imported.map(item=>{
        const id=existingIds.has(item.id)?newId():item.id;
        existingIds.add(id);
        return {...item,id,rooms:item.rooms.map(room=>({...room,id:newId(),openings:room.openings.map(opening=>({...opening,id:newId()}))}))};
      });
      setDraft(previous=>({...previous,changed:true,floors:[...previous.floors,...fresh]}));
      selectFloor(fresh[0].id);
      setNotice(`${fresh.length} ${fresh.length===1?'floor':'floors'} imported into the draft. Save to make them visible.`);
    }catch(cause){setActionError(cause.message);}
    finally{setBusy(false);}
  }
  async function uploadImage(event){
    const file=event.target.files?.[0];event.target.value='';
    if(!file||busy||!editing||!floor||drawing)return;
    const id=floor.id;
    setBusy(true);setNotice('');setActionError('');
    try{
      const background=await decodeFloorImage(file);
      updateFloor(id,item=>({...item,...background}));
      setZoomIndex(0);
      setNotice('Image added to the draft. Check marker and outline positions before saving.');
    }catch(cause){setActionError(cause.message);}
    finally{setBusy(false);}
  }
  async function save(){
    if(!editing||!draft.changed||busy||stale||drawing)return;
    if(floors.some(item=>!item.name.trim())){setActionError('Give every floor a name before saving.');return;}
    if(floors.some(item=>item.rooms.some(room=>!room.name.trim()))){setActionError('Give every room a name before saving.');return;}
    setBusy(true);setActionError('');setNotice('');
    try{
      const result=await request('floor-plan',{version:1,revision:draft.revision,floors:draft.floors.map(item=>({...item,name:item.name.trim()}))});
      applySave(result);setDraft(null);setPlacing(null);setPinId(null);setRoomId(null);setNotice('Floor plan saved.');
    }catch(cause){
      if(cause.status===409){setDraft(previous=>({...previous,conflict:true}));void refresh(true);}
      else setActionError(cause.message);
    }finally{setBusy(false);}
  }
  function closeMapOnly(){returnFocus.current=true;setMapOnly(false);}

  if(!plan)return <section className="panel floor-plan"><div className="floor-empty">{loading?<p role="status">Opening floor plan…</p>:<><p role="alert">{error||'The floor plan is unavailable.'}</p><button onClick={()=>void refresh(true)}>Try again</button></>}</div></section>;

  const display=<section className={'panel floor-plan'+(mapOnly?' map-only-content':'')} aria-label="Floor plan">
    <header className="floor-toolbar"><div className="floor-toolbar-title"><Icon name="network" size={23}/><h2>{mapOnly?'Floor Plan':'Device map'}</h2>{editing?<Badge tone="warning">Draft</Badge>:null}</div><div className="floor-toolbar-actions">
      {editing?<><button type="button" disabled={busy} onClick={cancelEdit}>Cancel</button><button type="button" className="primary" disabled={busy||!draft.changed||stale||!!drawing} onClick={()=>void save()}>{busy?'Working…':'Save floor plan'}</button></>:<>{floor||mapOnly?<button type="button" ref={mapOnlyButton} onClick={mapOnly?closeMapOnly:()=>setMapOnly(true)}>{mapOnly?'Exit map-only':'Map only'}</button>:null}{plan.permissions.edit&&!mapOnly?<button type="button" className="primary" onClick={beginEdit}>Edit floor plan</button>:null}</>}
    </div></header>
    {error?<div className="floor-message notice warning" role="alert">Live status is unavailable.<button onClick={()=>void refresh()}>Refresh</button></div>:null}
    {notice?<div className="floor-message notice" role="status">{notice}</div>:null}
    {actionError?<div className="floor-message notice critical" role="alert">{actionError}</div>:null}
    {stale?<div className="floor-message notice warning" role="status">The saved plan changed while you were editing. Your draft is retained. Cancel to open the latest plan.</div>:null}
    <div className="floor-controls"><div className="floor-floors" aria-label="Floors">{floors.map(item=><button type="button" key={item.id} disabled={busy||!!drawing} aria-pressed={item.id===floor?.id} className={item.id===floor?.id?'active':''} onClick={()=>selectFloor(item.id)}>{item.name||'Unnamed floor'}</button>)}</div>
      {floor?<div className="floor-controls-end"><div className="floor-layers" aria-label="Status layers">{plan.permissions.health?<label><input type="checkbox" checked={!hideHealth} onChange={event=>setHideHealth(!event.target.checked)}/>Health</label>:null}{plan.permissions.security?<label><input type="checkbox" checked={!hideSecurity} onChange={event=>setHideSecurity(!event.target.checked)}/>Security</label>:null}{!editing&&markers.length?<label><input type="checkbox" checked={!hideMarkers} onChange={event=>setHideMarkers(!event.target.checked)}/>Pins</label>:null}</div><div className="floor-zoom" aria-label="Map zoom"><button type="button" aria-label="Zoom out" disabled={!zoomIndex} onClick={()=>setZoomIndex(value=>value-1)}>−</button><button type="button" onClick={()=>setZoomIndex(0)} title="Fit floor to view">Fit</button><button type="button" aria-label="Zoom in" disabled={zoomIndex===zoomLevels.length-1} onClick={()=>setZoomIndex(value=>value+1)}>+</button></div></div>:null}
    </div>
    <div className={'floor-workspace'+(editing?' editing':'')}>
      <div className="floor-map-panel" ref={mapPanel}>
        {placing?<div className="floor-place-instruction" role="status" ref={placeInstruction}><span>Tap the map to place <strong>{devices.get(placing)?.name}</strong>.</span><button type="button" onClick={()=>place([.5,.5])}>Place at centre</button><button type="button" onClick={()=>setPlacing(null)}>Cancel placement</button></div>:null}
        {editing&&drawing?<RoomDrawingControls points={drawing.points} redrawing={!!drawing.roomId} onUndo={undoRoomPoint} onCancel={()=>setDrawing(null)} onFinish={finishDrawing}/>:null}
        {floor?<FloorMap key={floor.id} floor={floor} markers={markers} openings={openings} devices={devices} showHealth={showHealth} showSecurity={showSecurity} unavailable={!!error}
          zoom={zoomLevels[zoomIndex]} editing={editing&&!busy} placing={editing&&!busy?placing:null} selectedPin={pinId} onPlace={place}
          onSelectPin={id=>{setPinId(id);setRoomId(null);setPlacing(null);}} onMove={moveMarker} hideMarkers={hideMarkers}
          drawing={editing?drawing:null} onRoomPoint={addRoomPoint} onRoomUndo={undoRoomPoint} onRoomCancel={()=>setDrawing(null)}
          selectedRoom={roomId} onSelectRoom={selectRoom}/>:<div className="floor-empty"><Icon name="network" size={33}/><h3>{editing?'No floors in this draft':'No floors saved yet'}</h3><p>{editing?'Add a floor for an image, or import an Alarm Dash drawing.':plan.permissions.edit?'Edit the floor plan to add a floor or import a drawing.':'An editor can add floors and place device markers.'}</p></div>}
        {floor?<div className="floor-legend" aria-label="Marker legend"><span data-tone="good">Normal</span><span data-tone="open">Open / active</span><span data-tone="warning">Needs attention</span><span data-tone="alarm">Alarm / offline</span><span data-tone="unknown">Unknown</span><small>{markers.length} {markers.length===1?'marker':'markers'} · {Math.round(zoomLevels[zoomIndex]*100)}%</small></div>:null}
      </div>
      {editing?<aside className="floor-editor" aria-label="Floor plan editor">
        {floor?<section className="floor-editor-section" aria-label="Rooms">
          <h3>Rooms</h3>
          <button type="button" disabled={busy||!!drawing||floor.rooms.length>=maximumRooms} onClick={()=>startDrawing()}>Draw room</button>
          {floor.rooms.length?<Field label="Selected room"><select value={room?.id??''} disabled={busy||!!drawing} onChange={event=>selectRoom(event.target.value)}>
            <option value="">Choose a room…</option>{floor.rooms.map(item=><option key={item.id} value={item.id}>{item.name||'Unnamed room'}</option>)}
          </select></Field>:<p className="small muted">Draw an outline on the map, then assign the devices that describe the room.</p>}
          {room?<><Field ref={roomNameInput} label="Room name" maxLength={100} value={room.name} disabled={busy||!!drawing} onChange={event=>updateRoom(item=>({...item,name:event.target.value}))}/>
            <div className="floor-editor-buttons">
              <button type="button" disabled={busy||!!drawing||room.openings.length>0} onClick={()=>startDrawing(room)}>Redraw outline</button>
              <button type="button" disabled={busy||!!drawing} onClick={()=>setRemoveRoomId(room.id)}>Remove room…</button>
            </div>
            {room.openings.length?<p className="small muted">This outline has doors or windows attached. You can rename the room and assign its devices.</p>:null}
            <p className="small muted">{room.deviceIds?.length??0} assigned · Choose devices to show their readings on the room.</p>
            <RoomDevicePicker key={room.id} devices={deviceList} selected={room.deviceIds??[]} disabled={busy||!!drawing} onToggle={toggleRoomDevice}/>
          </>:null}
        </section>:null}
        <section className="floor-editor-section"><h3>Floors</h3><div className="floor-editor-buttons"><button type="button" disabled={busy||!!drawing||floors.length>=maximumFloors} onClick={addFloor}>Add floor</button><button type="button" disabled={busy||!!drawing||floors.length>=maximumFloors} onClick={()=>importInput.current?.click()}>Import Alarm Dash JSON…</button></div><input hidden ref={importInput} type="file" aria-label="Alarm Dash JSON file" accept=".json,application/json" onChange={importLayout}/>
          {floor?<><Field label="Floor name" maxLength={100} value={floor.name} disabled={busy||!!drawing} onChange={event=>updateFloor(floor.id,item=>({...item,name:event.target.value}))}/><div className="floor-editor-buttons"><button type="button" disabled={busy||!!drawing} onClick={()=>imageInput.current?.click()}>{floor.image?'Replace image…':'Upload floor image…'}</button><button type="button" disabled={busy||!!drawing} onClick={()=>setRemoveId(floor.id)}>Remove floor…</button></div><input hidden ref={imageInput} type="file" aria-label="Floor plan image file" accept="image/png,image/jpeg,image/webp" onChange={uploadImage}/><p className="small muted">PNG, JPG or WebP. Your changes are kept in this draft until Save.</p></>:null}
        </section>
        {floor&&!drawing?<><InventoryPicker devices={deviceList} placements={placements} placing={placing} onChoose={chooseDevice}/><section className="floor-editor-section"><h3>Selected marker</h3>{marker&&device?<><p><strong>{device.name}</strong></p><p className="small muted">Drag the marker to move it. Arrow keys move a focused marker.</p>{openings.length?<Field label="Linked door or window"><select value={marker.openingId||''} disabled={busy} onChange={event=>linkOpening(event.target.value)}><option value="">No opening linked</option>{openings.map(item=><option key={item.id} value={item.id} disabled={floor.markers.some(value=>value.deviceId!==pinId&&value.openingId===item.id)}>{item.roomName} · {item.name}</option>)}</select></Field>:null}<button type="button" disabled={busy} onClick={()=>{updateFloor(floor.id,item=>({...item,markers:item.markers.filter(value=>value.deviceId!==pinId)}));setPinId(null);}}>Remove marker</button></>:<p className="small muted">Choose an inventory device to place it, or select a marker on the map.</p>}</section></>:null}
      </aside>:null}
    </div>
    {!editing&&device?<Modal title="Device details" onClose={()=>setPinId(null)}><DeviceDetails device={device} opening={opening} unavailable={!!error} showHealth={showHealth} showSecurity={showSecurity} onReport={onReport?id=>{setPinId(null);setMapOnly(false);onReport(id);}:undefined}/></Modal>:null}
    {!editing&&room?<Modal title={room.name} onClose={()=>setRoomId(null)}><RoomDetails room={room} devices={devices} unavailable={!!error} showHealth={showHealth} showSecurity={showSecurity}/></Modal>:null}
    {removeId?<Modal title="Remove floor from draft" onClose={()=>setRemoveId(null)}><p>Remove this floor and its markers from the draft. Saving applies the change.</p><div className="form-actions"><button type="button" onClick={()=>setRemoveId(null)}>Keep floor</button><button type="button" className="primary" onClick={confirmRemove}>Remove floor</button></div></Modal>:null}
    {removeRoomId?<Modal title="Remove room from draft" onClose={()=>setRemoveRoomId(null)}><p>Remove this outline and its device assignments. Any linked door or window markers become standalone pins.</p><div className="form-actions"><button type="button" onClick={()=>setRemoveRoomId(null)}>Keep room</button><button type="button" className="primary" onClick={confirmRemoveRoom}>Remove room</button></div></Modal>:null}
  </section>;
  return mapOnly?<MapOnly onClose={closeMapOnly}>{display}</MapOnly>:display;
}
