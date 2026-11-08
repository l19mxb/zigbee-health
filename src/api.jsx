import {setDisplayTimezone} from './ui.jsx';
import {useEffect,useRef,useState} from 'react';
export async function request(path,body,signal){const response=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal});const data=await response.json();if(!response.ok){const error=Error(data.error||'Request failed');error.status=response.status;throw error;}return data;}
export function useSnapshot(paused){
  const [data,setData]=useState(null),[error,setError]=useState(null),[auth,setAuth]=useState(false),[loading,setLoading]=useState(true),active=useRef(null);
  async function refresh(){active.current?.abort();const controller=new AbortController();active.current=controller;try{const state=await request('state',undefined,controller.signal);setDisplayTimezone(state.timezone);setData(state);setError(null);setAuth(false);}catch(e){if(e.name!=='AbortError'){setError(e.message);if(e.status===401){setAuth(true);setData(null);}}}finally{if(!controller.signal.aborted)setLoading(false);}}
  useEffect(()=>{if(!paused)void refresh();const id=setInterval(()=>{if(!paused)void refresh();},5000);return()=>{clearInterval(id);active.current?.abort();};},[paused]);
  return {data,error,auth,loading,refresh};
}
