import {mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('.',import.meta.url)));
mkdirSync('logs',{recursive:true});
for(const args of [['--test','test-model-router.mjs'],['test-concurrency.mjs'],['test-replay-recovery.mjs']]){
 const result=spawnSync(process.execPath,args,{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);
}
if(process.platform==='win32'){
 const result=spawnSync('pwsh',['-NoProfile','-File','test-controller.ps1'],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);
}
