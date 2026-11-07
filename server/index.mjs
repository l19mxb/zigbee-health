import path from 'node:path';
import {Store} from './store.mjs';
import {Engine} from './engine.mjs';
import {Collectors,sendEmail} from './collectors.mjs';
import {seedDemo,pulseDemo} from './demo.mjs';
import {PushService} from './push.mjs';
import {createApp} from './http.mjs';

const demo=process.argv.includes('--demo'),host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||18920);
const data=path.resolve(process.env.DATA_DIR||'data/'+(demo?'simulation':'live'));
const store=new Store(path.join(data,'health.db'));
if(!!store.get('demoSeeded')&&!demo)throw Error('A simulation database cannot be opened in live mode');
const engine=new Engine(store,{demo});
if(demo)seedDemo(engine);
else for(const n of store.networks()){n.connected=false;n.bridgeState='unknown';n.attemptAt=Date.now();store.saveNetwork(n);}
const collectors=new Collectors(engine),push=new PushService(engine),server=createApp(engine,{collectors,push,password:process.env.APP_PASSWORD||'',host,publicHost:process.env.PUBLIC_HOST||''});
collectors.reconcile();engine.tick();
const timer=setInterval(()=>{try{if(demo)pulseDemo(engine);engine.tick();push.queue();void push.deliver().catch(()=>console.error('Push evaluation failed; check local service diagnostics'));void engine.deliver(message=>sendEmail(store,message));}catch{console.error('Health evaluation failed; check local service diagnostics');}},5000);
timer.unref();
server.listen(port,host,()=>console.log(`Zigbee Health ${demo?'SIMULATION':'LIVE'}: http://${host}:${server.address().port}`));
let stopping=false;async function stop(){if(stopping)return;stopping=true;clearInterval(timer);await collectors.close();await push.close();server.close(()=>{store.close();process.exit(0);});}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
