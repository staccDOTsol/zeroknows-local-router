import {mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('.',import.meta.url)));
mkdirSync('logs',{recursive:true});
for(const args of [['--test','test-model-router.mjs'],['--test','test-model-catalog.mjs'],['--test','test-session-memory.mjs'],['test-concurrency.mjs'],['test-replay-recovery.mjs']]){
 const result=spawnSync(process.execPath,args,{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);
}
// Retrieval tests are required, not silently skipped when Python/NumPy is missing.
const python=process.env.LOCAL_ROUTER_PYTHON||(process.platform==='win32'?'python':'python3');
for(const args of [['-m','unittest','discover','-s','vendor/lecore','-p','test_*.py'],['test-session-memory-worker.py']]){
 const result=spawnSync(python,args,{stdio:'inherit'});
 if(result.error)console.error('Retrieval tests require Python 3.11+ and NumPy 2.x:',result.error.message);
 if(result.status!==0)process.exit(result.status||1);
}
if(process.platform==='win32'){
 const result=spawnSync('pwsh',['-NoProfile','-File','test-controller.ps1'],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);
}
