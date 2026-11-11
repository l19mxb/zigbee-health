import test from 'node:test';
import assert from 'node:assert/strict';
import {createKeypadAudio,keypadSoundKey,liveKeypadAlarm,readKeypadSound,writeKeypadSound} from '../src/keypad-audio.mjs';

function fixture({state='running',resume='resolve',factoryFailure=false,nodeFailure=false}={}){
  let time=0,serial=0,created=0;const timers=new Map(),voices=[],statuses=[];
  const schedule=(callback,delay)=>{const id=++serial;timers.set(id,{callback,at:time+delay});return id;};
  const cancel=id=>timers.delete(id);
  const advance=ms=>{const target=time+ms;for(;;){const next=[...timers].filter(([,value])=>value.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;timers.delete(next[0]);time=next[1].at;next[1].callback();}time=target;};
  const parameter=()=>({events:[],setValueAtTime(value,at){this.events.push({value,at});},linearRampToValueAtTime(value,at){this.events.push({value,at});}});
  const context={
    state,destination:{},closed:0,onstatechange:null,
    get currentTime(){return time/1000;},
    resume(){if(resume==='reject')return Promise.reject(Error('Autoplay denied'));if(resume==='defer')return new Promise(resolve=>{this.resolveResume=()=>{this.state='running';this.onstatechange?.();resolve();};});this.state='running';this.onstatechange?.();return Promise.resolve();},
    close(){this.closed++;this.state='closed';return Promise.resolve();},
    createGain(){return {gain:parameter(),disconnected:false,connect(){},disconnect(){this.disconnected=true;}};},
    createOscillator(){
      if(nodeFailure)throw Error('Audio device unavailable');
      const voice={frequency:parameter(),disconnected:false,stopCalls:[],onended:null,started:null,endTimer:null,connect(gain){this.gain=gain;},disconnect(){this.disconnected=true;},start(at){this.started=at;},stop(at){this.stopCalls.push(at);if(this.endTimer!==null)cancel(this.endTimer);if(at===undefined){this.onended?.();return;}this.endTimer=schedule(()=>this.onended?.(),Math.max(0,(at-context.currentTime)*1000));}};
      voices.push(voice);return voice;
    },
  };
  const audio=createKeypadAudio({now:()=>time,setTimer:schedule,clearTimer:cancel,createContext:()=>{created++;if(factoryFailure)throw Error('Unsupported');return context;},onStatus:value=>statuses.push(value)});
  const snapshot=(areas,extra={})=>({now:100000+time,areas,canArm:true,canBypassArm:true,readOnly:false,...extra});
  const idle=(id='a')=>({id,mode:'disarmed',targetMode:null,status:'disarmed',cycleId:null});
  const arming=(id='a',cycle='cycle-a')=>({id,mode:'disarmed',targetMode:'away',status:'exit_delay',cycleId:cycle});
  const armed=(id='a',cycle='cycle-a',mode='away')=>({id,mode,targetMode:null,status:'armed',cycleId:cycle});
  const accept=(areas,action='arm_away')=>audio.accepted({ok:true,action,areas});
  return {audio,context,voices,statuses,timers,advance,snapshot,idle,arming,armed,accept,get created(){return created;}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('sound preference is generic, defaults on, and tolerates unavailable storage',()=>{
  const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  assert.equal(readKeypadSound(storage),true);writeKeypadSound(false,storage);assert.equal(readKeypadSound(storage),false);writeKeypadSound(true,storage);assert.equal(readKeypadSound(storage),true);assert.deepEqual([...values],[['zh-keypad-sound','on']]);assert.equal(keypadSoundKey,'zh-keypad-sound');
  const blocked={getItem(){throw Error('Storage denied');},setItem(){throw Error('Storage denied');}};assert.equal(readKeypadSound(blocked),true);assert.doesNotThrow(()=>writeKeypadSound(false,blocked));
});

test('initial state and transitions before the first gesture remain silent without creating audio',()=>{
  const f=fixture();try{
    f.audio.observe(f.snapshot([f.idle()]));f.audio.observe(f.snapshot([f.arming()]));f.audio.observe(f.snapshot([f.armed()]));assert.equal(f.created,0);assert.equal(f.voices.length,0);
    f.audio.gesture({pip:false});assert.equal(f.created,1);assert.equal(f.audio.getStatus().unlocked,true);f.audio.observe(f.snapshot([f.armed()]));assert.equal(f.voices.length,0);
  }finally{f.audio.destroy();}
});

test('key feedback is one soft50ms envelope and disconnects after completion',()=>{
  const f=fixture();try{
    f.audio.gesture();assert.equal(f.voices.length,1);const voice=f.voices[0];assert.equal(voice.stopCalls[0]-voice.started,.05);assert.ok(Math.max(...voice.gain.gain.events.map(event=>event.value))<=.035);
    f.advance(49);assert.equal(voice.disconnected,false);f.advance(1);assert.equal(voice.disconnected,true);assert.equal(voice.gain.disconnected,true);assert.equal(f.timers.size,0);
  }finally{f.audio.destroy();}
});

test('accepted exit and observed fully armed each get one1s tone without duplicate polling or timers guessing state',()=>{
  const f=fixture();try{
    f.audio.observe(f.snapshot([f.idle()]));f.audio.gesture({pip:false});assert.equal(f.accept([f.arming()]),'arming');assert.equal(f.voices.length,1);assert.equal(f.voices[0].stopCalls[0]-f.voices[0].started,1);
    f.audio.observe(f.snapshot([f.arming()]));assert.equal(f.voices.length,1);f.advance(1000);assert.equal(f.voices[0].disconnected,true);assert.equal(f.voices.length,1);
    f.advance(2000);assert.equal(f.audio.observe(f.snapshot([f.armed()])),'armed');assert.equal(f.voices.length,2);assert.equal(f.voices[1].stopCalls[0]-f.voices[1].started,1);f.audio.observe(f.snapshot([f.armed()]));f.accept([f.armed()]);assert.equal(f.voices.length,2);
  }finally{f.audio.destroy();}
});

test('zero-delay arm emits only Armed; disarm state updates permit the next fresh cycle cue',()=>{
  const f=fixture();try{
    f.audio.observe(f.snapshot([f.idle()]));f.audio.gesture({pip:false});assert.equal(f.accept([f.armed()]),'armed');assert.equal(f.voices.length,1);f.audio.observe(f.snapshot([f.armed()]));assert.equal(f.voices.length,1);
    f.accept([f.idle()],'disarm');assert.equal(f.voices.length,1);assert.equal(f.accept([f.armed('a','cycle-b','home')],'arm_home'),'armed');assert.equal(f.voices.length,2);
  }finally{f.audio.destroy();}
});

test('an explicit failed disarm plays two brief descending pips once',()=>{
  const f=fixture();
  try{
    f.audio.observe(f.snapshot([f.armed()]));
    f.audio.gesture({pip:false});
    assert.equal(f.audio.disarmOutcome({attempt:Symbol(),ok:false}),null);
    const attempt=f.audio.beginDisarm();
    assert.equal(f.audio.disarmOutcome({attempt,ok:false}),'disarmFailed');
    assert.equal(f.audio.disarmOutcome({attempt,ok:true}),null);
    assert.equal(f.voices.length,1);
    const voice=f.voices[0];
    assert.deepEqual(voice.frequency.events.map(({value})=>value),[520,370]);
    assert.equal(Math.round((voice.stopCalls[0]-voice.started)*1000),190);
    f.advance(200);
    assert.equal(voice.disconnected,true);
    assert.equal(f.timers.size,0);
  }finally{f.audio.destroy();}
});

test('accepted explicit disarm chirps once even with latched alarm memory; passive updates stay silent',()=>{
  const f=fixture();
  try{
    const withMemory={...f.idle(),status:'alarm',activeAlarmCount:1};
    f.audio.observe(f.snapshot([f.armed(),f.armed('b')]));
    f.audio.gesture({pip:false});
    f.accept([withMemory,f.idle('b')],'disarm');
    f.audio.observe(f.snapshot([withMemory,f.idle('b')]));
    assert.equal(f.voices.length,0);

    const attempt=f.audio.beginDisarm();
    f.audio.gesture();
    f.accept([withMemory,f.idle('b')],'disarm');
    assert.equal(f.audio.disarmOutcome({attempt,ok:true}),'disarmed');
    assert.equal(f.voices[0].disconnected,true);
    const voice=f.voices[1];
    assert.deepEqual(voice.frequency.events.map(({value})=>value),[660,830,990]);
    assert.equal(Math.round((voice.stopCalls[0]-voice.started)*1000),270);
    f.audio.observe(f.snapshot([withMemory,f.idle('b')]));
    assert.equal(f.voices.length,2);
  }finally{f.audio.destroy();}
});

test('disarm replies cannot replay across sound lifecycle changes or a late unlock',async()=>{
  for(const operation of ['mute','hide','disconnect','scope','destroy']){
    const f=fixture();
    try{
      f.audio.observe(f.snapshot([f.armed()]));
      f.audio.gesture({pip:false});
      const attempt=f.audio.beginDisarm();
      if(operation==='mute'){f.audio.setEnabled(false);f.audio.setEnabled(true);}
      if(operation==='hide'){f.audio.setVisible(false);f.audio.setVisible(true);}
      if(operation==='disconnect')f.audio.disconnect();
      if(operation==='scope')f.audio.observe(f.snapshot([f.armed(),f.idle('b')]));
      if(operation==='destroy')f.audio.destroy();
      assert.equal(f.audio.disarmOutcome({attempt,ok:true}),null,operation);
      assert.equal(f.voices.length,0,operation);
    }finally{f.audio.destroy();}
  }
  for(const delay of [100,401]){
    const f=fixture({state:'suspended',resume:'defer'});
    try{
      f.audio.observe(f.snapshot([f.armed()]));
      f.audio.gesture({pip:false});
      f.audio.disarmOutcome({attempt:f.audio.beginDisarm(),ok:false});
      f.advance(delay);
      f.context.resolveResume();
      await flush();
      assert.equal(f.voices.length,delay===100?1:0);
    }finally{f.audio.destroy();}
  }
});

test('keypad alarm requires an armed area rather than disarmed alarm memory or exit delay',()=>{
  assert.equal(liveKeypadAlarm({mode:'away',status:'alarm'}),true);
  assert.equal(liveKeypadAlarm({mode:'home',activeAlarmCount:2}),true);
  assert.equal(liveKeypadAlarm({mode:'away',status:'armed',activeAlarmCount:0}),false);
  assert.equal(liveKeypadAlarm({mode:'disarmed',status:'alarm',activeAlarmCount:2}),false);
  assert.equal(liveKeypadAlarm({mode:'disarmed',targetMode:'away',status:'exit_delay'}),false);
  assert.equal(liveKeypadAlarm(null),false);
});

test('keypad uses server siren state for audible and silent 24-hour alarms',()=>{
  const f=fixture();
  const alarm={...f.idle(),status:'alarm',activeAlarmCount:1,active24HourAlarmCount:1,keypadSiren:true};
  try{
    f.audio.observe(f.snapshot([alarm]));
    f.audio.gesture({pip:false});
    assert.equal(f.voices.length,1);
    assert.equal(f.voices[0].type,'triangle');
    f.audio.observe(f.snapshot([{...alarm,keypadSiren:false}]));
    assert.equal(f.voices[0].disconnected,true);
    assert.equal(liveKeypadAlarm({...f.armed(),status:'alarm',active24HourAlarmCount:1,keypadSiren:false}),false);
  }finally{f.audio.destroy();}
});

test('unlock during an alarm starts one sweeping siren for multiple areas and disarm stops it at the last area',()=>{
  const f=fixture();
  const alarm=id=>({...f.armed(id),status:'alarm',activeAlarmCount:1});
  const memory=id=>({...f.idle(id),status:'alarm',activeAlarmCount:1});
  try{
    f.audio.observe(f.snapshot([alarm('a'),alarm('b')]));
    assert.equal(f.created,0);
    f.audio.gesture({pip:false});
    assert.equal(f.voices.length,1);
    const voice=f.voices[0];
    assert.equal(voice.type,'triangle');
    assert.deepEqual(voice.frequency.events.map(({value})=>value),[540,1080]);
    f.advance(420);
    assert.deepEqual(voice.frequency.events.map(({value})=>value),[540,1080,1080,540]);
    f.accept([memory('a')],'disarm');
    f.audio.observe(f.snapshot([memory('a'),alarm('b')]));
    assert.equal(f.voices.length,1);
    assert.equal(voice.disconnected,false);
    f.accept([memory('b')],'disarm');
    assert.equal(voice.disconnected,true);
    f.audio.observe(f.snapshot([memory('a'),memory('b')]));
    assert.equal(f.voices.length,1);
    assert.equal(f.timers.size,0);
  }finally{f.audio.destroy();}
});

test('live siren stops on mute, hide, disconnect, clearing, stale state and destroy',()=>{
  for(const operation of ['mute','hide','disconnect','clear','stale','destroy']){
    const f=fixture();
    const alarm={...f.armed(),status:'alarm'};
    try{
      f.audio.observe(f.snapshot([alarm]));
      f.audio.gesture({pip:false});
      assert.equal(f.voices.length,1,operation);
      if(operation==='mute')f.audio.setEnabled(false);
      if(operation==='hide')f.audio.setVisible(false);
      if(operation==='disconnect')f.audio.disconnect();
      if(operation==='clear')f.audio.observe(f.snapshot([f.armed()]));
      if(operation==='stale'){f.advance(9999);assert.equal(f.voices[0].disconnected,false);f.advance(1);}
      if(operation==='destroy')f.audio.destroy();
      assert.equal(f.voices[0].disconnected,true,operation);
      assert.equal(f.timers.size,0,operation);
      if(operation==='hide'){f.audio.setVisible(true);assert.equal(f.voices.length,1);}
      if(operation==='stale'){f.audio.gesture({pip:false});assert.equal(f.voices.length,1);}
      if(operation==='mute'){f.audio.setEnabled(true);assert.equal(f.voices.length,2);}
    }finally{f.audio.destroy();}
  }
});

test('disarm result cues take priority over a live siren and other arming sounds',()=>{
  const f=fixture();
  const alarm={...f.armed('a'),status:'alarm'};
  try{
    f.audio.observe(f.snapshot([alarm,f.idle('b')]));
    f.audio.gesture({pip:false});
    f.audio.disarmOutcome({attempt:f.audio.beginDisarm(),ok:false});
    assert.equal(f.voices[0].disconnected,true);
    assert.deepEqual(f.voices[1].frequency.events.map(({value})=>value),[520,370]);
    f.audio.observe(f.snapshot([alarm,f.armed('b')]));
    assert.equal(f.voices.length,2);
    assert.equal(f.voices[1].disconnected,false);
    f.advance(200);
    assert.equal(f.voices[2].type,'triangle');
    const attempt=f.audio.beginDisarm();
    f.accept([{...f.idle('a'),status:'alarm',activeAlarmCount:1}],'disarm');
    f.audio.disarmOutcome({attempt,ok:true});
    assert.deepEqual(f.voices[3].frequency.events.map(({value})=>value),[660,830,990]);
    f.advance(300);
    assert.equal(f.voices.length,4);
    assert.equal(f.timers.size,0);
  }finally{f.audio.destroy();}
});

test('simultaneous visible areas coalesce to one Armed-priority tone and long voices never overlap',()=>{
  const f=fixture();try{
    f.audio.observe(f.snapshot([f.idle('a'),f.idle('b')]));f.audio.gesture({pip:false});assert.equal(f.audio.observe(f.snapshot([f.arming('a'),f.armed('b','b')])),'armed');assert.equal(f.voices.length,1);assert.equal(f.voices[0].frequency.events[0].value,880);
    f.advance(20);f.audio.observe(f.snapshot([f.armed('a'),f.armed('b','b')]));assert.equal(f.voices.length,2);assert.equal(f.voices[0].disconnected,true);assert.equal(f.voices.filter(voice=>!voice.disconnected).length,1);
  }finally{f.audio.destroy();}
});

test('mute updates state baselines, cancels current voices, and never replays old state on enabling',()=>{
  const f=fixture();try{
    f.audio.observe(f.snapshot([f.idle()]));f.audio.gesture({pip:false});f.accept([f.arming()]);f.audio.setEnabled(false);assert.ok(f.voices.every(voice=>voice.disconnected));assert.equal(f.timers.size,0);
    f.audio.observe(f.snapshot([f.armed()]));f.audio.setEnabled(true);f.audio.observe(f.snapshot([f.armed()]));assert.equal(f.voices.length,1);f.accept([f.idle()],'disarm');f.accept([f.armed('a','new')]);assert.equal(f.voices.length,2);
  }finally{f.audio.destroy();}
});

test('reconnect, hidden/resume, changed scope and long gaps each establish a silent fresh baseline',()=>{
  for(const cause of ['disconnect','hidden','scope','capability','gap']){
    const f=fixture();try{
      f.audio.observe(f.snapshot([f.idle()]));f.audio.gesture({pip:false});
      if(cause==='disconnect')f.audio.disconnect();
      if(cause==='hidden'){f.audio.setVisible(false);f.audio.observe(f.snapshot([f.arming()]));f.audio.setVisible(true);}
      if(cause==='gap')f.advance(10001);
      const extra=cause==='capability'?{canBypassArm:false}:{},areas=cause==='scope'?[f.armed(),f.idle('b')]:[f.armed()];
      f.audio.observe(f.snapshot(areas,extra));assert.equal(f.voices.length,0,cause);f.audio.observe(f.snapshot(areas,extra));assert.equal(f.voices.length,0,cause);
    }finally{f.audio.destroy();}
  }
});

test('known cycle mismatch and unchanged Armed states cannot replay a completion cue',()=>{
  const f=fixture();try{
    f.audio.observe(f.snapshot([f.idle()]));f.audio.gesture({pip:false});f.accept([f.arming('a','one')]);assert.equal(f.voices.length,1);
    f.audio.observe(f.snapshot([f.armed('a','two')]));f.audio.observe(f.snapshot([f.armed('a','three')]));assert.equal(f.voices.length,1);
    f.accept([f.idle()],'disarm');f.accept([f.armed('a','four')]);assert.equal(f.voices.length,2);
  }finally{f.audio.destroy();}
});

test('kiosk phase-only fallback cues observed transitions but never invents a missed cycle',()=>{
  const f=fixture();try{
    const noCycle=value=>{const {cycleId,...area}=value;return area;};f.audio.observe(f.snapshot([noCycle(f.idle())],{kiosk:true}));f.audio.gesture({pip:false});f.accept([noCycle(f.arming())]);f.audio.observe(f.snapshot([noCycle(f.armed())],{kiosk:true}));assert.equal(f.voices.length,2);f.audio.observe(f.snapshot([noCycle(f.armed())],{kiosk:true}));assert.equal(f.voices.length,2);
  }finally{f.audio.destroy();}
});

test('older server snapshots are ignored without regressing an accepted transition cache',()=>{
  const f=fixture();try{
    f.audio.observe(f.snapshot([f.idle()],{now:1000}));f.audio.gesture({pip:false});f.accept([f.arming()]);f.audio.observe(f.snapshot([f.idle()],{now:999}));f.audio.observe(f.snapshot([f.arming()],{now:4000}));assert.equal(f.voices.length,1);
    f.audio.observe(f.snapshot([f.armed()],{now:5000}));assert.equal(f.voices.length,2);
  }finally{f.audio.destroy();}
});

test('only very fresh cues may wait for gesture unlock; mute, hide and destroy cancel pending sound',async()=>{
  for(const operation of ['fresh','late','mute','hide','destroy']){
    const f=fixture({state:'suspended',resume:'defer'});try{
      f.audio.observe(f.snapshot([f.idle()]));f.audio.gesture();f.accept([f.arming()]);assert.equal(f.voices.length,0);
      if(operation==='late')f.advance(401);if(operation==='mute')f.audio.setEnabled(false);if(operation==='hide')f.audio.setVisible(false);if(operation==='destroy')f.audio.destroy();
      f.context.resolveResume();await flush();assert.equal(f.voices.length,operation==='fresh'?2:0,operation);
    }finally{f.audio.destroy();assert.equal(f.context.closed,1);assert.equal(f.timers.size,0);}
  }
});

test('unsupported, blocked autoplay and audio-node failures cannot escape into keypad commands',async()=>{
  for(const options of [{factoryFailure:true},{nodeFailure:true},{state:'suspended',resume:'reject'}]){
    const f=fixture(options);try{assert.doesNotThrow(()=>{f.audio.observe(f.snapshot([f.idle()]));f.audio.gesture();f.accept([f.arming()]);});await flush();assert.doesNotThrow(()=>f.audio.disconnect());}finally{assert.doesNotThrow(()=>f.audio.destroy());}
  }
});

test('destroy is idempotent and closes/disconnects the active context and both feedback voices',()=>{
  const f=fixture();f.audio.observe(f.snapshot([f.idle()]));f.audio.gesture();f.accept([f.arming()]);assert.equal(f.voices.length,2);f.audio.destroy();f.audio.destroy();assert.equal(f.context.closed,1);assert.ok(f.voices.every(voice=>voice.disconnected&&voice.gain.disconnected));assert.equal(f.timers.size,0);f.audio.gesture();assert.equal(f.voices.length,2);
});
