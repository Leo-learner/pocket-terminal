import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const install=process.argv.includes('--install');
const root=install?path.join(os.homedir(),'Library/Application Support/PocketTerminal'):sourceRoot;
if(install){
 await fs.mkdir(root,{recursive:true,mode:0o700});
 for(const name of ['server','dist','node_modules','package.json'])await fs.cp(path.join(sourceRoot,name),path.join(root,name),{recursive:true,force:true});
 await fs.mkdir(path.join(root,'.runtime'),{recursive:true,mode:0o700});
 for(const name of ['auth.json','access-key.txt','tunnel_ed25519','tunnel_ed25519.pub']){const target=path.join(root,'.runtime',name);try{await fs.stat(target);}catch{await fs.copyFile(path.join(sourceRoot,'.runtime',name),target);await fs.chmod(target,0o600);}}
}
const privateDir=path.join(root,'.runtime');
await fs.mkdir(privateDir,{recursive:true,mode:0o700});
const key=path.join(privateDir,'tunnel_ed25519');
try{await fs.stat(key);}catch{execFileSync('/usr/bin/ssh-keygen',['-q','-t','ed25519','-N','','-C','pocket-terminal-tunnel','-f',key],{stdio:'ignore'});}
const knownHosts=path.join(privateDir,'known_hosts');
// Copy only the already-verified host entry; never disable SSH host verification.
const trusted=execFileSync('/usr/bin/ssh-keygen',['-F','20.48.14.96','-f',path.join(os.homedir(),'.ssh/known_hosts')],{encoding:'utf8'});
if(!trusted.includes('ssh-')&&!trusted.includes('ecdsa-'))throw new Error('Verified server host key not found');
await fs.writeFile(knownHosts,trusted,{mode:0o600});
const env={PATH:`${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,HOME:os.homedir(),SHELL:'/bin/zsh',LANG:'en_US.UTF-8',POCKET_CONFIG:path.join(privateDir,'auth.json'),POCKET_ORIGIN:'https://terminal.dkz12345.com',POCKET_TRUST_PROXY:'true'};
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const string=s=>`<string>${esc(s)}</string>`;
const plist=(label,args,environment={})=>`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key>${string(label)}<key>ProgramArguments</key><array>${args.map(string).join('')}</array><key>WorkingDirectory</key>${string(root)}<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key,value])=>`<key>${esc(key)}</key>${string(value)}`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key>${string(path.join(privateDir,label+'.log'))}<key>StandardErrorPath</key>${string(path.join(privateDir,label+'.error.log'))}</dict></plist>`;
const jobs=[['com.leo.pocket-terminal', [process.execPath,path.join(root,'server/index.mjs')],env],['com.leo.pocket-terminal-tunnel',['/usr/bin/ssh','-N','-T','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${knownHosts}`,'-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3','-o','ConnectTimeout=12','-i',key,'-R','127.0.0.1:43210:127.0.0.1:4321','pocket-tunnel@20.48.14.96'],{}]];
const directory=install?path.join(os.homedir(),'Library/LaunchAgents'):path.join(privateDir,'launchagents');
await fs.mkdir(directory,{recursive:true});
for(const [label,args,environment] of jobs){const filename=path.join(directory,label+'.plist');await fs.writeFile(filename,plist(label,args,environment),{mode:0o600});execFileSync('/usr/bin/plutil',['-lint',filename]);if(install){try{execFileSync('/bin/launchctl',['bootout',`gui/${process.getuid()}`,filename],{stdio:'ignore'});}catch{}execFileSync('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,filename],{stdio:'inherit'});}}
process.stdout.write(`Mac ${install?'services installed':'configuration prepared'}. Tunnel public key: ${key}.pub\n`);
