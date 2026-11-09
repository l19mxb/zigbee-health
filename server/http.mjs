import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {validateThresholds} from './store.mjs';
import {uid} from './engine.mjs';
import {PushService} from './push.mjs';
import {validateTopics} from './topic-log.mjs';
import {Sessions} from './sessions.mjs';
import {Accounts,permissionKeys,hasPermission} from './accounts.mjs';
import {SecurityEngine} from './security.mjs';
import {Keypad,KeypadError} from './keypad.mjs';
import {Kiosk} from './kiosk.mjs';
import {FloorPlan,FloorPlanError,floorPlanBodyLimit,floorPlanPermissions} from './floor-plan.mjs';

const previewUser={id:'local-preview',username:'admin',displayName:'Local preview',role:'admin',enabled:true};
const adminChanges=new Set(['/api/users','/api/users/update','/api/users/reset-password','/api/users/revoke-sessions','/api/users/keypad','/api/kiosk/settings']);
const routeFeatures=new Map([['/api/thresholds','manageThresholds'],['/api/device','manageDevices'],['/api/networks','manageBrokers'],['/api/email','manageEmail'],['/api/push/settings','manageNotifications'],...['retire','restore','delete-history','link','unlink'].map(action=>['/api/devices/'+action,'manageDevices']),['/api/alarms/acknowledge','acknowledge'],['/api/alarms/process','acknowledge'],['/api/shunts','manageShunts'],['/api/shunts/cancel','manageShunts']]);
for(const route of ['areas','zones','schedules','actions','remove-area','remove-zone','remove-schedule','remove-action','areas/delete','zones/delete','schedules/delete','actions/delete'])routeFeatures.set('/api/security/'+route,'manageSecurity');
for(const route of ['command','bypass','clear-bypass','zones/bypass','zones/clear-bypass'])routeFeatures.set('/api/security/'+route,'controlSecurity');
routeFeatures.set('/api/security/push-test','viewSecurity');
routeFeatures.set('/api/keypad/command','viewSecurity');
const personalChanges=new Set(['/api/logout','/api/account/password','/api/account/keypad','/api/push/subscribe','/api/push/remove','/api/push/test']);
const permissionsFor=user=>({...Object.fromEntries(permissionKeys.map(key=>[key,hasPermission(user,key)])),configure:['manageBrokers','manageThresholds','manageEmail','manageNotifications'].some(key=>hasPermission(user,key)),manageUsers:user.role==='admin',operateAlarms:hasPermission(user,'acknowledge')});

