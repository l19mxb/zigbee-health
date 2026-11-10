import net from 'node:net';
import {KeypadError} from './keypad.mjs';

const defaults=()=>({enabled:false,origin:'',cidrs:[],allAreas:true,areaIds:[],allowBypassArming:false});
const requireValue=(ok,message,status=400)=>{if(!ok)throw new KeypadError(message,status);};
const ipv4=value=>net.isIP(value)===4?value.split('.').reduce((total,part)=>(total*256+Number(part))>>>0,0):null;
const mask=bits=>bits===0?0:(0xffffffff<<(32-bits))>>>0;
const blocks=[['10.0.0.0',8],['172.16.0.0',12],['192.168.0.0',16],['127.0.0.0',8]].map(([address,bits])=>({network:ipv4(address),bits}));
const privateAddress=value=>{const address=ipv4(value);return address!==null&&blocks.some(block=>((address&mask(block.bits))>>>0)===block.network);};
const addressText=value=>[24,16,8,0].map(shift=>(value>>>shift)&255).join('.');
const proxyHeader=name=>name==='forwarded'||name==='via'||name==='x-real-ip'||name==='forwarded-for'||/^(?:x-?forwarded|cf|x-envoy-)/.test(name)||['x-client-ip','true-client-ip','x-cluster-client-ip','fastly-client-ip','x-original-host','x-original-url','x-rewrite-url','x-proxyuser-ip'].includes(name);

export function kioskPeer(address){
  if(typeof address!=='string')return null;
  if(address.startsWith('::ffff:'))address=address.slice(7);
  return privateAddress(address)?address:null;
}

export function kioskCidr(value){
  requireValue(typeof value==='string'&&/^\d+\.\d+\.\d+\.\d+\/(?:[0-9]|[12][0-9]|3[0-2])$/.test(value),'Use a private IPv4 or loopback CIDR');
  const [literal,prefix]=value.split('/'),address=ipv4(literal),bits=Number(prefix),network=address===null?null:(address&mask(bits))>>>0;
  requireValue(address!==null&&blocks.some(block=>bits>=block.bits&&((network&mask(block.bits))>>>0)===block.network),'Use a private IPv4 or loopback CIDR');
  return addressText(network)+'/'+bits;
}

