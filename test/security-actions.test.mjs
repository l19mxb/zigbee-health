import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import net from 'node:net';
import aedes from 'aedes';
import {Store} from '../server/store.mjs';
import {SecurityActions,validateSecurityTopic,renderSecurityPayload,renderSecurityEmail} from '../server/security-actions.mjs';

const context={area:'Ground floor',zone:'Front door',device:'Synthetic contact',event:'intrusion',timestamp:'2026-11-08T12:30:00.000Z',incidentId:'synthetic-incident',mode:'away'};
const action={id:'action-one',areaId:'area-one',name:'Security event',kind:'mqtt',enabled:true,networkId:'broker-one',topic:'security/alerts',payloadTemplate:'{"event":"{{event}}","area":"{{area}}","zone":"{{zone}}","timestamp":"{{timestamp}}","incidentId":"{{incidentId}}","nested":{"literal":3}}'};
function store(){const s=new Store();s.saveNetwork({id:'broker-one',label:'Synthetic broker',enabled:true,connected:true,protocol:'mqtt',host:'127.0.0.1',port:1883,username:'fixture-user',password:s.seal('fixture-secret')});return s;}
function mockConnection(run){return (_url,options)=>{const client=new EventEmitter();client.options=options;client.end=(_force,done)=>{done?.();};client.publish=(...args)=>run(client,...args);queueMicrotask(()=>client.emit('connect'));return client;};}

test('security topics accept event topics but reject device commands, bridge requests and wildcard/system destinations',()=>{
  for(const topic of ['security/alerts','building/events/armed-area','outside/alarm-event'])assert.equal(validateSecurityTopic(topic),topic);
  for(const topic of ['','security/#','security/+','/security/events','security/events/','$SYS/events','zigbee2mqtt/Door/set','zigbee2mqtt/Door/get/state','zigbee2mqtt/bridge/request/permit_join','security\u0000events','security events','x'.repeat(256)])assert.throws(()=>validateSecurityTopic(topic));
});

test('JSON message rendering escapes context as data and rejects executable/unknown or oversized templates',()=>{
  const rendered=JSON.parse(renderSecurityPayload(action.payloadTemplate,{...context,area:'Kitchen ","injected":true,"x":"'}));
  assert.equal(rendered.area,'Kitchen ","injected":true,"x":"');assert.equal(rendered.injected,undefined);assert.equal(rendered.nested.literal,3);
  assert.deepEqual(JSON.parse(renderSecurityPayload('{"__proto__":{"polluted":true},"array":["{{mode}}",false,null]}',context)).array,['away',false,null]);
  assert.equal({}.polluted,undefined);
  for(const template of ['[]','null','{"x":"{{constructor}}"}','{"x":"{{process.exit()}}"}','{"value":1e999}','{"nested":[-1e999]}','x'.repeat(8193)])assert.throws(()=>renderSecurityPayload(template,context));
  assert.throws(()=>renderSecurityPayload('{"x":"{{area}}"}',{...context,area:'x'.repeat(17000)}),/too large/);
});

test('email uses the existing configured destination and refuses injected subject headers',()=>{
  assert.deepEqual(renderSecurityEmail({subject:'[Security] {{area}}',text:'{{zone}} at {{timestamp}}'},context),{subject:'[Security] Ground floor',text:'Front door at 2026-11-08T12:30:00.000Z'});
  assert.throws(()=>renderSecurityEmail({subject:'Bad\r\nBcc: hidden@example.test',text:'Message'},context));
  assert.throws(()=>renderSecurityEmail({subject:'{{area}}',text:'Message'},{...context,area:'Bad\nSubject'}));
});

test('disabled actions, simulation and unavailable brokers perform no connections or email sends',async()=>{
  const s=store();let calls=0;const fake=()=>{calls++;throw Error('MUST NOT CONNECT');};
  const live=new SecurityActions(s,{connect:fake,mail:fake}),demo=new SecurityActions(s,{demo:true,connect:fake,mail:fake});
  try{
    await assert.rejects(()=>live.send({...action,enabled:false},context),/disabled/);
    await assert.rejects(()=>demo.send(action,context),/simulation/);
    s.saveNetwork({...s.network('broker-one'),connected:false});await assert.rejects(()=>live.send(action,context),/unavailable/);
    await assert.rejects(()=>live.send({...action,kind:'email',subject:'Alert',text:'Message'},context),/disabled/);
    assert.equal(calls,0);assert.deepEqual(live.stats(),{mqttPublications:0,mqttAccepted:0});
  }finally{await live.close();await demo.close();s.close();}
});

test('one-shot MQTT confirms one non-retained QoS1 event against an isolated loopback broker',async()=>{
  const broker=aedes(),server=net.createServer(broker.handle),seen=[];await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  broker.on('publish',(packet,client)=>{if(client?.id.startsWith('zigbee-security-'))seen.push({topic:packet.topic,payload:packet.payload.toString(),retain:packet.retain,qos:packet.qos});});
  const s=store();s.saveNetwork({...s.network('broker-one'),port:server.address().port});const transport=new SecurityActions(s);
  try{
    await transport.send(action,context);assert.equal(seen.length,1);assert.equal(seen[0].topic,'security/alerts');assert.equal(seen[0].retain,false);assert.equal(seen[0].qos,1);assert.equal(JSON.parse(seen[0].payload).incidentId,context.incidentId);assert.deepEqual(transport.stats(),{mqttPublications:1,mqttAccepted:1});assert.equal(transport.clients.size,0);
  }finally{await transport.close();s.close();await new Promise(resolve=>broker.close(resolve));await new Promise(resolve=>server.close(resolve));}
});

