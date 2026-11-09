import React,{useEffect} from 'react';
import Keypad from './keypad.jsx';
import './kiosk.css';

const routes=new Set(['kiosk/state','kiosk/command']);
async function kioskRequest(path,body,signal){
  if(!routes.has(path))throw Error('This request is unavailable on the local keypad.');
  const response=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',credentials:'omit',mode:'same-origin',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal});
  let data;try{data=await response.json();}catch{throw Error('Open the local keypad through its configured direct local IP address.');}
  if(!response.ok){const error=Error(data.error||'The local keypad is unavailable from this address or network.');error.status=response.status;throw error;}
  return data;
}
export default function KioskApp(){
  useEffect(()=>{const previous=document.title;document.title='Local keypad · Zigbee Console';return()=>{document.title=previous;};},[]);
  return <main className="kiosk-page"><Keypad kiosk requestApi={kioskRequest}/></main>;
}
