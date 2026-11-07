import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {Store} from '../server/store.mjs';
import {sendEmail} from '../server/collectors.mjs';

test('SMTP transport is verified against an isolated loopback mail sink',async()=>{
  const store=new Store();let accepted=0,content='';const sockets=new Set();
  const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.write('220 localhost test SMTP\r\n');let buffer='',dataMode=false;
    socket.on('data',b=>{buffer+=b.toString();let at;while((at=buffer.indexOf('\r\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+2);if(dataMode){if(line==='.'){dataMode=false;accepted++;socket.write('250 accepted locally\r\n');}else content+=line+'\n';continue;}if(/^EHLO|^HELO/.test(line))socket.write('250 localhost\r\n');else if(/^MAIL FROM|^RCPT TO/.test(line))socket.write('250 OK\r\n');else if(line==='DATA'){dataMode=true;socket.write('354 End with dot\r\n');}else if(line==='QUIT'){socket.end('221 Bye\r\n');}else socket.write('250 OK\r\n');}});
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{store.set('email',{enabled:true,host:'127.0.0.1',port:server.address().port,tlsMode:'none',sender:'test@localhost.invalid',recipient:'sink@localhost.invalid',username:''});await sendEmail(store,{subject:'Local test',text:'Synthetic incident only'});assert.equal(accepted,1);assert.match(content,/Synthetic incident only/);}finally{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));store.close();}
});
