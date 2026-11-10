export const keypadSoundKey='zh-keypad-sound';
export const keyPipMs=50,transitionPipMs=1000;
const maximumObservationGap=10000,maximumPendingAge=400;
const notesByCue={
  key:[[880,0,keyPipMs/1000]],
  arming:[[660,0,transitionPipMs/1000]],
  armed:[[880,0,transitionPipMs/1000]],
  disarmFailed:[[520,0,.07],[370,.11,.08]],
  disarmed:[[660,0,.065],[830,.09,.065],[990,.18,.09]],
};
const isDisarmCue=kind=>kind==='disarmed'||kind==='disarmFailed';
export function readKeypadSound(storage){try{return (storage??globalThis.localStorage)?.getItem(keypadSoundKey)!=='off';}catch{return true;}}
export function writeKeypadSound(enabled,storage){try{(storage??globalThis.localStorage)?.setItem(keypadSoundKey,enabled?'on':'off');}catch{/* Sound preference can remain in memory. */}}
const phase=area=>['home','away'].includes(area.targetMode)||area.status==='exit_delay'?'arming':['home','away'].includes(area.mode)?'armed':'idle';
const record=area=>({phase:phase(area),cycle:typeof area.cycleId==='string'?area.cycleId:null});
const areaList=value=>Array.isArray(value)?value.filter(area=>area&&typeof area.id==='string'):[];
const scopeOf=state=>JSON.stringify({ids:areaList(state?.areas).map(area=>area.id).sort(),canArm:!!state?.canArm,canBypassArm:!!state?.canBypassArm,readOnly:!!state?.readOnly,kiosk:!!state?.kiosk});
function cueFor(previous,next){
  if(!previous)return null;
  if(next.phase==='arming'&&previous.phase!=='arming')return 'arming';
  if(next.phase==='armed'&&previous.phase==='idle')return 'armed';
  if(next.phase==='armed'&&previous.phase==='arming'&&(!previous.cycle||!next.cycle||previous.cycle===next.cycle))return 'armed';
  return null;
}
const stronger=(left,right)=>left==='armed'||right==='armed'?'armed':left||right;

