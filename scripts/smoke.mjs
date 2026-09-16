import fs from 'node:fs/promises';
import { WebSocket } from 'ws';
import {randomUUID} from 'node:crypto';
const origin=process.env.POCKET_SMOKE_ORIGIN||'https://terminal.dkz12345.com';
const password=(await fs.readFile(new URL('../.runtime/access-key.txt',import.meta.url),'utf8')).trim();
const headers={Origin:origin,'Content-Type':'application/json'};
const anon=await fetch(origin+'/api/sessions');if(anon.status!==401)throw new Error('Unauthenticated access did not fail closed');
const login=await fetch(origin+'/api/login',{method:'POST',headers,body:JSON.stringify({password})});if(!login.ok)throw new Error('Login failed '+login.status);
const cookie=login.headers.get('set-cookie').split(';')[0];headers.Cookie=cookie;
async function api(route,method='GET',body){const res=await fetch(origin+'/api'+route,{method,headers,body:body?JSON.stringify(body):undefined});if(!res.ok)throw new Error('API failed '+route+' '+res.status);return res.json();}
const {session}=await api('/sessions','POST',{name:'部署验收',cols:80,rows:24});let ws;
async function attach(){const {ticket}=await api('/ticket','POST',{sessionId:session.id});let output='';let readyResolve;const ready=new Promise(resolve=>readyResolve=resolve);ws=new WebSocket(origin.replace(/^http/,'ws')+'/ws?ticket='+ticket,{headers:{Origin:origin,Cookie:cookie}});ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='ready')readyResolve();if(m.type==='output'){output+=m.data;ws.send(JSON.stringify({type:'ack',bytes:Buffer.byteLength(m.data)}));}});await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('WS not ready')),15000).unref())]);return {get output(){return output;}};}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<120;i++){if(check())return;await sleep(100);}throw new Error('Terminal result timeout');}
try{
 let client=await attach();await sleep(400);
 const marker=randomUUID().replaceAll('-','');
 ws.send(JSON.stringify({type:'input',data:`export POCKET_LIVE='${marker}'; printf 'LIVE:%s\\n' "$POCKET_LIVE"; printf '中文终端\\n'; stty size\r`}));
 await until(()=>client.output.includes('LIVE:'+marker)&&client.output.includes('中文终端'));
 if(client.output.includes('locking failed'))throw new Error('Shell inherited restricted test environment');
 ws.close();await sleep(400);client=await attach();await sleep(300);
 ws.send(JSON.stringify({type:'resize',cols:50,rows:20}));await sleep(100);
 ws.send(JSON.stringify({type:'input',data:"printf 'RESUMED:%s\\n' \"$POCKET_LIVE\"; stty size\r"}));
 await until(()=>client.output.includes('RESUMED:'+marker)&&client.output.includes('20 50'));
 const {text}=await api(`/sessions/${session.id}/history`);if(!text.includes('LIVE:'+marker))throw new Error('History missing');
 const denied=await fetch(origin+'/api/ticket',{method:'POST',headers:{...headers,Origin:'https://example.invalid'},body:JSON.stringify({sessionId:session.id})});if(denied.status!==403)throw new Error('Cross-origin request accepted');
 console.log('PASS: HTTPS login, real Mac shell, Chinese, resize, reconnect persistence, history, anonymous/origin rejection');
}finally{ws?.close();await api(`/sessions/${session.id}`,'DELETE');await api('/logout','POST');}
