import {useEffect,useImperativeHandle,useRef,forwardRef} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {WebLinksAddon} from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {api,ApiError} from './api';
export type Connection='connecting'|'connected'|'offline';
export type TerminalHandle={send:(data:string)=>boolean;paste:(text:string,enter?:boolean)=>boolean;focus:()=>void;blur:()=>void;copy:()=>string;};
type Props={sessionId:string;fontSize:number;onStatus:(state:Connection)=>void;onExpired:()=>void;onExit:()=>void;transform:(data:string)=>string};
export const TerminalView=forwardRef<TerminalHandle,Props>(function TerminalView(props,ref){
 const container=useRef<HTMLDivElement>(null),terminal=useRef<Terminal|null>(null),socket=useRef<WebSocket|null>(null),ready=useRef(false),fitRef=useRef<(()=>void)|null>(null),latest=useRef(props); latest.current=props;
 useImperativeHandle(ref,()=>({send:(data)=>{if(!ready.current||socket.current?.readyState!==WebSocket.OPEN)return false;if(/^\x1b\[[ABCD]$/.test(data)&&terminal.current?.modes.applicationCursorKeysMode)data='\x1bO'+data.slice(-1);socket.current.send(JSON.stringify({type:'input',data}));return true;},paste:(text,enter=false)=>{if(!ready.current||socket.current?.readyState!==WebSocket.OPEN)return false;let data=text.replace(/\r?\n/g,'\r');if(data&&terminal.current?.modes.bracketedPasteMode)data='\x1b[200~'+data+'\x1b[201~';if(enter)data+='\r';socket.current.send(JSON.stringify({type:'input',data}));return true;},focus:()=>terminal.current?.focus(),blur:()=>terminal.current?.blur(),copy:()=>{const term=terminal.current;if(!term)return '';if(term.hasSelection())return term.getSelection();const buffer=term.buffer.active;let lines=[];for(let i=Math.max(0,buffer.length-2000);i<buffer.length;i++)lines.push(buffer.getLine(i)?.translateToString(true)||'');return lines.join('\n').trimEnd();}}),[]);
 useEffect(()=>{if(terminal.current){terminal.current.options.fontSize=props.fontSize;fitRef.current?.();}},[props.fontSize]);
 useEffect(()=>{
  const el=container.current!;
  const term=new Terminal({fontSize:latest.current.fontSize,fontFamily:'Menlo, Monaco, "SFMono-Regular", "Courier New", monospace',lineHeight:1.22,cursorBlink:true,cursorStyle:'block',scrollback:10000,allowProposedApi:false,convertEol:false,theme:{background:'#101214',foreground:'#eeeee8',cursor:'#eeeee8',selectionBackground:'#4b594c',black:'#202326',brightBlack:'#7a8088',green:'#b7e48b',brightGreen:'#c9eea8',blue:'#85b5d7',brightBlue:'#a3ccec',red:'#e78c83',brightRed:'#f7aba1',yellow:'#dfc98a',brightYellow:'#efdda8',cyan:'#8accc2',brightCyan:'#a7ddd5',magenta:'#c4a1d8',brightMagenta:'#d9b9eb',white:'#deded8',brightWhite:'#ffffff'}});
  const fit=new FitAddon();term.loadAddon(fit);term.loadAddon(new WebLinksAddon((_event,url)=>{if(/^https?:\/\//i.test(url))window.open(url,'_blank','noopener,noreferrer');}));term.open(el);terminal.current=term;
  // iOS uses the native textarea for IME and dictation. Avoid spell correction in shells.
  if(term.textarea){term.textarea.setAttribute('autocorrect','off');term.textarea.setAttribute('autocapitalize','off');term.textarea.setAttribute('spellcheck','false');term.textarea.setAttribute('aria-label','终端输入');}
  let disposed=false,retry=0,timer:ReturnType<typeof setTimeout>|undefined,resizeTimer:ReturnType<typeof setTimeout>|undefined,generation=0;
  const send=(value:unknown)=>{if(socket.current?.readyState===WebSocket.OPEN)socket.current.send(JSON.stringify(value));};
  const resize=()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(disposed)return;try{fit.fit();send({type:'resize',cols:term.cols,rows:term.rows});}catch{}},60);};
  fitRef.current=resize;const observer=new ResizeObserver(resize);observer.observe(el);
  let isPasting=false;const pasteStart=()=>{isPasting=true;queueMicrotask(()=>{isPasting=false;});};el.addEventListener('paste',pasteStart,true);const input=term.onData(data=>{if(ready.current)send({type:'input',data:!isPasting&&/^[ -~]$/.test(data)?latest.current.transform(data):data});});
  const dimensions=term.onResize(({cols,rows})=>send({type:'resize',cols,rows}));
  const schedule=()=>{if(disposed||document.hidden)return;clearTimeout(timer);timer=setTimeout(connect,Math.min(1000*2**retry++,15000));};
  const connect=async()=>{
   if(disposed||document.hidden)return; const run=++generation;ready.current=false;latest.current.onStatus(retry?'offline':'connecting');
   try{
    const {ticket}=await api<{ticket:string}>('/ticket','POST',{sessionId:props.sessionId});
    if(disposed||run!==generation||document.hidden)return;
    const ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws?ticket=${encodeURIComponent(ticket)}`);socket.current=ws;const deadline=setTimeout(()=>{if(!ready.current&&run===generation){ws.close();}},12000);
    ws.onopen=()=>{if(disposed||run!==generation){ws.close();return;}retry=0;term.reset();resize();};
    ws.onmessage=event=>{if(disposed||run!==generation)return;try{const message=JSON.parse(event.data);if(message.type==='ready'){clearTimeout(deadline);ready.current=true;latest.current.onStatus('connected');resize();}else if(message.type==='output'){term.write(message.data,()=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'ack',bytes:new TextEncoder().encode(message.data).length}));});}else if(message.type==='exit'){latest.current.onExit();}else if(message.type==='error'){latest.current.onStatus('offline');ws.close();}}catch{ws.close();}};
    ws.onclose=()=>{clearTimeout(deadline);if(disposed||run!==generation)return;ready.current=false;latest.current.onStatus('offline');schedule();};ws.onerror=()=>ws.close();
   }catch(error){if(disposed||run!==generation)return;if(error instanceof ApiError&&error.status===401){latest.current.onExpired();return;}if(error instanceof ApiError&&error.status===404){latest.current.onExit();return;}latest.current.onStatus('offline');schedule();}
  };
  const restart=()=>{if(disposed)return;ready.current=false;++generation;clearTimeout(timer);socket.current?.close();socket.current=null;if(!document.hidden){retry=0;void connect();}else latest.current.onStatus('offline');};
  document.addEventListener('visibilitychange',restart);window.addEventListener('online',restart);window.addEventListener('pageshow',restart);
  resize();void connect();
  return()=>{disposed=true;ready.current=false;fitRef.current=null;++generation;clearTimeout(timer);clearTimeout(resizeTimer);observer.disconnect();el.removeEventListener('paste',pasteStart,true);input.dispose();dimensions.dispose();document.removeEventListener('visibilitychange',restart);window.removeEventListener('online',restart);window.removeEventListener('pageshow',restart);socket.current?.close();socket.current=null;term.dispose();terminal.current=null;};
 },[props.sessionId]);
 return <div ref={container} className="terminal-canvas" aria-label="Mac 远程终端"/>;
});
