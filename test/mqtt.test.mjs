import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import mqtt from 'mqtt';
import aedes from 'aedes';
import {Store,defaults} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {Collectors} from '../server/collectors.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn){const start=Date.now();while(!fn()){if(Date.now()-start>8000)throw Error('Local MQTT expectation timed out');await sleep(30);}}
async function broker(){const instance=aedes(),server=net.createServer(instance.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port,client=mqtt.connect('mqtt://127.0.0.1:'+port,{reconnectPeriod:0});await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});return {instance,server,port,client,async close(){await new Promise(r=>client.end(true,r));await new Promise(r=>instance.close(r));await new Promise(r=>server.close(r));}};}
function publish(client,topic,value,retain=false){return new Promise((resolve,reject)=>client.publish(topic,JSON.stringify(value),{retain,qos:1},e=>e?reject(e):resolve()));}

test('two actual loopback MQTT brokers: independent discovery, rename, retained guards and zero collector publications',async()=>{
  const [a,b]=await Promise.all([broker(),broker()]);const s=new Store(),e=new Engine(s),manager=new Collectors(e);s.set('thresholds',{...defaults,faultDelaySec:0,recoveryDelaySec:0});let publications=0;
  const inventory=[{ieee_address:'0x0000000000000001',friendly_name:'Same name',type:'EndDevice',power_source:'Battery',definition:{model:'Test'}}];
  try{
    for(const [id,x]of [['a',a],['b',b]]){
      x.instance.on('publish',(packet,client)=>{if(client?.id.startsWith('zigbee-health-'))publications++;});
      await publish(x.client,'zigbee2mqtt/bridge/devices',inventory,true);await publish(x.client,'zigbee2mqtt/bridge/state',{state:'online'},true);await publish(x.client,'zigbee2mqtt/Same name',{battery:1,linkquality:1},true);
      s.saveNetwork({id,label:id,host:'127.0.0.1',port:x.port,protocol:'mqtt',baseTopic:'zigbee2mqtt',enabled:true,connected:false,attemptAt:Date.now()});
    }
    manager.reconcile();await waitFor(()=>s.devices().length===2&&s.networks().every(n=>n.bridgeState==='online'));assert.ok(s.devices().every(d=>!d.lastLiveAt));
    await publish(a.client,'zigbee2mqtt/Same name',{battery:80,linkquality:150});await publish(b.client,'zigbee2mqtt/Same name',{battery:60,linkquality:100});await waitFor(()=>s.devices().every(d=>d.lastLiveAt));e.tick();assert.equal(e.snapshot().devices.filter(d=>d.status==='healthy').length,2);
    await publish(a.client,'zigbee2mqtt/bridge/devices',[{...inventory[0],friendly_name:'Renamed'}],true);await waitFor(()=>s.devices('a')[0]?.name==='Renamed');assert.equal(s.devices('b')[0].name,'Same name');
    const aConfig=s.network('a');aConfig.configRevision=1;s.saveNetwork(aConfig);manager.reconcile();await waitFor(()=>s.network('a').connected===true&&s.network('a').bridgeState==='online');await sleep(80);assert.equal(s.network('b').connected,true);
    assert.equal(publications,0);assert.throws(()=>manager.clients.get('a').client.publish('zigbee2mqtt/anything/set','ON'),/subscription-only/);
  }finally{await manager.close();s.close();await Promise.all([a.close(),b.close()]);}
});
