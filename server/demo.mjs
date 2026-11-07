import {uid,deviceId} from './engine.mjs';

export function seedDemo(e){
  if(e.s.get('demoSeeded'))return;
  const now=e.now(),east='demo-east',west='demo-west';
  for(const [id,label] of [[east,'East network'],[west,'West network']])e.s.saveNetwork({id,label,host:'simulation.invalid',port:1883,protocol:'mqtt',baseTopic:'zigbee2mqtt',enabled:true,username:'',password:'',connected:true,connectedAt:now-8*86400000,attemptAt:now-8*86400000,bridgeState:'online',bridgeAt:now,receivedAt:now,error:null});
  const names=['Hallway motion','Front door contact','Garage sensor','Living room motion','Back door contact','Kitchen motion','Study sensor'];
  const rooms=['Bedroom','Landing','Guest room','Dining room','Laundry','Workshop','Porch','Upstairs','Garden room','Bathroom'];
  const devices=Array.from({length:64},(_,i)=>({ieee_address:'0x'+(0x0000000000000000n+BigInt(i)).toString(16).padStart(16,'0'),friendly_name:names[i]||rooms[(i-7)%rooms.length]+' '+(Math.floor((i-7)/rooms.length)+1),type:'EndDevice',power_source:'Battery',definition:{model:i===2?'TH-Sensor':'Contact / motion',vendor:'Simulation'}}));
  e.ingest(east,'zigbee2mqtt/bridge/devices',devices.filter((_,i)=>i%2===0));e.ingest(west,'zigbee2mqtt/bridge/devices',devices.filter((_,i)=>i%2!==0));
  const specialNetworks=[east,west,east,west];
  for(let i=0;i<devices.length;i++){
    const net=i%2===0?east:west,id=deviceId(net,devices[i].ieee_address),d=e.s.device(id);
    d.lastLiveAt=now-(i===0?18*60000:i===1?65*60000:30000+i*1000);d.lastReceivedAt=d.lastLiveAt;d.battery=i===1?12:i===2?78:i===3?66:79+(i%20);d.lqi=i===2?38:120+(i%70);d.availability=i===0?'offline':'online';d.inventoryPresent=true;d.room=i<4?['Hallway','Entry','Garage','Living room'][i]:rooms[i%rooms.length];if(i===1)d.overrides={batteryTimeoutMin:30};e.s.saveDevice(d);
    const stmt=e.s.db.prepare('INSERT OR IGNORE INTO samples VALUES(?,?,?,?,?,?,?,?)');
    e.s.transaction(()=>{for(let h=0;h<168;h++){const bucket=Math.floor((now-h*3600000)/300000)*300000,lqi=Math.max(0,Math.min(255,d.lqi+Math.sin(h*0.4+i)*12)),battery=Math.min(100,d.battery+h*0.04);stmt.run(id,bucket,lqi,1,Math.max(0,lqi-6),Math.min(255,lqi+4),battery,3);}});
  }
  const actual=e.s.devices(),byName=name=>actual.find(d=>d.name===name);
  for(const [name,category,priority,minutes,ack,description] of [
    ['Hallway motion','offline','critical',18,false,'Hallway motion is reported offline by Zigbee2MQTT'],
    ['Front door contact','battery','warning',44,false,'Front door contact: battery 12%'],
    ['Garage sensor','signal','warning',88,true,'Garage sensor: link quality 38 LQI'],
    ['Living room motion','flapping','warning',159,false,'Living room motion: 3 offline episodes in 24 hours'],
    ['Front door contact','stale','warning',9,false,'Front door contact has exceeded its expected reporting interval']]){
    const d=byName(name),id=uid(),at=now-minutes*60000;e.s.run('INSERT INTO incidents(id,device_id,network_id,category,priority,opened_at,ack_at,ack_by,description) VALUES(?,?,?,?,?,?,?,?,?)',id,d.id,d.networkId,category,priority,at,ack?at+300000:null,ack?'Local operator':null,description);e.s.event('alarm_raised',description,{deviceId:d.id,networkId:d.networkId,incidentId:id,at});e.s.run('INSERT INTO conditions VALUES(?,?,?,NULL,1)',d.id,category,at);
  }
  const living=byName('Living room motion');for(let i=0;i<3;i++){const at=now-(i+3)*3600000,id=uid();e.s.run("INSERT INTO incidents(id,device_id,network_id,category,priority,opened_at,restored_at,processed_at,description) VALUES(?,?,?,'offline','critical',?,?,?,'Simulated offline episode')",id,living.id,living.networkId,at,at+180000,at+240000);e.s.event('alarm_restored','Simulated device recovery',{deviceId:living.id,networkId:living.networkId,incidentId:id,at:at+180000});}
  e.s.set('demoSeeded',true);
}

export function pulseDemo(e){const now=e.now();for(const n of e.s.networks()){if(n.enabled){n.connected=true;n.bridgeState='online';n.receivedAt=now;e.s.saveNetwork(n);}}for(const d of e.s.devices())if(!d.retiredAt&&!['Hallway motion','Front door contact'].includes(d.name)){d.lastLiveAt=now;d.lastReceivedAt=now;e.s.saveDevice(d);}}
