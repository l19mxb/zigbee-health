import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import mqtt from 'mqtt';
import aedes from 'aedes';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {Collectors} from '../server/collectors.mjs';
import {SecurityEngine} from '../server/security.mjs';

async function waitFor(fn){const start=Date.now();while(!fn()){if(Date.now()-start>8000)throw Error('Synthetic security MQTT expectation timed out');await new Promise(resolve=>setTimeout(resolve,20));}}
function publish(client,topic,value,retain=false){return new Promise((resolve,reject)=>client.publish(topic,JSON.stringify(value),{retain,qos:1},error=>error?reject(error):resolve()));}

test('actual subscription collector routes only fresh stable-device telemetry into armed Security without becoming a publisher',async()=>{
  const broker=aedes(),server=net.createServer(broker.handle);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=mqtt.connect('mqtt://127.0.0.1:'+server.address().port,{reconnectPeriod:0});await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});
  const s=new Store(),health=new Engine(s),security=new SecurityEngine(s),collectors=new Collectors(health,{security});let collectorWrites=0;
  const inventory=name=>[{ieee_address:'0x0000000000000001',friendly_name:name,type:'EndDevice',power_source:'Battery'}];
  broker.on('publish',(_packet,source)=>{if(source?.id.startsWith('zigbee-health-'))collectorWrites++;});
  try{
    await publish(client,'zigbee2mqtt/bridge/devices',inventory('Door contact'),true);await publish(client,'zigbee2mqtt/bridge/state',{state:'online'},true);await publish(client,'zigbee2mqtt/Door contact',{contact:false},true);
    s.saveNetwork({id:'zigbee',label:'Synthetic Zigbee broker',host:'127.0.0.1',port:server.address().port,protocol:'mqtt',baseTopic:'zigbee2mqtt',enabled:true,connected:false});collectors.reconcile();
    await waitFor(()=>s.devices().length===1&&s.network('zigbee').bridgeState==='online');
    const device=s.devices()[0],area=security.saveArea({name:'Home',entryDelaySec:0,exitDelaySec:0},'fixture');security.saveZone({areaId:area.id,deviceId:device.id,name:'Door',property:'contact',value:false},'fixture');
    assert.equal(security.state().zones[0].known,false);assert.equal(security.activeIncidents().length,0);
    await publish(client,'zigbee2mqtt/Door contact',{contact:true});await waitFor(()=>security.state().zones[0].known);security.command(area.id,'arm_away',{},'fixture');
    collectors.securityReport('zigbee','zigbee2mqtt/Door contact',Buffer.from('{"contact":false}'),{dup:true,retain:false});assert.equal(security.activeIncidents().length,0);
    for(const topic of ['zigbee2mqtt/Door contact/set','zigbee2mqtt/Door contact/get','zigbee2mqtt/Door contact/availability','zigbee2mqtt/bridge/event'])collectors.securityReport('zigbee',topic,Buffer.from('{"contact":false}'),{retain:false,dup:false});
    assert.equal(security.activeIncidents().length,0);
    await publish(client,'zigbee2mqtt/Door contact',{contact:false});await waitFor(()=>security.activeIncidents().length===1);assert.equal(security.activeIncidents()[0].deviceId,device.id);
    await publish(client,'zigbee2mqtt/bridge/devices',inventory('Renamed door'),true);await waitFor(()=>s.device(device.id).name==='Renamed door');
    await publish(client,'zigbee2mqtt/Renamed door',{contact:true});await waitFor(()=>security.state().zones[0].active===false);assert.equal(security.state().zones[0].deviceId,device.id);assert.equal(security.state().zones[0].deviceName,'Renamed door');
    assert.equal(collectorWrites,0);assert.throws(()=>collectors.clients.get('zigbee').client.publish('security/alerts','MUST NOT SEND'),/subscription-only/);
  }finally{await collectors.close();s.close();await new Promise(resolve=>client.end(true,resolve));await new Promise(resolve=>broker.close(resolve));await new Promise(resolve=>server.close(resolve));}
});
