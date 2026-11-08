import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');

test('install manifest uses the same-origin authenticated session and valid Android app assets',()=>{
  // A protected reverse proxy needs credentials even for a same-origin manifest.
  // Without this, the browser can receive a login document rather than app JSON.
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const link=html.match(/<link\b[^>]*\brel="manifest"[^>]*>/i)?.[0];
  assert.ok(link,'The entry document must link its install manifest');
  assert.match(link,/\bhref="\/manifest\.webmanifest"/);
  assert.match(link,/\bcrossorigin="use-credentials"/);
  const manifest=JSON.parse(fs.readFileSync(new URL('../public/manifest.webmanifest',import.meta.url),'utf8'));
  assert.ok(manifest.name||manifest.short_name);
  assert.equal(manifest.id,'/');assert.equal(manifest.start_url,'/');assert.equal(manifest.scope,'/');
  assert.equal(manifest.display,'standalone');assert.notEqual(manifest.prefer_related_applications,true);
  for(const size of [192,512]){
    const icon=manifest.icons.find(value=>value.sizes===`${size}x${size}`&&value.type==='image/png'&&(!value.purpose||value.purpose.split(/\s+/).includes('any')));
    assert.ok(icon,`Android install needs a usable ${size}px app icon`);
    assert.match(icon.src,/^\/icon-[0-9]+\.png$/);
    const png=fs.readFileSync(new URL('../public'+icon.src,import.meta.url));
    assert.deepEqual(png.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
    assert.equal(png.toString('ascii',12,16),'IHDR');
    assert.equal(png.readUInt32BE(16),size);assert.equal(png.readUInt32BE(20),size);
  }
});
function worker({windowOpen=true,navigable=false,navigationFails=false}={}){const handlers={},notifications=[],opened=[],messages=[],cached=[],navigated=[],fetched=[];let focused=0;
  const client={url:'https://health.example.test/',focus:async()=>focused++,postMessage:value=>messages.push(value)};
  if(navigable)client.navigate=async url=>{navigated.push(url);if(navigationFails)throw Error('Navigation unavailable');return client;};
  const self={location:{origin:'https://health.example.test'},addEventListener:(key,fn)=>handlers[key]=fn,skipWaiting:async()=>{},registration:{showNotification:async(...args)=>notifications.push(args)},clients:{claim:async()=>{},matchAll:async()=>windowOpen?[client]:[],openWindow:async url=>opened.push(url)}};
  const caches={open:async()=>({put:async(path)=>cached.push(path)}),keys:async()=>[],delete:async()=>{},match:async path=>({offline:path})};
  vm.runInNewContext(source,{self,caches,URL,fetch:async path=>{fetched.push(path);return {ok:true,redirected:false,headers:{get:()=>path.endsWith('.png')?'image/png':'text/html'}};}});
  async function emit(type,event){let wait=Promise.resolve();handlers[type]({...event,waitUntil:p=>wait=p});await wait;}
  return{self,handlers,notifications,opened,messages,cached,navigated,fetched,emit,focused:()=>focused};
}
test('service worker caches only generic offline assets and never handles API responses',async()=>{const w=worker();await w.emit('install',{});assert.deepEqual(w.cached,['/offline.html','/icon-192.png','/icon-512.png']);let handled=false;w.handlers.fetch({request:{url:'https://health.example.test/api/state',method:'GET',mode:'cors'},respondWith:()=>handled=true});assert.equal(handled,false);});
test('background push renders its supplied payload without fetching an authenticated API; clicking only opens the alarm viewer',async()=>{const w=worker();await w.emit('push',{data:{json:()=>({title:'Synthetic alarm',body:'Low battery detected.',url:'/?alarm=synthetic',tag:'synthetic'})}});assert.equal(w.notifications.length,1);assert.equal(w.notifications[0][1].data.url,'/?alarm=synthetic');await w.emit('notificationclick',{notification:{close(){},data:w.notifications[0][1].data}});assert.equal(w.focused(),1);assert.equal(w.messages[0].type,'OPEN_ALARMS');assert.equal(w.opened.length,0);await w.emit('push',{data:{json:()=>({url:'https://evil.example.test/'})}});assert.equal(w.notifications[1][1].data.url,'/');});

test('Security push targets Security in an existing older window and never performs an alarm operation',async()=>{
  const w=worker(),id='00000000-0000-4000-8000-000000000001';
  await w.emit('push',{data:{json:()=>({title:'Zigbee Security',body:'Security alarm detected.',tag:'security-'+id,url:'/?security='+id})}});
  assert.equal(w.notifications[0][0],'Zigbee Security');assert.equal(w.notifications[0][1].requireInteraction,true);
  await w.emit('notificationclick',{notification:{close(){},data:w.notifications[0][1].data}});
  assert.equal(w.focused(),1);assert.equal(w.messages[0].type,'OPEN_SECURITY');assert.equal(w.messages[0].incidentId,id);
  assert.deepEqual(w.fetched,[]);assert.deepEqual(w.opened,[]);
});

test('Security click reloads a controlled existing client at its deep link and focuses it',async()=>{
  const w=worker({navigable:true}),target='https://health.example.test/?security=00000000-0000-4000-8000-000000000001';
  await w.emit('notificationclick',{notification:{close(){},data:{url:target}}});
  assert.deepEqual(w.navigated,[target]);assert.equal(w.focused(),1);assert.deepEqual(w.messages,[]);assert.deepEqual(w.fetched,[]);
});

test('Security preview opens the panel when closed, and failed navigation falls back without an API request',async()=>{
  const closed=worker({windowOpen:false});await closed.emit('notificationclick',{notification:{close(){},data:{url:'/?security=test'}}});
  assert.deepEqual(closed.opened,['https://health.example.test/?security=test']);assert.deepEqual(closed.fetched,[]);
  const fallback=worker({navigable:true,navigationFails:true});await fallback.emit('notificationclick',{notification:{close(){},data:{url:'/?security=test'}}});
  assert.equal(fallback.focused(),1);assert.equal(fallback.messages[0].type,'OPEN_SECURITY');assert.deepEqual(fallback.fetched,[]);
});

test('foreign Security links cannot navigate or open a window and do not gain Security notification behavior',async()=>{
  const w=worker({navigable:true});await w.emit('push',{data:{json:()=>({url:'https://foreign.example.test/?security=test'})}});
  assert.equal(w.notifications[0][1].data.url,'/');assert.equal(w.notifications[0][1].requireInteraction,false);
  await w.emit('notificationclick',{notification:{close(){},data:{url:'https://foreign.example.test/?security=test'}}});
  assert.deepEqual(w.navigated,[]);assert.deepEqual(w.opened,[]);assert.equal(w.focused(),0);assert.deepEqual(w.fetched,[]);
});