test('duplicate connect events and a publication failure never queue or retry a second write',async()=>{
  const s=store();let writes=0,options;
  const transport=new SecurityActions(s,{connect:mockConnection((client,_topic,_payload,_publishOptions,callback)=>{options=client.options;writes++;client.emit('connect');callback(Error('private broker password should never appear'));}),timeoutMs:50});
  try{await assert.rejects(()=>transport.send(action,context),error=>!error.message.includes('password')&&/No automatic retry/.test(error.message));assert.equal(writes,1);assert.equal(options.reconnectPeriod,0);assert.equal(options.queueQoSZero,false);assert.deepEqual(transport.stats(),{mqttPublications:1,mqttAccepted:0});}finally{await transport.close();s.close();}
});

test('a changed broker configuration before connection prevents the publication',async()=>{
  const s=store();let writes=0;
  const transport=new SecurityActions(s,{connect:(_url,_options)=>{const client=new EventEmitter();client.end=()=>{};client.publish=()=>writes++;queueMicrotask(()=>{s.saveNetwork({...s.network('broker-one'),password:s.seal('changed-fixture-secret')});client.emit('connect');});return client;}});
  try{await assert.rejects(()=>transport.send(action,context),/configuration changed/);assert.equal(writes,0);}finally{await transport.close();s.close();}
});

test('a synchronous MQTT client write failure is contained and remains a single consumed attempt',async()=>{
  const s=store();let writes=0;const transport=new SecurityActions(s,{connect:mockConnection(()=>{writes++;throw Error('sensitive client failure');}),timeoutMs:50});
  try{await assert.rejects(()=>transport.send(action,context),error=>/No automatic retry/.test(error.message)&&!error.message.includes('sensitive'));assert.equal(writes,1);assert.deepEqual(transport.stats(),{mqttPublications:1,mqttAccepted:0});assert.equal(transport.clients.size,0);}finally{await transport.close();s.close();}
});

test('unconfirmed MQTT is bounded, generic and not retried; confirmed email uses safe rendered text',async()=>{
  const s=store();let writes=0,sent=[];const transport=new SecurityActions(s,{connect:mockConnection(()=>{writes++;}),timeoutMs:20,mail:async value=>sent.push(value)});
  try{
    await assert.rejects(()=>transport.send(action,context),/No automatic retry/);assert.equal(writes,1);
    s.set('email',{enabled:true});await transport.send({kind:'email',enabled:true,subject:'[Security] {{area}}',text:'{{device}} activated'},context);assert.deepEqual(sent,[{subject:'[Security] Ground floor',text:'Synthetic contact activated'}]);
    const failing=new SecurityActions(s,{mail:async()=>{throw Error('sensitive SMTP host information');}});try{await assert.rejects(()=>failing.send({kind:'email',enabled:true,subject:'Alert',text:'Message'},context),error=>/No automatic retry/.test(error.message)&&!error.message.includes('sensitive'));}finally{await failing.close();}
  }finally{await transport.close();s.close();}
});

test('security email reaches an isolated SMTP sink using only the existing configured envelope',async()=>{
  const s=store(),sockets=new Set(),envelope=[];let accepted=0,content='';
  const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.write('220 localhost security fixture SMTP\r\n');let buffer='',data=false;socket.on('data',chunk=>{buffer+=chunk.toString();let at;while((at=buffer.indexOf('\r\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+2);if(data){if(line==='.'){data=false;accepted++;socket.write('250 accepted locally\r\n');}else content+=line+'\n';continue;}if(/^EHLO|^HELO/.test(line))socket.write('250 localhost\r\n');else if(/^MAIL FROM|^RCPT TO/.test(line)){envelope.push(line);socket.write('250 OK\r\n');}else if(line==='DATA'){data=true;socket.write('354 End with dot\r\n');}else if(line==='QUIT')socket.end('221 Bye\r\n');else socket.write('250 OK\r\n');}});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  s.set('email',{enabled:true,host:'127.0.0.1',port:server.address().port,tlsMode:'none',sender:'sender@example.test',recipient:'sink@example.test',username:''});
  const transport=new SecurityActions(s);try{
    await transport.send({kind:'email',enabled:true,subject:'[Security] {{area}}',text:'{{zone}} activated. Incident: {{incidentId}}',recipient:'must-not-be-used@example.test'},context);
    assert.equal(accepted,1);assert.match(content,/Subject: \[Security\] Ground floor/);assert.match(content,/Front door activated/);assert.ok(envelope.some(line=>line.includes('<sink@example.test>')));assert.equal(envelope.some(line=>line.includes('must-not-be-used')),false);assert.equal(transport.stats().mqttPublications,0);
  }finally{await transport.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));s.close();}
});
