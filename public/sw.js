const CACHE='zigbee-health-offline-v1';
const OFFLINE=['/offline.html','/icon-192.png','/icon-512.png'];
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  for(const path of OFFLINE){const response=await fetch(path,{cache:'reload',redirect:'error'});const type=response.headers.get('Content-Type')||'';if(!response.ok||response.redirected||!type.startsWith(path.endsWith('.png')?'image/png':'text/html'))throw Error('Offline asset unavailable');await cache.put(path,response);}
  await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const key of await caches.keys())if(key.startsWith('zigbee-health-offline-')&&key!==CACHE)await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  // Never cache API responses, login pages, alarm data or the live application.
  const url=new URL(event.request.url);if(url.origin!==self.location.origin||event.request.method!=='GET'||url.pathname.startsWith('/api/'))return;
  if(event.request.mode==='navigate')event.respondWith(fetch(event.request).catch(()=>caches.match('/offline.html')));
  else if(OFFLINE.includes(url.pathname))event.respondWith(fetch(event.request).catch(()=>caches.match(url.pathname)));
});
self.addEventListener('push',event=>event.waitUntil((async()=>{
  let data={};try{data=event.data?.json()||{};}catch{}
  let target;try{target=new URL(typeof data.url==='string'?data.url:'/',self.location.origin);}catch{target=new URL('/',self.location.origin);}
  await self.registration.showNotification(String(data.title||'Zigbee Health').slice(0,100),{
    body:String(data.body||'Open the health monitor to review.').slice(0,300),icon:'/icon-192.png',badge:'/icon-192.png',
    tag:String(data.tag||'zigbee-health').slice(0,100),data:{url:target.origin===self.location.origin?target.pathname+target.search:'/'},
    requireInteraction:target.origin===self.location.origin&&target.pathname==='/'&&target.searchParams.has('security'),
  });
})()));
self.addEventListener('notificationclick',event=>{
  event.notification.close();event.waitUntil((async()=>{
    const target=new URL(event.notification.data?.url||'/',self.location.origin);if(target.origin!==self.location.origin)return;
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const client=windows.find(c=>new URL(c.url).origin===self.location.origin);
    const security=target.pathname==='/'&&target.searchParams.has('security');
    if(client){
      if(security&&typeof client.navigate==='function'){
        // Reload the target so an already-open older app also understands the
        // Security deep link. An expired Access session still uses normal login.
        try{const navigated=await client.navigate(target.href);await (navigated||client).focus();return;}catch{}
      }
      await client.focus();client.postMessage(security?{type:'OPEN_SECURITY',incidentId:target.searchParams.get('security')}:{type:'OPEN_ALARMS'});
    }else await self.clients.openWindow(target.href);
  })());
});
