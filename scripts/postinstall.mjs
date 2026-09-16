import {chmod,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
if(process.platform==='darwin'){
 const helper=fileURLToPath(new URL(`../node_modules/node-pty/prebuilds/darwin-${process.arch}/spawn-helper`,import.meta.url));
 try{const info=await stat(helper);await chmod(helper,info.mode|0o100);}catch(error){if(error.code!=='ENOENT')throw error;}
}