/** Browser-local feedback only. No command, credential or network access. */
export function createKeypadAudio({enabled=true,visible=true,now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout,createContext,onStatus=()=>{}}={}){
  const factory=createContext||(()=>{const Context=globalThis.AudioContext||globalThis.webkitAudioContext;return Context?new Context():null;});
  let active=enabled,shown=visible,destroyed=false,context=null,resuming=null,unlocked=false,supported=null;
  let baseline=true,scope=null,lastAt=null,lastServerAt=null,states=new Map(),pipVoice=null,longVoice=null,pendingPip=null,pendingLong=null,pendingTimer=null;
  let disarmAttempt=null;
  const status=()=>({enabled:active,unlocked,supported});
  function notify(){if(!destroyed)try{onStatus(status());}catch{/* Feedback must not affect the keypad. */}}
  function clearPending(){pendingPip=null;pendingLong=null;if(pendingTimer!==null){clearTimer(pendingTimer);pendingTimer=null;}}
  function stopVoice(voice){if(!voice)return;try{voice.oscillator.onended=null;voice.oscillator.stop();}catch{}try{voice.oscillator.disconnect();}catch{}try{voice.gain.disconnect();}catch{}if(voice.timer!==null)clearTimer(voice.timer);}
  function silence(){clearPending();stopVoice(pipVoice);stopVoice(longVoice);pipVoice=null;longVoice=null;disarmAttempt=null;}
  function reset(){baseline=true;scope=null;lastAt=null;lastServerAt=null;states.clear();silence();}
  function tone(kind){
    if(destroyed||!active||!shown||!context||context.state!=='running')return false;
    const isPip=kind==='key',isDisarm=isDisarmCue(kind),notes=notesByCue[kind];
    const [,lastOffset,lastDuration]=notes.at(-1),duration=lastOffset+lastDuration;
    const volume=isPip?0.025:isDisarm?0.03:0.035;
    if(isPip||isDisarm){stopVoice(pipVoice);pipVoice=null;}
    if(!isPip){stopVoice(longVoice);longVoice=null;}
    let oscillator,gain;
    try{
      oscillator=context.createOscillator();gain=context.createGain();const start=context.currentTime;
      oscillator.type='sine';
      for(const [frequency,offset,length] of notes){
        const onset=start+offset,end=onset+length;
        oscillator.frequency.setValueAtTime(frequency,onset);
        gain.gain.setValueAtTime(0,onset);
        gain.gain.linearRampToValueAtTime(volume,onset+.004);
        gain.gain.setValueAtTime(volume,end-.008);
        gain.gain.linearRampToValueAtTime(0,end);
      }
      oscillator.connect(gain);gain.connect(context.destination);
      const voice={oscillator,gain,timer:null};
      const finish=()=>{try{oscillator.disconnect();}catch{}try{gain.disconnect();}catch{}if(voice.timer!==null)clearTimer(voice.timer);if(pipVoice===voice)pipVoice=null;if(longVoice===voice)longVoice=null;};
      oscillator.onended=finish;oscillator.start(start);oscillator.stop(start+duration);voice.timer=setTimer(finish,duration*1000+40);
      if(isPip)pipVoice=voice;else longVoice=voice;return true;
    }catch{try{oscillator?.disconnect();}catch{}try{gain?.disconnect();}catch{}return false;}
  }
  function drain(){
    const short=pendingPip,long=pendingLong;clearPending();
    if(destroyed||!active||!shown||!unlocked)return;
    if(short&&now()-short.at<=maximumPendingAge)tone('key');
    if(long&&now()-long.at<=maximumPendingAge)tone(long.kind);
  }
  function queue(kind){
    if(destroyed||!active||!shown)return;
    if(unlocked&&context?.state==='running'){tone(kind);return;}
    // Only a gesture already unlocking audio may carry a very fresh cue.
    if(!resuming)return;
    if(kind==='key')pendingPip={at:now()};
    else if(isDisarmCue(kind))pendingLong={kind,at:now()};
    else if(!isDisarmCue(pendingLong?.kind))pendingLong={kind:stronger(pendingLong?.kind,kind),at:now()};
    if(pendingTimer===null)pendingTimer=setTimer(clearPending,maximumPendingAge);
  }
  function unlock(){
    if(destroyed||!active||!shown)return;
    try{
      if(!context){context=factory();supported=!!context;if(!context){notify();return;}context.onstatechange=()=>{if(destroyed)return;unlocked=context.state==='running';notify();};}
      if(context.state==='running'){unlocked=true;notify();return;}
      if(resuming)return;
      resuming=Promise.resolve(context.resume()).then(()=>{resuming=null;if(destroyed)return;unlocked=context.state==='running';notify();drain();}).catch(()=>{resuming=null;clearPending();unlocked=false;notify();});
    }catch{clearPending();supported=false;unlocked=false;notify();}
  }
  function observe(state){
    if(destroyed)return null;
    const timestamp=now(),nextScope=scopeOf(state),areas=areaList(state?.areas),serverAt=Number.isFinite(state?.now)?state.now:null;
    if(serverAt!==null&&lastServerAt!==null&&serverAt<lastServerAt)return null;
    const quiet=baseline||!shown||scope!==nextScope||lastAt===null||timestamp-lastAt>maximumObservationGap||timestamp<lastAt;
    const next=new Map(areas.map(area=>[area.id,record(area)]));let cue=null;
    if(!quiet)for(const [id,value] of next)cue=stronger(cue,cueFor(states.get(id),value));
    states=next;scope=nextScope;lastAt=timestamp;lastServerAt=serverAt;baseline=!shown;
    if(quiet)silence();else if(cue)queue(cue);return quiet?null:cue;
  }
  function accepted(result){
    if(destroyed||!result?.ok||!['arm_away','arm_home','force_arm_away','disarm'].includes(result.action))return null;
    const timestamp=now(),areas=areaList(result.areas),quiet=baseline||!shown||lastAt===null||timestamp-lastAt>maximumObservationGap||areas.some(area=>!states.has(area.id));let cue=null;
    for(const area of areas){const next=record(area);if(!quiet&&result.action!=='disarm')cue=stronger(cue,cueFor(states.get(area.id),next));states.set(area.id,next);}
    lastAt=timestamp;if(quiet){baseline=true;silence();return null;}if(cue)queue(cue);return cue;
  }
  function beginDisarm(){
    if(destroyed||!active||!shown)return null;
    disarmAttempt=Symbol();
    return disarmAttempt;
  }
  function disarmOutcome({attempt,ok}={}){
    if(!attempt||attempt!==disarmAttempt||typeof ok!=='boolean')return null;
    disarmAttempt=null;
    const cue=ok?'disarmed':'disarmFailed';
    queue(cue);
    return cue;
  }
  return {
    gesture({pip=true}={}){unlock();if(pip)queue('key');},
    observe,accepted,beginDisarm,disarmOutcome,
    disconnect(){reset();},
    setVisible(value){const next=!!value;if(shown!==next){shown=next;reset();}},
    setEnabled(value){active=!!value;if(!active)silence();notify();},
    getStatus:status,
    destroy(){if(destroyed)return;destroyed=true;reset();if(context){context.onstatechange=null;try{Promise.resolve(context.close()).catch(()=>{});}catch{}}},
  };
}
