const privateKey=/password|passwd|secret|token|authorization|credential|api[_-]?key|private[_-]?key/i;
function redact(value,depth=0){
  if(depth>4)return '[depth limit]';
  if(Array.isArray(value))return value.slice(0,12).map(x=>redact(x,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,30).map(([k,v])=>[k,privateKey.test(k)?'[redacted]':redact(v,depth+1)]));
  return typeof value==='string'?value.slice(0,500):value;
}
export function payloadPreview(bytes){
  if(bytes.length>16384)return '[large payload omitted]';
  let value;try{value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return '[binary payload omitted]';}
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))return '[binary payload omitted]';
  try{value=JSON.stringify(redact(JSON.parse(value)));}catch{
    value=value.replace(/((?:password|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi,'$1[redacted]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,'$1[redacted]@');
  }
  return value.length>1000?value.slice(0,1000)+'…':value;
}
export function validateTopics(input){
  const topics=typeof input==='string'?input.split(/\r?\n/).map(x=>x.trim()).filter(Boolean):input;
  if(!Array.isArray(topics)||topics.length>20||topics.some(t=>typeof t!=='string'||!t||t.length>200||/[\u0000\r\n]/.test(t)||t.split('/').some((part,i,all)=>part.includes('#')&&(part!=='#'||i!==all.length-1)||part.includes('+')&&part!=='+')))throw Error('Use up to 20 valid MQTT topic filters, one per line');
  return [...new Set(topics)];
}
export class TopicLog{
  constructor({clock=()=>Date.now(),limit=200}={}){this.clock=clock;this.limit=limit;this.entries=new Map();this.sequence=0;}
  add(networkId,topic,bytes,packet={}){const rows=this.entries.get(networkId)||[];rows.push({id:++this.sequence,at:this.clock(),topic:String(topic).slice(0,500),bytes:bytes.length,retained:packet.retain===true,qos:packet.qos||0,payload:payloadPreview(bytes)});if(rows.length>this.limit)rows.splice(0,rows.length-this.limit);this.entries.set(networkId,rows);}
  read(networkId){return [...(this.entries.get(networkId)||[])].reverse();}
  remove(networkId){this.entries.delete(networkId);}
}
