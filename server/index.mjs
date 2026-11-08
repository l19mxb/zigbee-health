import path from 'node:path';
import {Store} from './store.mjs';
import {Engine} from './engine.mjs';
import {Collectors,sendEmail} from './collectors.mjs';
import {seedDemo,pulseDemo} from './demo.mjs';
import {PushService} from './push.mjs';
import {createApp} from './http.mjs';
import {SecurityEngine} from './security.mjs';
import {SecurityActions} from './security-actions.mjs';
import {seedSecurityDemo,pulseSecurityDemo} from './security-demo.mjs';

const demo=process.argv.includes('--demo'),host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||18920);
const data=path.resolve(process.env.DATA_DIR||'data/'+(demo?'simulation':'live'));
const store=new Store(path.join(data,'health.db'));
if(!!store.get('demoSeeded')&&!demo)throw Error('A simulation database cannot be opened in live mode');
const engine=new Engine(store,{demo});
if(demo)seedDemo(engine);
else for(const n of store.networks()){n.connected=false;n.bridgeState='unknown';n.attemptAt=Date.now();store.saveNetwork(n);}
const security=new SecurityEngine(store,{demo,clock:()=>engine.now(),timezone:engine.timezone}),push=new PushService(engine),securityActions=new SecurityActions(store,{demo,push});
if(demo)seedSecurityDemo(engine,security);
const collectors=new Collectors(engine,{security}),server=createApp(engine,{collectors,push,security,securityActions,password:process.env.APP_PASSWORD||'',host,publicHost:process.env.PUBLIC_HOST||''});
collectors.reconcile();engine.tick();security.tick();
const timer=setInterval(()=>{try{if(demo){pulseDemo(engine);pulseSecurityDemo(engine,security);}engine.tick();push.queue();void push.deliver().catch(()=>console.error('Push evaluation failed; check local service diagnostics'));void engine.deliver(message=>sendEmail(store,message));}catch{console.error('Health evaluation failed; check local service diagnostics');}},5000);
timer.unref();
const securityTimer=setInterval(()=>{try{security.tick();void security.deliver((action,context,job)=>securityActions.send(action,context,job)).catch(()=>console.error('Security delivery evaluation failed; check local service diagnostics'));}catch{console.error('Security evaluation failed; check local service diagnostics');}},1000);
securityTimer.unref();
server.listen(port,host,()=>console.log(`Zigbee Health ${demo?'SIMULATION':'LIVE'}: http://${host}:${server.address().port}`));
let stopping=false;async function stop(){if(stopping)return;stopping=true;clearInterval(timer);clearInterval(securityTimer);await collectors.close();await push.close();await securityActions.close();server.close(()=>{store.close();process.exit(0);});}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
