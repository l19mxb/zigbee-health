import mqtt from 'mqtt';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import {TopicLog} from './topic-log.mjs';

function connectionError(error){
  if(error.code==='ECONNREFUSED')return 'Connection refused. Check the broker address and port.';
  if(['ENOTFOUND','EAI_AGAIN'].includes(error.code))return 'Broker hostname could not be resolved.';
  if(['ETIMEDOUT','ECONNRESET'].includes(error.code))return 'Broker connection timed out or closed.';
  if([4,5,134,135].includes(error.code))return 'Broker rejected authentication. Check credentials and access.';
  return 'MQTT connection failed. Check address, credentials and access.';
}
export class Collectors {
  constructor(engine,{security=null}={}){this.e=engine;this.security=security;this.clients=new Map();this.closed=false;this.logs=new TopicLog({clock:()=>engine.now()});this.stats=new Map();}
  traffic(){return Object.fromEntries(this.stats);}
  reconcile(){
    const networks=this.e.s.networks(),wanted=new Set(networks.filter(n=>n.enabled).map(n=>n.id));
    for(const [id,entry] of this.clients)if(!wanted.has(id)||entry.signature!==this.signature(this.e.s.network(id))){this.clients.delete(id);entry.client.end(true);this.e.connection(id,false);this.logs.remove(id);this.stats.delete(id);}
    if(this.e.demo||this.closed)return;
    for(const n of networks)if(n.enabled&&!this.clients.has(n.id))this.connect(n);
  }
  signature(n){return JSON.stringify([n.host,n.port,n.protocol,n.baseTopic,n.mode||'zigbee2mqtt',n.topicFilters||[],n.username,n.password,n.enabled,n.configRevision]);}
  connect(n){
    n.attemptAt=this.e.now();n.connected=false;n.bridgeState='unknown';n.inventoryAt=null;n.subscriptionStatus='pending';this.e.s.saveNetwork(n);
    const host=n.host.includes(':')?'['+n.host+']':n.host;
    const client=mqtt.connect(n.protocol+'://'+host+':'+n.port,{clientId:'zigbee-health-'+crypto.randomBytes(8).toString('hex'),clean:true,connectTimeout:8000,reconnectPeriod:10000,queueQoSZero:false,keepalive:30,...(n.username?{username:n.username,password:this.e.s.unseal(n.password)}:{})});
    client.publish=()=>{throw Error('The Zigbee Health collector is subscription-only');};
    this.clients.set(n.id,{client,signature:this.signature(n)});
    let inventoryReady=false;
    const current=()=>this.clients.get(n.id)?.client===client;
    const subscriptionStatus=value=>{if(!current())return;const latest=this.e.s.network(n.id);latest.subscriptionStatus=value;this.e.s.saveNetwork(latest);};
    const subscribe=topics=>{
      if(!topics.length){subscriptionStatus('ready');return;}
      client.subscribe(topics,{qos:0},(error,grants)=>{if(!current())return;subscriptionStatus(error||grants?.some(g=>g.qos>=128)?'denied':'ready');});
    };
    client.on('connect',()=>{
      if(!current())return;inventoryReady=false;this.e.connection(n.id,true);
      subscribe(n.mode==='mqtt'?n.topicFilters||[]:[n.baseTopic+'/bridge/devices',n.baseTopic+'/bridge/state']);
    });
    client.on('message',(topic,data,packet)=>{
      if(!current()||data.length>2*1024*1024)return;
      this.logs.add(n.id,topic,data,packet);
      const stats=this.stats.get(n.id)||{messages:0,lastMessageAt:null};stats.messages++;stats.lastMessageAt=this.e.now();this.stats.set(n.id,stats);
      if(n.mode==='mqtt')return;
      if(topic===n.baseTopic+'/bridge/devices'){
        try{const p=JSON.parse(data.toString());if(!Array.isArray(p)||p.length>4096)return;this.e.ingest(n.id,topic,p,{retain:packet.retain});if(!inventoryReady){inventoryReady=true;subscribe([n.baseTopic+'/#']);}}catch{}
      }else if(inventoryReady||topic===n.baseTopic+'/bridge/state'){
        this.e.ingest(n.id,topic,data.toString(),{retain:packet.retain});
        if(this.security&&inventoryReady)this.securityReport(n.id,topic,data,packet);
      }
    });
    client.on('error',error=>{if(current())this.e.connection(n.id,false,connectionError(error));});
    client.on('close',()=>{if(current())this.e.connection(n.id,false);});
  }
  securityReport(networkId,topic,data,packet){
    const network=this.e.s.network(networkId),prefix=network?.baseTopic+'/';
    if(!network||!topic.startsWith(prefix))return;
    const friendly=topic.slice(prefix.length);
    if(friendly.startsWith('bridge/')||friendly.endsWith('/availability')||/\/(?:set|get)(?:\/|$)/.test(friendly))return;
    const device=this.e.s.devices(networkId).find(item=>item.name===friendly);
    if(!device||device.retiredAt||device.disabled)return;
    let payload;try{payload=JSON.parse(data.toString());}catch{return;}
    if(!payload||typeof payload!=='object'||Array.isArray(payload))return;
    try{this.security.ingest(device.id,payload,{retain:packet.retain===true,dup:packet.dup===true,at:this.e.now()});}
    catch{console.error('Security report processing failed; check local service diagnostics');}
  }
  async close(){this.closed=true;await Promise.all([...this.clients.values()].map(({client})=>new Promise(resolve=>client.end(true,resolve))));this.clients.clear();}
}

export async function sendEmail(store,message){
  const c=store.get('email');if(!c?.enabled)throw Error('Email delivery is disabled');
  const transport=nodemailer.createTransport({host:c.host,port:c.port,secure:c.tlsMode==='tls',requireTLS:c.tlsMode==='starttls',ignoreTLS:c.tlsMode==='none',connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,...(c.username?{auth:{user:c.username,pass:store.unseal(c.password)}}:{})});
  try{const result=await transport.sendMail({from:c.sender,to:c.recipient,subject:message.subject,text:message.text,disableFileAccess:true,disableUrlAccess:true});if(!result.accepted?.length)throw Error('SMTP acceptance not confirmed');}finally{transport.close();}
}
