import React,{useSyncExternalStore} from 'react';

const storageKey='zh-theme';
const options=new Set(['light','dark','system']);
const normalize=value=>options.has(value)?value:'system';
const media=typeof window!=='undefined'&&typeof window.matchMedia==='function'?window.matchMedia('(prefers-color-scheme: dark)'):null;
const listeners=new Set();
function readPreference(){try{return normalize(window.localStorage.getItem(storageKey));}catch{return 'system';}}
let preference=typeof window==='undefined'?'system':readPreference();

function applyTheme(){
  if(typeof document==='undefined')return;
  document.documentElement.dataset.theme=preference==='system'?(media?.matches?'dark':'light'):preference;
  document.documentElement.dataset.themePreference=preference;
}
function notify(){applyTheme();for(const listener of listeners)listener();}
function onSystemChange(){if(preference==='system')notify();}
function onStorage(event){if(event.key===storageKey||event.key===null){preference=readPreference();notify();}}
function subscribe(listener){
  if(!listeners.size&&typeof window!=='undefined'){
    window.addEventListener('storage',onStorage);
    if(media?.addEventListener)media.addEventListener('change',onSystemChange);
    else media?.addListener?.(onSystemChange);
    applyTheme();
  }
  listeners.add(listener);
  return()=>{
    listeners.delete(listener);
    if(!listeners.size&&typeof window!=='undefined'){
      window.removeEventListener('storage',onStorage);
      if(media?.removeEventListener)media.removeEventListener('change',onSystemChange);
      else media?.removeListener?.(onSystemChange);
    }
  };
}
function changePreference(value){
  preference=normalize(value);
  try{window.localStorage.setItem(storageKey,preference);}catch{/* Theme still works when browser storage is unavailable. */}
  notify();
}
// Run before React's first render so a saved dark preference does not flash a light page.
applyTheme();

export function ThemeControl({className=''}){
  const value=useSyncExternalStore(subscribe,()=>preference,()=> 'system');
  return <label className={'theme-control '+className}><span>Theme</span><select aria-label="Colour theme" value={value} onChange={event=>changePreference(event.target.value)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>;
}
