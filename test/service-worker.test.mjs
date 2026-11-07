import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');
function worker(){const handlers={},notifications=[],opened=[],messages=[],cached=[];let focused=0;
  const self={location:{origin:'https://health.example.test'},addEventListener:(key,fn)=>handlers[key]=fn,skipWaiting:async()=>{},registration:{showNotification:async(...args)=>notifications.push(args)},clients:{claim:async()=>{},matchAll:async()=>[{url:'https://health.example.test/',focus:async()=>focused++,postMessage:value=>messages.push(value)}],openWindow:async url=>opened.push(url)}};
  const caches={open:async()=>({put:async(path)=>cached.push(path)}),keys:async()=>[],delete:async()=>{},match:async path=>({offline:path})};
  vm.runInNewContext(source,{self,caches,URL,fetch:async path=>({ok:true,redirected:false,headers:{get:()=>path.endsWith('.png')?'image/png':'text/html'}})});
  async function emit(type,event){let wait=Promise.resolve();handlers[type]({...event,waitUntil:p=>wait=p});await wait;}
  return{self,handlers,notifications,opened,messages,cached,emit,focused:()=>focused};
}
test('service worker caches only generic offline assets and never handles API responses',async()=>{const w=worker();await w.emit('install',{});assert.deepEqual(w.cached,['/offline.html','/icon-192.png','/icon-512.png']);let handled=false;w.handlers.fetch({request:{url:'https://health.example.test/api/state',method:'GET',mode:'cors'},respondWith:()=>handled=true});assert.equal(handled,false);});
test('background push renders its supplied payload without fetching an authenticated API; clicking only opens the alarm viewer',async()=>{const w=worker();await w.emit('push',{data:{json:()=>({title:'Synthetic alarm',body:'Low battery detected.',url:'/?alarm=synthetic',tag:'synthetic'})}});assert.equal(w.notifications.length,1);assert.equal(w.notifications[0][1].data.url,'/?alarm=synthetic');await w.emit('notificationclick',{notification:{close(){},data:w.notifications[0][1].data}});assert.equal(w.focused(),1);assert.equal(w.messages[0].type,'OPEN_ALARMS');assert.equal(w.opened.length,0);await w.emit('push',{data:{json:()=>({url:'https://evil.example.test/'})}});assert.equal(w.notifications[1][1].data.url,'/');});
