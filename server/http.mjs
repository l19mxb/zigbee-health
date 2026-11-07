import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {validateThresholds} from './store.mjs';
import {uid} from './engine.mjs';
import {PushService} from './push.mjs';
import {validateTopics} from './topic-log.mjs';

export function createApp(engine,{collectors=null,push=null,password='',host='127.0.0.1',publicHost='',dist=path.resolve('dist')}={}){
  if(!['127.0.0.1','localhost','::1'].includes(host)&&password.length<12)throw Error('Set APP_PASSWORD to at least 12 characters before LAN hosting');
  push=push||new PushService(engine);
  const sessions=new Map(),attempts=new Map(),salt=crypto.randomBytes(16),hash=password?crypto.scryptSync(password,salt,32):null;
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  const actor='Local operator';
  return http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://'+req.headers.host),route=url.pathname;
      const configuredOrigin=engine.s.get('web')?.publicOrigin||'';
      const allowed=new Set(['127.0.0.1','localhost','[::1]',host,...String(publicHost).split(',').map(x=>x.trim()),...(configuredOrigin?[new URL(configuredOrigin).hostname]:[])].filter(Boolean));
      const secureCookie=!!req.socket.encrypted||!!configuredOrigin&&new URL('https://'+req.headers.host).origin===configuredOrigin;
      if(!allowed.has(url.hostname))return json(res,403,{error:'Unrecognised host'});
      res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      if(route==='/api/health')return json(res,200,{status:'ready',mode:engine.demo?'simulation':'live',mqttPublications:0});
      if(req.method!=='GET'&&req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return json(res,403,{error:'Cross-origin changes are not allowed'});
      let body={};if(['POST','PUT','DELETE'].includes(req.method)){let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>65536)return json(res,413,{error:'Request is too large'});parts.push(chunk);}try{body=JSON.parse(Buffer.concat(parts).toString()||'{}');}catch{return json(res,400,{error:'Invalid JSON'});}if(!body||Array.isArray(body)||typeof body!=='object')return json(res,400,{error:'Expected a JSON object'});}
      if(route==='/api/login'&&req.method==='POST'){
        const key=req.socket.remoteAddress,record=attempts.get(key)||{count:0,until:Date.now()+900000};if(record.until<Date.now()){record.count=0;record.until=Date.now()+900000;}if(record.count>=8)return json(res,429,{error:'Too many attempts. Try again later.'});record.count++;attempts.set(key,record);
        const supplied=String(body.password||'');if(supplied.length>512)return json(res,400,{error:'Invalid password'});
        if(hash&&!crypto.timingSafeEqual(hash,crypto.scryptSync(supplied,salt,32)))return json(res,401,{error:'Incorrect password'});
        const token=crypto.randomBytes(32).toString('hex');sessions.set(token,Date.now()+12*3600000);res.setHeader('Set-Cookie','zh_session='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'+(secureCookie?'; Secure':''));return json(res,200,{ok:true});
      }
      const token=req.headers.cookie?.match(/(?:^|; )zh_session=([a-f0-9]{64})/)?.[1];
      if(route.startsWith('/api/')&&hash&&(!token||!sessions.has(token)||sessions.get(token)<Date.now()))return json(res,401,{error:'Sign in to Zigbee Health'});
      if(route==='/api/logout'&&req.method==='POST'){sessions.delete(token);res.setHeader('Set-Cookie','zh_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+(secureCookie?'; Secure':''));return json(res,200,{ok:true});}
      if(route==='/api/state'&&req.method==='GET')return json(res,200,{...engine.snapshot(),traffic:collectors?.traffic?.()||{},authenticationRequired:!!hash});
      if(route==='/api/push'&&req.method==='GET')return json(res,200,push.status());
      if(route==='/api/push/settings'&&req.method==='POST'){push.configure(body,actor);return json(res,200,{ok:true});}
      if(route==='/api/push/subscribe'&&req.method==='POST'){
        const origin=engine.s.get('web')?.publicOrigin;if(!origin||req.headers.origin!==origin)throw Error('Enable browser notifications from the configured HTTPS app address');
        return json(res,201,push.subscribe(body.subscription,body.label,actor));
      }
      if(route==='/api/push/remove'&&req.method==='POST'){push.remove(body.id,actor);return json(res,200,{ok:true});}
      if(route==='/api/push/test'&&req.method==='POST')return json(res,200,await push.test(body.id));
      if(route==='/api/network-log'&&req.method==='GET'){
        const id=url.searchParams.get('network');if(!engine.s.network(id))throw Error('Network not found');
        return json(res,200,{entries:collectors?.logs?.read(id)||[],limit:200,persistent:false});
      }
      if(route==='/api/alarms/acknowledge'&&req.method==='POST'){engine.acknowledge(body.ids,actor,String(body.note||'').slice(0,500));return json(res,200,{ok:true});}
      if(route==='/api/alarms/process'&&req.method==='POST'){engine.process(body.id,actor,String(body.note||'').slice(0,500));return json(res,200,{ok:true});}
      if(route==='/api/shunts'&&req.method==='POST')return json(res,201,engine.shunt(body,actor));
      if(route==='/api/shunts/cancel'&&req.method==='POST'){engine.cancelShunt(body.id,actor);return json(res,200,{ok:true});}
      if(route==='/api/thresholds'&&req.method==='POST'){
        const validated=validateThresholds(body,engine.thresholds());engine.s.set('thresholds',validated);engine.s.event('settings_changed','Health thresholds and retention updated',{actor,at:engine.now()});return json(res,200,{ok:true});
      }
      const lifecycleRoutes={'/api/devices/retire':'retireDevice','/api/devices/restore':'restoreDevice','/api/devices/delete-history':'deleteDeviceHistory','/api/devices/link':'linkDevice','/api/devices/unlink':'unlinkDevice'};
      if(req.method==='POST'&&Object.hasOwn(lifecycleRoutes,route)){const result=engine[lifecycleRoutes[route]](body,actor);return json(res,200,{ok:true,result});}
      if(route==='/api/device'&&req.method==='POST'){
        const d=engine.s.device(body.id);if(!d)throw Error('Device not found');
        if(body.room!==undefined){if(typeof body.room!=='string'||body.room.length>100)throw Error('Invalid room');d.room=body.room.trim();}
        if(body.overrides!==undefined){if(!body.overrides||Array.isArray(body.overrides)||typeof body.overrides!=='object')throw Error('Invalid device overrides');validateThresholds(body.overrides,engine.thresholds());d.overrides=body.overrides;}
        engine.s.saveDevice(d);engine.s.event('device_settings_changed','Device room or thresholds updated',{actor,deviceId:d.id,networkId:d.networkId,at:engine.now()});return json(res,200,{ok:true});
      }
      if(route==='/api/networks'&&req.method==='POST'){
        if(engine.demo)throw Error('Broker connections are locked in the simulation workspace');
        const old=body.id?engine.s.network(body.id):null;if(body.id&&!old)throw Error('Network not found');
        const mode=body.mode||old?.mode||'zigbee2mqtt';if(!['zigbee2mqtt','mqtt'].includes(mode))throw Error('Choose Zigbee2MQTT or MQTT broker mode');
        if(old&&(old.mode||'zigbee2mqtt')!==mode&&engine.s.devices(old.id).length)throw Error('A network with device history keeps its mode; add a separate broker entry');
        const topicFilters=mode==='mqtt'?validateTopics(body.topicFilters||[]):[];
        if(typeof body.label!=='string'||!body.label.trim()||body.label.length>80||typeof body.host!=='string'||!/^[a-zA-Z0-9.:-]{1,253}$/.test(body.host)||!Number.isInteger(body.port)||body.port<1||body.port>65535||!['mqtt','mqtts'].includes(body.protocol)||(mode==='zigbee2mqtt'&&(typeof body.baseTopic!=='string'||!body.baseTopic||body.baseTopic.length>150||/[#+\s]|^\/|\/$/.test(body.baseTopic)))||typeof body.enabled!=='boolean')throw Error('Check the broker label, host, port, protocol and base topic');
        const n={...(old||{}),id:old?.id||uid(),configRevision:(old?.configRevision||0)+1,mode,topicFilters,label:body.label.trim(),host:body.host,port:body.port,protocol:body.protocol,baseTopic:mode==='mqtt'?'':body.baseTopic,enabled:body.enabled,username:String(body.username||'').slice(0,200),password:body.clearPassword?'':body.password?engine.s.seal(String(body.password)):old?.password||'',connected:false,attemptAt:engine.now(),bridgeState:'unknown',error:null};
        if(old&&(old.mode||'zigbee2mqtt')!==mode){engine.s.transaction(()=>{
          engine.s.run("UPDATE incidents SET restored_at=coalesce(restored_at,?),processed_at=?,resolution='monitor_mode_changed' WHERE network_id=? AND category IN ('bridge','subscription') AND processed_at IS NULL",engine.now(),engine.now(),n.id);
          engine.s.run("DELETE FROM conditions WHERE scope=? AND category IN ('bridge','subscription')",'network:'+n.id);
        });}
        engine.s.saveNetwork(n);engine.s.event('network_settings_changed','Broker configuration updated for '+n.label,{actor,networkId:n.id,at:engine.now()});collectors?.reconcile();return json(res,200,{ok:true,id:n.id});
      }
      if(route==='/api/email'&&req.method==='POST'){
        const old=engine.s.get('email')||{};if(body.enabled&&engine.demo)throw Error('Email delivery cannot be enabled in simulation');
        if(body.enabled&&(typeof body.host!=='string'||!/^[a-zA-Z0-9.:-]{1,253}$/.test(body.host)||!Number.isInteger(body.port)||body.port<1||body.port>65535||!['none','starttls','tls'].includes(body.tlsMode)||![body.sender,body.recipient].every(s=>typeof s==='string'&&/^[^\s<>@]+@[^\s<>@]+$/.test(s))))throw Error('Check the SMTP server, port, TLS and email addresses');
        if(body.tlsMode==='none'&&body.username)throw Error('Use STARTTLS or TLS when SMTP authentication is configured');
        engine.s.set('email',{enabled:body.enabled===true,recovery:body.recovery!==false,host:String(body.host||'').slice(0,253),port:Number(body.port)||587,tlsMode:body.tlsMode||'starttls',sender:String(body.sender||'').slice(0,200),recipient:String(body.recipient||'').slice(0,200),username:String(body.username||'').slice(0,200),password:body.clearPassword?'':body.password?engine.s.seal(String(body.password)):old.password||''});engine.s.event('email_settings_changed','Email notification settings updated',{actor,at:engine.now()});return json(res,200,{ok:true});
      }
      if(route==='/api/report'&&req.method==='GET')return json(res,200,engine.report(url.searchParams.get('device'),Number(url.searchParams.get('days')||7)));
      if(route==='/api/report.csv'&&req.method==='GET'){
        const r=engine.report(url.searchParams.get('device'),Number(url.searchParams.get('days')||7)),cell=v=>'"'+String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
        const lines=[['Time (UTC)','Type','Message','Actor'],...r.events.map(x=>[new Date(x.at).toISOString(),x.type,x.message,x.actor])].map(row=>row.map(cell).join(',')).join('\r\n');res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="zigbee-device-report.csv"'});return res.end(lines);
      }
      if(route.startsWith('/api/'))return json(res,404,{error:'Endpoint not found'});
      if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
      const relative=decodeURIComponent(route).replace(/^\/+/,'');const candidate=path.resolve(dist,relative||'index.html');if(candidate!==dist&&!candidate.startsWith(dist+path.sep))return json(res,403,{error:'Invalid path'});
      const file=fs.existsSync(candidate)&&fs.statSync(candidate).isFile()?candidate:path.join(dist,'index.html');if(!fs.existsSync(file))return json(res,503,{error:'Build the frontend first'});
      const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png','.webmanifest':'application/manifest+json'}[path.extname(file)]||'application/octet-stream';if(path.basename(file)==='sw.js')res.setHeader('Service-Worker-Allowed','/');res.writeHead(200,{'Content-Type':mime,'Cache-Control':path.extname(file)==='.html'||path.basename(file)==='sw.js'?'no-cache':'public,max-age=3600'});fs.createReadStream(file).pipe(res);
    }catch(e){if(!res.headersSent)json(res,400,{error:e.message||'Request failed'});else res.end();}
  });
}
