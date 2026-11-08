import crypto from 'node:crypto';
import mqtt from 'mqtt';
import {sendEmail} from './collectors.mjs';

const variables=new Set(['area','zone','device','event','timestamp','incidentId','mode']);
const requireValue=(value,message)=>{if(!value)throw Error(message);};

export function validateSecurityTopic(value){
  requireValue(typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=255&&!/[\s\u0000-\u001f\u007f#+]/.test(value)&&!value.startsWith('$')&&!value.startsWith('/')&&!value.endsWith('/'),'Use a concrete security event topic without wildcards or control characters');
  requireValue(!/(?:^|\/)(?:set|get)(?:\/|$)|(?:^|\/)bridge\/request(?:\/|$)/i.test(value),'Security alerts cannot publish device commands or bridge requests');
  return value;
}

function renderString(value,context){
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g,(_match,key)=>{
    requireValue(variables.has(key),'Unknown security message placeholder');
    const result=context[key];
    requireValue(typeof result==='string'||typeof result==='number','Security message context is incomplete');
    return String(result);
  });
}

export function renderSecurityPayload(template,context){
  requireValue(typeof template==='string'&&Buffer.byteLength(template)<=8192,'Security MQTT payload must be a JSON object of up to 8192 bytes');
  let parsed;try{parsed=JSON.parse(template);}catch{throw Error('Security MQTT payload must be valid JSON');}
  requireValue(parsed&&typeof parsed==='object'&&!Array.isArray(parsed),'Security MQTT payload must be a JSON object');
  let nodes=0;
  const walk=(value,depth=0)=>{
    requireValue(depth<=8&&++nodes<=512,'Security MQTT payload is too complex');
    if(typeof value==='string')return renderString(value,context);
    if(typeof value==='number')requireValue(Number.isFinite(value),'Security MQTT payload numbers must be finite');
    if(Array.isArray(value))return value.map(item=>walk(item,depth+1));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,walk(item,depth+1)]));
    return value;
  };
  const result=JSON.stringify(walk(parsed));
  requireValue(Buffer.byteLength(result)<=16384,'Rendered security MQTT payload is too large');
  return result;
}

export function renderSecurityEmail(action,context){
  requireValue(typeof action.subject==='string'&&action.subject.trim()&&action.subject.length<=300&&!/[\r\n]/.test(action.subject),'Use a security email subject of up to 300 characters');
  requireValue(typeof action.text==='string'&&action.text.trim()&&action.text.length<=8192,'Use a security email message of up to 8192 characters');
  const subject=renderString(action.subject,context),text=renderString(action.text,context);
  requireValue(subject.length<=1000&&!/[\r\n]/.test(subject)&&text.length<=16384,'Rendered security email is too large or has an invalid subject');
  return {subject,text};
}

/** Separate one-shot publisher. The health collector remains subscription-only. */
export class SecurityActions{
  constructor(store,{demo=false,connect=mqtt.connect,mail=message=>sendEmail(store,message),timeoutMs=12000}={}){
    this.s=store;this.demo=demo;this.connect=connect;this.mail=mail;this.timeoutMs=timeoutMs;this.clients=new Set();this.closed=false;this.publications=0;this.accepted=0;
  }
  stats(){return {mqttPublications:this.publications,mqttAccepted:this.accepted};}
  async send(action,context){
    requireValue(!this.closed&&!this.demo,'Security delivery is unavailable in simulation or while stopping');
    requireValue(action&&action.enabled===true&&['mqtt','email'].includes(action.kind),'Security action is disabled or invalid');
    if(action.kind==='email'){
      requireValue(this.s.get('email')?.enabled===true,'Email delivery is disabled');
      const message=renderSecurityEmail(action,context);
      try{return await this.mail(message);}catch{throw Error('Security email delivery was not confirmed. No automatic retry.');}
    }
    const topic=validateSecurityTopic(action.topic),payload=renderSecurityPayload(action.payloadTemplate,context),network=this.s.network(action.networkId);
    requireValue(network?.enabled===true&&network.connected===true,'The selected security broker is unavailable');
    requireValue(['mqtt','mqtts'].includes(network.protocol)&&typeof network.host==='string'&&network.host.length<=253&&!/[\s/@?#\\]/.test(network.host)&&Number.isInteger(network.port)&&network.port>=1&&network.port<=65535,'The selected security broker configuration is invalid');
    const host=network.host.includes(':')?'['+network.host+']':network.host;
    return new Promise((resolve,reject)=>{
      let client,finished=false,published=false,timer;
      const finish=(error)=>{
        if(finished)return;finished=true;clearTimeout(timer);
        if(client){this.clients.delete(client);try{client.end(true);}catch{}}
        if(error)reject(Error(error));else{this.accepted++;resolve({accepted:true});}
      };
      try{
        client=this.connect(network.protocol+'://'+host+':'+network.port,{clientId:'zigbee-security-'+crypto.randomBytes(8).toString('hex'),clean:true,reconnectPeriod:0,connectTimeout:this.timeoutMs,queueQoSZero:false,resubscribe:false,keepalive:30,...(network.username?{username:network.username,password:this.s.unseal(network.password)}:{})});
        this.clients.add(client);
        timer=setTimeout(()=>finish('MQTT security delivery was not confirmed. No automatic retry.'),this.timeoutMs);
        client.once('error',()=>finish('MQTT security delivery was not confirmed. No automatic retry.'));
        client.once('close',()=>finish('MQTT security connection closed before confirmation. No automatic retry.'));
        client.on('connect',()=>{
          if(finished||published||this.closed)return;
          // Recheck current configuration immediately before this single write.
          const current=this.s.network(action.networkId);
          if(!current?.enabled||!current.connected||current.host!==network.host||current.port!==network.port||current.protocol!==network.protocol||current.username!==network.username||current.password!==network.password)return finish('Security broker configuration changed before delivery');
          published=true;this.publications++;
          try{client.publish(topic,payload,{qos:1,retain:false},error=>finish(error?'MQTT security delivery was not confirmed. No automatic retry.':null));}
          catch{finish('MQTT security delivery was not confirmed. No automatic retry.');}
        });
      }catch{finish('MQTT security delivery was not confirmed. No automatic retry.');}
    });
  }
  async close(){this.closed=true;await Promise.all([...this.clients].map(client=>new Promise(resolve=>client.end(true,resolve))));this.clients.clear();}
}