/** Explicitly enabled direct-LAN surface. No session or account is created. */
export class Kiosk{
  constructor(keypad,{recognizesOrigin=()=>false,clock=()=>Date.now()}={}){this.keypad=keypad;this.s=keypad.s;this.security=keypad.security;this.accounts=keypad.accounts;this.recognizesOrigin=recognizesOrigin;this.clock=clock;this.rates=new Map();this.generation=0;}
  validate(input){
    requireValue(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(key=>['enabled','origin','cidrs','allAreas','areaIds','allowBypassArming'].includes(key)),'Provide kiosk settings');
    requireValue(typeof input.enabled==='boolean'&&typeof input.allAreas==='boolean','Kiosk enabled and all areas must be on or off');
    requireValue(input.allowBypassArming===undefined||typeof input.allowBypassArming==='boolean','Bypass arming must be on or off');
    requireValue(typeof input.origin==='string'&&input.origin.length<=100,'Use an exact local HTTP or HTTPS origin');
    if(input.origin){let url;try{url=new URL(input.origin);}catch{throw new KeypadError('Use an exact local HTTP or HTTPS origin');}
      requireValue(['http:','https:'].includes(url.protocol)&&privateAddress(url.hostname)&&url.origin===input.origin&&url.pathname==='/'&&!url.search&&!url.hash&&!url.username&&!url.password,'Use an exact private IPv4 or loopback HTTP or HTTPS origin');
      requireValue(this.recognizesOrigin(input.origin),'The kiosk origin must already be an allowed app host');
    }
    requireValue(Array.isArray(input.cidrs)&&input.cidrs.length<=32,'Choose at most 32 trusted private CIDRs');const cidrs=input.cidrs.map(kioskCidr);requireValue(new Set(cidrs).size===cidrs.length,'Choose unique trusted CIDRs');
    const areaIds=this.keypad.validateAreas(input.areaIds);requireValue(!input.enabled||input.origin&&cidrs.length&&(input.allAreas||areaIds.length),'Choose an origin, trusted CIDRs and available areas before enabling the kiosk');
    return {enabled:input.enabled,origin:input.origin,cidrs,allAreas:input.allAreas,areaIds,allowBypassArming:input.allowBypassArming===true};
  }
  config(){const stored=this.s.get('kioskSettings');if(!stored)return defaults();try{return this.validate(stored);}catch{return defaults();}}
  administrator(user){const current=user&&this.accounts.get(user.id);requireValue(current?.enabled&&current.role==='admin','Administrator access is required',403);return current;}
  settings(user){this.administrator(user);return {...this.config(),areas:this.security.areas().map(({id,name})=>({id,name}))};}
  configure(user,input){const admin=this.administrator(user),config=this.validate(input);this.s.transaction(()=>{this.s.set('kioskSettings',config);this.security.event('kiosk_settings_changed','Local kiosk settings updated',{actor:admin.username});});this.generation++;for(const [token,preview] of this.keypad.armPreviews)if(preview.binding.startsWith('kiosk:'))this.keypad.armPreviews.delete(token);return this.settings(admin);}
  binding(config){return 'kiosk:'+this.keypad.mac('kiosk-config\0'+this.generation+'\0'+JSON.stringify(config));}
  scope(config=this.config()){return config.allAreas?this.security.areas().map(area=>area.id):config.areaIds.filter(id=>!!this.security.area(id));}
  gate(req,{post=false,rate=false}={}){
    const config=this.config(),peer=kioskPeer(req.socket.remoteAddress),host=req.headers.host,protocol=req.socket.encrypted?'https:':'http:';
    requireValue(config.enabled&&peer&&typeof host==='string'&&protocol+'//'+host===config.origin,'Local kiosk access is unavailable',403);
    requireValue(!Object.keys(req.headers).some(name=>proxyHeader(name.toLowerCase())),'Proxied kiosk requests are not permitted',403);
    const raw=req.rawHeaders||[];requireValue(raw.filter((_,index)=>index%2===0&&raw[index].toLowerCase()==='host').length<=1,'Invalid kiosk host',403);
    requireValue(config.cidrs.some(cidr=>{const [network,bits]=cidr.split('/');return ((ipv4(peer)&mask(Number(bits)))>>>0)===ipv4(network); }),'Local kiosk access is unavailable',403);
    requireValue(req.headers.origin===undefined||req.headers.origin===config.origin,'A matching kiosk origin is required',403);
    if(post){requireValue(req.headers.origin===config.origin,'A matching kiosk origin is required',403);requireValue(typeof req.headers['content-type']==='string'&&/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']),'Kiosk commands require application/json',415);requireValue(req.headers['sec-fetch-site']===undefined||req.headers['sec-fetch-site']==='same-origin','Cross-site kiosk commands are not permitted',403);}
    if(rate)this.rate(peer,post?'command':'read');return config;
  }
  rate(peer,kind){
    const now=this.clock();for(const [key,value] of this.rates)if(value.until<=now)this.rates.delete(key);const key=kind+':'+peer,value=this.rates.get(key)||{count:0,until:now+60000};
    requireValue(this.rates.has(key)||this.rates.size<1024,'Too many kiosk requests. Try again later.',429);if(value.count>=(kind==='command'?30:120))throw new KeypadError('Too many kiosk requests. Try again later.',429,Math.max(1,Math.ceil((value.until-now)/1000)));value.count++;this.rates.set(key,value);
  }
  area(area){
    const value=this.keypad.displayArea(area);
    return {id:value.id,name:value.name,enabled:value.enabled,mode:value.mode,targetMode:value.targetMode,status:value.status,countdownSec:value.countdownSec,readyAway:value.readyAway,readyHome:value.readyHome,zoneCount:value.zoneCount,includedCount:value.includedCount,readyCount:value.readyCount,bypassedCount:value.bypassedCount,troubleCount:value.troubleCount,activeAlarmCount:value.activeAlarmCount,blockingZones:value.blockingZones.map(({id,name,status,trouble,awaitingReading})=>({id,name,status,trouble,...(awaitingReading?{awaitingReading:true}:{})})),zoneIssues:value.zoneIssues.map(({id,name,status,trouble,bypassed,manualBypassed,cycleBypassed,homeExcluded})=>({id,name,status,trouble,bypassed,manualBypassed,cycleBypassed,homeExcluded})),zoneTroubleCount:value.zoneTroubleCount,cycleBypassCount:value.cycleBypassCount,cycleBypasses:value.cycleBypasses,awaitingZones:value.awaitingZones,awaitingZoneCount:value.awaitingZoneCount,canArmAway:area.mode==='disarmed'&&!area.targetMode&&value.readyAway};
  }
  state(config=this.config()){requireValue(config.enabled,'Local kiosk access is unavailable',403);const scope=new Set(this.scope(config));return {kiosk:true,now:this.keypad.now(),timezone:this.security.timezone,canArm:true,canBypassArm:config.allowBypassArming,canForceArm:config.allowBypassArming,armingRevision:this.keypad.armingRevision([...scope],this.binding(config)),readOnly:false,areas:this.security.areas().filter(area=>scope.has(area.id)).map(area=>this.area(area))};}
  command(input){const config=this.config(),binding=this.binding(config);requireValue(config.enabled,'Local kiosk access is unavailable',403);const result=this.keypad.kioskCommand(input,this.scope(config),{allowBypassArming:config.allowBypassArming,binding,checkBypass:ids=>{const fresh=this.config(),scope=new Set(this.scope(fresh));requireValue(fresh.enabled&&fresh.allowBypassArming&&this.binding(fresh)===binding&&ids.every(id=>scope.has(id)),'Kiosk permissions changed',403);}});if(result.preview)return result;return {ok:true,action:result.action,areaIds:result.areaIds,areas:result.areaIds.map(id=>this.area(this.security.requireArea(id)))};}
}
