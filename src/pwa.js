let installPrompt=null;
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;window.dispatchEvent(new Event('zh-install-ready'));});
window.addEventListener('appinstalled',()=>{installPrompt=null;window.dispatchEvent(new Event('zh-install-ready'));});
export const getInstallPrompt=()=>installPrompt;
export async function installApp(){const prompt=installPrompt;if(!prompt)return;await prompt.prompt();await prompt.userChoice;installPrompt=null;window.dispatchEvent(new Event('zh-install-ready'));}
export const serviceWorkerReady=typeof navigator!=='undefined'&&'serviceWorker' in navigator&&window.isSecureContext
  ?navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).catch(()=>null):Promise.resolve(null);
export function applicationKey(value){const raw=atob(value.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0));}