export function createApp(engine,{collectors=null,push=null,security=null,securityActions=null,keypad=null,kiosk=null,password='',host='127.0.0.1',publicHost='',dist=path.resolve('dist')}={}){
  const accounts=new Accounts(engine.s,{password});
  security=security||new SecurityEngine(engine.s,{demo:engine.demo,clock:()=>engine.now(),timezone:engine.timezone});
  const floorPlan=new FloorPlan(engine,security);
  keypad=keypad||new Keypad(engine.s,security,accounts,{clock:()=>engine.now()});
  const allowedHosts=(origin=engine.s.get('web')?.publicOrigin||'')=>new Set(['127.0.0.1','localhost','[::1]',host,...String(publicHost).split(',').map(x=>x.trim()),...(origin?[new URL(origin).hostname]:[])].filter(Boolean));
  kiosk=kiosk||new Kiosk(keypad,{recognizesOrigin:origin=>allowedHosts().has(new URL(origin).hostname),clock:()=>engine.now()});
  if(!['127.0.0.1','localhost','::1'].includes(host)&&!accounts.active())throw Error('Set APP_PASSWORD to at least 12 characters before LAN hosting');
  push=push||new PushService(engine);
  const sessions=new Sessions(engine.s,accounts),attempts=new Map();
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  return http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://'+req.headers.host),route=url.pathname;
      const configuredOrigin=engine.s.get('web')?.publicOrigin||'';
      const allowed=allowedHosts(configuredOrigin);
      const secureCookie=!!req.socket.encrypted||!!configuredOrigin&&new URL('https://'+req.headers.host).origin===configuredOrigin;
      if(!allowed.has(url.hostname))return json(res,403,{error:'Unrecognised host'});
      res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      if(route==='/api/health')return json(res,200,{status:'ready',mode:engine.demo?'simulation':'live',mqttPublications:securityActions?.stats?.().mqttPublications||0});
      const kioskPage=['/kiosk','/kiosk/'].includes(route),kioskGet=req.method==='GET'&&route==='/api/kiosk/state',kioskPost=req.method==='POST'&&route==='/api/kiosk/command';
      if(kioskPage||kioskGet||kioskPost){
        if(req.url.split('?')[0]!==route)return json(res,403,{error:'Use the exact local kiosk address'});
        const config=kiosk.gate(req,{post:kioskPost,rate:true});
        if(kioskPage&&req.method!=='GET')return json(res,405,{error:'Method not allowed'});
        if(kioskPost){
          let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>4096)return json(res,413,{error:'Request is too large'});parts.push(chunk);}let input;try{input=JSON.parse(Buffer.concat(parts).toString());}catch{return json(res,400,{error:'Invalid JSON'});}
          const fresh=kiosk.gate(req,{post:true});return json(res,200,kiosk.command(input,fresh));
        }
        if(route==='/api/kiosk/state')return json(res,200,kiosk.state(config));
        const file=path.join(dist,'index.html');if(!fs.existsSync(file))return json(res,503,{error:'Build the frontend first'});res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return fs.createReadStream(file).pipe(res);
      }
      if(req.method!=='GET'&&req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return json(res,403,{error:'Cross-origin changes are not allowed'});
      const token=req.headers.cookie?.match(/(?:^|; )zh_session=([a-f0-9]{64})/)?.[1];
      if(route==='/api/floor-plan'){
        const floorUser=()=>accounts.active()?sessions.current(token):previewUser;
        const user=floorUser();
        if(!user)return json(res,401,{error:'Sign in to Zigbee Console'});
        const permissions=floorPlanPermissions(user);
        if(!permissions.health&&!permissions.security)return json(res,403,{error:'Health Monitor or Security access is required'});
        if(req.method==='GET')return json(res,200,floorPlan.state(permissions,url.searchParams.get('status')==='1'));
        if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
        if(!permissions.edit)return json(res,403,{error:'Floor plan editing is not permitted'});
        if(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')return json(res,403,{error:'Cross-origin changes are not allowed'});
        if(!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type']||''))return json(res,415,{error:'Send the floor plan as JSON'});
        if(Number(req.headers['content-length'])>floorPlanBodyLimit)return json(res,413,{error:'Floor plan request exceeds 8 MiB'});
        let size=0;
        const parts=[];
        for await(const chunk of req.iterator({destroyOnReturn:false})){
          size+=chunk.length;
          if(size>floorPlanBodyLimit){req.resume();return json(res,413,{error:'Floor plan request exceeds 8 MiB'});}
          parts.push(chunk);
        }
        const freshUser=floorUser();
        if(!freshUser)return json(res,401,{error:'Sign in to Zigbee Console'});
        const freshPermissions=floorPlanPermissions(freshUser);
        if(!freshPermissions.edit)return json(res,403,{error:'Floor plan editing is not permitted'});
        let input;
        try{input=JSON.parse(Buffer.concat(parts).toString());}catch{return json(res,400,{error:'Invalid JSON'});}
        return json(res,200,floorPlan.save(input,freshPermissions,freshUser.username));
      }
      let body={};if(['POST','PUT','DELETE'].includes(req.method)){let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>65536)return json(res,413,{error:'Request is too large'});parts.push(chunk);}try{body=JSON.parse(Buffer.concat(parts).toString()||'{}');}catch{return json(res,400,{error:'Invalid JSON'});}if(!body||Array.isArray(body)||typeof body!=='object')return json(res,400,{error:'Expected a JSON object'});}
      if(route==='/api/login'&&req.method==='POST'){
        if(body.rememberMe!==undefined&&typeof body.rememberMe!=='boolean')return json(res,400,{error:'Stay signed in must be on or off'});
        const username=body.username===undefined?'admin':body.username;
        if(typeof username!=='string'||username.length>64||typeof body.password!=='string'||body.password.length>128)return json(res,400,{error:'Invalid username or password'});
        const now=Date.now();for(const [key,value] of attempts)if(value.until<=now)attempts.delete(key);
        const keys=[[req.socket.remoteAddress,80],[req.socket.remoteAddress+':'+username.trim().toLowerCase(),8]];
        if(attempts.size>4096)return json(res,429,{error:'Too many attempts. Try again later.'});
        for(const [key,max] of keys){const record=attempts.get(key)||{count:0,until:now+900000};if(record.count>=max)return json(res,429,{error:'Too many attempts. Try again later.'});record.count++;attempts.set(key,record);}
        const user=accounts.active()?accounts.authenticate(username,body.password):previewUser;
        if(!user)return json(res,401,{error:'Incorrect username or password'});
        attempts.delete(keys[1][0]);
        if(!accounts.active())return json(res,200,{ok:true,user});
        const issued=sessions.issue(body.rememberMe===true,user);sessions.revoke(token);res.setHeader('Set-Cookie','zh_session='+issued.token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+issued.seconds+(secureCookie?'; Secure':''));return json(res,200,{ok:true,user});
      }
      const user=accounts.active()?sessions.current(token):previewUser,admin=user?.role==='admin',actor=user?.username;
      if(route.startsWith('/api/')&&!user)return json(res,401,{error:'Sign in to Zigbee Health'});
      const permissions=user?permissionsFor(user):null;
      const deniedRead=req.method==='GET'&&((['/api/users','/api/users/keypad','/api/kiosk/settings'].includes(route)&&!admin)||(['/api/security','/api/keypad'].includes(route)&&!permissions.viewSecurity)||(route==='/api/network-log'&&!permissions.manageBrokers)||(['/api/report','/api/report.csv'].includes(route)&&!permissions.viewReports));
      const deniedWrite=req.method!=='GET'&&((adminChanges.has(route)&&!admin)||(routeFeatures.has(route)&&!hasPermission(user,routeFeatures.get(route)))||(!admin&&!routeFeatures.has(route)&&!personalChanges.has(route)));
      if(route.startsWith('/api/')&&(deniedRead||deniedWrite))return json(res,403,{error:'Your permissions do not permit this action'});
      if(route==='/api/logout'&&req.method==='POST'){sessions.revoke(token);res.setHeader('Set-Cookie','zh_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+(secureCookie?'; Secure':''));return json(res,200,{ok:true});}
      if(route==='/api/keypad'&&req.method==='GET')return json(res,200,keypad.state(user));
      if(route==='/api/keypad/command'&&req.method==='POST')return json(res,200,keypad.command(user,body));
      if(route==='/api/account/keypad'&&req.method==='GET')return json(res,200,keypad.settings(user.id));
      if(route==='/api/account/keypad'&&req.method==='POST')return json(res,200,keypad.saveOwn(user,body));
      if(route==='/api/users/keypad'&&req.method==='GET')return json(res,200,keypad.settings(url.searchParams.get('id'),{admin:true}));
      if(route==='/api/users/keypad'&&req.method==='POST')return json(res,200,keypad.saveUser(user,body));
      if(route==='/api/kiosk/settings'&&req.method==='GET')return json(res,200,kiosk.settings(user));
      if(route==='/api/kiosk/settings'&&req.method==='POST')return json(res,200,kiosk.configure(user,body));
      if(route==='/api/state'&&req.method==='GET'){
        const state=engine.snapshot();
        if(!permissions.manageBrokers)state.networks=state.networks.map(({id,label,mode,status,connected,enabled,bridgeState,subscriptionStatus})=>({id,label,mode,status,connected,enabled,bridgeState,subscriptionStatus}));
        if(!permissions.manageEmail){state.email={enabled:state.email.enabled};state.deliveries=[];}
        if(!permissions.viewHealth){state.alarms=[];state.shunts=[];}
        if(!permissions.viewHealth&&!permissions.viewReports&&!permissions.manageDevices)state.devices=[];
        if(!permissions.viewHealth&&!permissions.viewReports&&!permissions.manageDevices&&!permissions.manageBrokers)state.networks=[];
        if(!permissions.viewReports){state.events=[];state.links=permissions.manageDevices?state.links:[];}
        else if(!admin)state.events=state.events.filter(event=>!event.type.startsWith('user_')&&!event.type.startsWith('account_')&&!['administrator_created','password_changed','password_reset','permissions_changed'].includes(event.type));
        if(!permissions.viewSecurity)state.events=state.events.filter(event=>!event.type.startsWith('security_'));
        return json(res,200,{...state,traffic:permissions.manageBrokers?collectors?.traffic?.()||{}:{},authenticationRequired:accounts.active(),currentUser:user,permissions});
      }
      if(route==='/api/security'&&req.method==='GET'){
        const state=security.state();
        // Security readers see zone candidates without inheriting broker/email
        // administration or the unrelated health-monitor inventory/history.
        state.networks=(state.networks||engine.s.networks()).map(({id,label,mode,enabled,connected,status})=>({id,label,mode,enabled,connected,status}));
        state.devices=(state.devices||engine.s.devices()).map(({id,name,networkId,networkLabel,ieee,model,room,available,properties,retiredAt,disabled,inventoryPresent,power})=>({id,name,networkId,networkLabel,ieee,model,room,available,properties:Array.isArray(properties)?properties.slice(0,32).map(({property,type})=>({property,type})):[],retiredAt,disabled,inventoryPresent,power}));
        // Keep one bounded candidate inventory; zone values have their own DTO.
        delete state.candidates;delete state.eligibleDevices;
        if(!permissions.manageSecurity){state.actions=[];state.schedules=[];state.deliveries=(state.deliveries||[]).map(({id,incidentId,status,kind,error,createdAt,finishedAt})=>({id,incidentId,status,kind,error,createdAt,finishedAt}));delete state.securityPushRecipients;delete state.securityPushSettings;}
        return json(res,200,{...state,currentUser:user,permissions});
      }
      if(route==='/api/security/command'&&req.method==='POST'){if(Object.keys(body).some(key=>!['areaId','action','reason','actor'].includes(key)))throw new KeypadError('Use the Keypad bypass preview before bypass arming');return json(res,200,{ok:true,area:security.command(body.areaId,body.action,{reason:body.reason},actor)});}
      if(route==='/api/security/push-test'&&req.method==='POST')return json(res,200,await push.securityTest(body.subscriptionId,accounts.active()?user.id:null));
      if(['/api/security/bypass','/api/security/zones/bypass'].includes(route)&&req.method==='POST')return json(res,200,{ok:true,zone:security.bypassZone(body.id,{durationMin:body.durationMin,reason:body.reason},actor)});
      if(['/api/security/clear-bypass','/api/security/zones/clear-bypass'].includes(route)&&req.method==='POST')return json(res,200,{ok:true,zone:security.clearBypass(body.id,actor)});
      const securitySaves={'/api/security/areas':['saveArea','area'],'/api/security/zones':['saveZone','zone'],'/api/security/schedules':['saveSchedule','schedule'],'/api/security/actions':['saveAction','action']};
      if(securitySaves[route]&&req.method==='POST'){const [method,key]=securitySaves[route];return json(res,body.id?200:201,{ok:true,[key]:security[method](body,actor)});}
      const securityRemoves={'/api/security/remove-area':'removeArea','/api/security/areas/delete':'removeArea','/api/security/remove-zone':'removeZone','/api/security/zones/delete':'removeZone','/api/security/remove-schedule':'removeSchedule','/api/security/schedules/delete':'removeSchedule','/api/security/remove-action':'removeAction','/api/security/actions/delete':'removeAction'};
      if(securityRemoves[route]&&req.method==='POST'){security[securityRemoves[route]](body.id,actor);return json(res,200,{ok:true});}
      if(route==='/api/users'&&req.method==='GET')return json(res,200,{users:accounts.list(),roles:['admin','operator','viewer'],accountsEnabled:accounts.active()});
      if(route.startsWith('/api/users')&&req.method==='POST'&&!accounts.active())throw Error('Configure an administrator password before managing users');
      if(route==='/api/users'&&req.method==='POST')return json(res,201,{user:accounts.create(body,actor)});
      if(route==='/api/users/update'&&req.method==='POST')return json(res,200,{user:accounts.update(body,actor)});
      if(route==='/api/users/reset-password'&&req.method==='POST'){accounts.resetPassword(body,actor);return json(res,200,{ok:true});}
      if(route==='/api/users/revoke-sessions'&&req.method==='POST'){accounts.revokeSessions(body.id,actor);return json(res,200,{ok:true});}
      if(route==='/api/account/password'&&req.method==='POST'){
        if(!accounts.active())throw Error('Password changes are unavailable in the unauthenticated preview');
        const key='password:'+user.id,record=attempts.get(key)||{count:0,until:Date.now()+900000};if(record.until<=Date.now()){record.count=0;record.until=Date.now()+900000;}if(record.count>=8)return json(res,429,{error:'Too many attempts. Try again later.'});record.count++;attempts.set(key,record);
        accounts.changePassword(user.id,body.currentPassword,body.newPassword);sessions.revokeUser(user.id);res.setHeader('Set-Cookie','zh_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+(secureCookie?'; Secure':''));return json(res,200,{ok:true});
      }
      if(route==='/api/push'&&req.method==='GET')return json(res,200,push.status(accounts.active()?user.id:null,admin));
      if(route==='/api/push/settings'&&req.method==='POST'){push.configure(body,actor);return json(res,200,{ok:true});}
      if(route==='/api/push/subscribe'&&req.method==='POST'){
        if(!permissions.viewHealth&&!permissions.viewSecurity)return json(res,403,{error:'Health monitor or Security access is required for browser notifications'});
        const origin=engine.s.get('web')?.publicOrigin;if(!origin||req.headers.origin!==origin)throw Error('Enable browser notifications from the configured HTTPS app address');
        return json(res,201,push.subscribe(body.subscription,body.label,actor,accounts.active()?user.id:null));
      }
      if(route==='/api/push/remove'&&req.method==='POST'){push.remove(body.id,actor,accounts.active()?user.id:null,admin);return json(res,200,{ok:true});}
      if(route==='/api/push/test'&&req.method==='POST'){if(!permissions.viewHealth&&!permissions.viewSecurity)return json(res,403,{error:'Health monitor or Security access is required for browser notifications'});return json(res,200,await push.test(body.id,accounts.active()?user.id:null,admin));}
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
    }catch(e){if(!res.headersSent){if(e instanceof KeypadError&&e.retryAfter)res.setHeader('Retry-After',String(e.retryAfter));json(res,e instanceof KeypadError||e instanceof FloorPlanError?e.statusCode:400,{error:e.message||'Request failed'});}else res.end();}
  });
}
