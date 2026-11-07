import mqtt from 'mqtt';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

export class Collectors {
  constructor(engine){this.e=engine;this.clients=new Map();this.closed=false;}
  reconcile(){
    const networks=this.e.s.networks(),wanted=new Set(networks.filter(n=>n.enabled).map(n=>n.id));
    for(const [id,entry] of this.clients)if(!wanted.has(id)||entry.signature!==this.signature(this.e.s.network(id))){this.clients.delete(id);entry.client.end(true);this.e.connection(id,false);}
    if(this.e.demo||this.closed)return;
    for(const n of networks)if(n.enabled&&!this.clients.has(n.id))this.connect(n);
  }
  signature(n){return JSON.stringify([n.host,n.port,n.protocol,n.baseTopic,n.username,n.password,n.enabled,n.configRevision]);}
  connect(n){
    n.attemptAt=this.e.now();n.connected=false;n.bridgeState='unknown';this.e.s.saveNetwork(n);
    const host=n.host.includes(':')?'['+n.host+']':n.host;
    const client=mqtt.connect(`${n.protocol}://${host}:${n.port}`,{clientId:'zigbee-health-'+crypto.randomBytes(8).toString('hex'),clean:true,connectTimeout:8000,reconnectPeriod:10000,queueQoSZero:false,keepalive:30,...(n.username?{username:n.username,password:this.e.s.unseal(n.password)}:{})});
    // No will, bootstrap query, control publication, or network-map scan.
    client.publish=()=>{throw Error('The Zigbee Health collector is subscription-only');};
    this.clients.set(n.id,{client,signature:this.signature(n)});
    let inventoryReady=false;
    const current=()=>this.clients.get(n.id)?.client===client;
    client.on('connect',()=>{if(!current())return;inventoryReady=false;this.e.connection(n.id,true);client.subscribe(n.baseTopic+'/bridge/devices',{qos:0});});
    client.on('message',(topic,data,packet)=>{
      if(!current()||data.length>2*1024*1024)return;
      if(topic===n.baseTopic+'/bridge/devices'){
        try{const p=JSON.parse(data.toString());if(!Array.isArray(p))return;this.e.ingest(n.id,topic,p,{retain:packet.retain});if(!inventoryReady){inventoryReady=true;client.subscribe(n.baseTopic+'/#',{qos:0});}}catch{}
      }else if(inventoryReady)this.e.ingest(n.id,topic,data.toString(),{retain:packet.retain});
    });
    client.on('error',()=>{if(current())this.e.connection(n.id,false,'MQTT connection failed. Check address, credentials and access.');});
    client.on('close',()=>{if(current())this.e.connection(n.id,false);});
  }
  async close(){this.closed=true;await Promise.all([...this.clients.values()].map(({client})=>new Promise(resolve=>client.end(true,resolve))));this.clients.clear();}
}

export async function sendEmail(store,message){
  const c=store.get('email');if(!c?.enabled)throw Error('Email delivery is disabled');
  const transport=nodemailer.createTransport({host:c.host,port:c.port,secure:c.tlsMode==='tls',requireTLS:c.tlsMode==='starttls',ignoreTLS:c.tlsMode==='none',connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,...(c.username?{auth:{user:c.username,pass:store.unseal(c.password)}}:{})});
  try{const result=await transport.sendMail({from:c.sender,to:c.recipient,subject:message.subject,text:message.text,disableFileAccess:true,disableUrlAccess:true});if(!result.accepted?.length)throw Error('SMTP acceptance not confirmed');}finally{transport.close();}
}
