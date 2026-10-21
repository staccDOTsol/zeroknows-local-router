// Opt-in, background pinned GGUF discovery. Never downloads or edits the source registry.
import {open,readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {constants,createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {artifactPaths,validateManifest,inspectPath} from './download-models.mjs';
import {validateRegistry} from './model-router.mjs';
import {readGGUFProfile} from './gguf-profile.mjs';
import {readJSON} from './gateway-runtime.mjs';

async function atomic(file,value){
 await inspectPath(file);await mkdir(path.dirname(file),{recursive:true});
 try{const prior=JSON.parse(await readFile(file,'utf8'));if(prior.startupDiscoveryManaged!==1)throw Error('Refusing to overwrite unmanaged startup artifact: '+file);}catch(error){if(error.code!=='ENOENT')throw error;}
 const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify({...value,startupDiscoveryManaged:1},null,2)+'\n',{flag:'wx'});await rename(tmp,file);
}
export async function verifyPinned(file,artifact){
 const info=await inspectPath(file);
 if(!info.stat?.isFile()||info.stat.size!==artifact.bytes)throw Error('missing_or_incomplete');
 const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{
  const before=await handle.stat(),hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let offset=0;
  for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}
  const after=await handle.stat();
  if(offset!==artifact.bytes||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino)throw Error('file_changed_during_verification');
  if(hash.digest('hex')!==artifact.sha256)throw Error('hash_mismatch');
 }finally{await handle.close();}
}
export async function smokeText(instance,model,{fetchImpl=fetch,timeoutMs=30000}={}){
 const response=await fetchImpl(`http://127.0.0.1:${instance.port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(timeoutMs),body:JSON.stringify({model:model.id,messages:[{role:'user',content:'Reply with the word OK.'}],max_tokens:16,temperature:0,stream:false})});
 if(!response.ok)throw Error(`smoke_http_${response.status}`);
 const value=await readJSON(response,65536);
 if(value.error||!value.choices?.some(c=>typeof c.message?.content==='string'&&c.message.content.trim()&&['stop','length'].includes(c.finish_reason)))throw Error('smoke_missing_completed_text');
}
export function startDiscovery(pool,options,{root,profile=readGGUFProfile,verify=verifyPinned,smoke=smokeText}={}){
 const report={state:'discovering',models:[],promoted:[],scope:'general_text_only; no tools/vision/quality claims'};
 pool.discovery=report;
 const resolve=p=>path.resolve(root,p);
 const reportPath=resolve('logs/startup-discovery.json'),overlayPath=resolve('logs/startup-model-registry.json'),journalPath=resolve('logs/startup-verified.jsonl');
 const save=()=>atomic(reportPath,report);
 const work=(async()=>{
  if(!options||typeof options.modelRoot!=='string'||typeof options.manifest!=='string')throw Error('startupDiscovery requires modelRoot and manifest');
  const context=options.context??4096,portStart=options.portStart??8300,maxCandidates=options.maxCandidatesPerRun??0,idleGraceMs=options.idleGraceMs??5000;
  if(!Number.isInteger(idleGraceMs)||idleGraceMs<0||idleGraceMs>60000)throw Error('idleGraceMs must be 0..60000');
  if(!Number.isInteger(maxCandidates)||maxCandidates<0||maxCandidates>10)throw Error('maxCandidatesPerRun must be 0..10');
  if(![2048,4096].includes(context)||!Number.isInteger(portStart)||portStart<1024||portStart>65000)throw Error('Invalid startupDiscovery context or portStart');
  const manifest=validateManifest(JSON.parse(await readFile(resolve(options.manifest),'utf8')));
  if(manifest.kind)throw Error('Conversion staging is never runtime eligible');
  const runtime=resolve(pool.registry.serverPath);await inspectPath(runtime);const runtimeHash=createHash('sha256');
  for await(const chunk of createReadStream(runtime))runtimeHash.update(chunk);
  pool.registry.startupRuntimeSha256=runtimeHash.digest('hex');
  if(!pool.registry.runtimeId)pool.registry.runtimeId='sha256:'+pool.registry.startupRuntimeSha256;
  let cached;try{await inspectPath(overlayPath);const value=JSON.parse(await readFile(overlayPath,'utf8'));if(value.startupDiscoveryManaged===1)cached=validateRegistry(value);}catch{}
  const existing=new Set(pool.registry.models.map(m=>m.id)),ports=new Set(pool.registry.models.flatMap(m=>m.ports));
  let port=portStart,validated=0,halt=false;
  await new Promise(resolve=>setTimeout(resolve,idleGraceMs));
  for(const artifact of manifest.artifacts){
   if(artifact.role!=='generation')continue;
   const row={id:artifact.modelId,state:'discovered'};report.models.push(row);
   // Existing operator definitions (including explicit disablement) always win.
   if(existing.has(artifact.modelId)){row.state='existing_registry_preserved';continue;}
   const file=artifactPaths(resolve(options.modelRoot),artifact).final;
   row.path=file;
   try{
    await verify(file,artifact);row.state='hash_verified';await save();
    const sizing=await profile(file,{context});
    while(ports.has(port))port++;if(port>65535)throw Error('No available configured port');
    const model={id:artifact.modelId,ports:[port++],...sizing,weightBytes:artifact.bytes,files:[{path:file,bytes:artifact.bytes,sha256:artifact.sha256,role:'model',verificationJournal:journalPath}],tasks:['general'],rank:{general:99},routing:{auto:false,mode:'text',compatibility:{status:'unverified'},capabilities:{text:false,tools:false,vision:false,json:false,embedding:false}}};
    const prior=cached?.startupRuntimeSha256===pool.registry.startupRuntimeSha256&&cached?.runtimeId===pool.registry.runtimeId?cached.models.find(m=>m.id===model.id):null;
    const reusable=prior?.routing?.compatibility?.smokeVersion===1&&prior.routing.compatibility.status==='verified'&&prior.routing.compatibility.runtimeId===pool.registry.runtimeId&&prior.files.length===1&&prior.files[0].sha256===artifact.sha256&&['context','nativeContext','kvBytesPerToken','weightBytes','fixedCacheMiB','promptCacheGiB'].every(k=>prior[k]===model[k]);
    if(reusable)model.routing={...model.routing,auto:true,compatibility:structuredClone(prior.routing.compatibility),capabilities:{...model.routing.capabilities,text:true}};
    const next=structuredClone(pool.registry);next.models.push(model);validateRegistry(next);
    const recordVerification=async()=>{
     await inspectPath(journalPath);await mkdir(path.dirname(journalPath),{recursive:true});
     const journal=await open(journalPath,constants.O_APPEND|constants.O_CREAT|constants.O_WRONLY|(constants.O_NOFOLLOW||0));
     try{await journal.writeFile(JSON.stringify({path:file,sha256:artifact.sha256,bytes:artifact.bytes,verifiedAt:new Date().toISOString()})+'\n');}finally{await journal.close();}
    };
    if(reusable){
     await recordVerification();
     await pool.exclusive(async()=>{await atomic(overlayPath,next);pool.controller.registryPath=overlayPath;pool.registry.models.push(model);existing.add(model.id);ports.add(model.ports[0]);});
     row.state='restored_general_text';report.promoted.push(model.id);await save();continue;
    }
    row.state='pending_runtime_validation';
    // Optional explicit batch is bounded; default startup never loads new candidates.
    if(validated>=maxCandidates||halt){row.reason=halt?'prior_runtime_failure_requires_inspection':'startup_validation_budget_reached; retry on next relaunch';continue;}
    await pool.exclusive(async()=>{
     await pool.refresh(true);
     if(pool.closed||pool.loading||pool.waiters||pool.instances.some(i=>pool.active(i)>0)){row.reason='gateway_busy; deferred_until_relaunch';return;}
     if(pool.required(model)>pool.freeBytes){row.reason='insufficient_memory_with_16GiB_headroom';return;}
     if(!pool.registry.runtimeId){row.reason='configure_exact_runtimeId_before_validation';return;}
     validated++;
     await recordVerification();
     await atomic(overlayPath,next);
     pool.controller.registryPath=overlayPath;
     let instance;
     try{
      row.state='validating';pool.loading={model:model.id,replica:0,slots:1,validation:true};await save();
      instance=await pool.controller.start(model,0,1,true);
      await smoke(instance,model);
      await pool.controller.stop(instance);instance=null;
      model.routing={...model.routing,auto:true,compatibility:{status:'verified',runtimeId:pool.registry.runtimeId,evidence:reportPath,smokeVersion:1,validatedAt:new Date().toISOString()},capabilities:{...model.routing.capabilities,text:true}};
      next.models[next.models.length-1]=model;await atomic(overlayPath,next);
      pool.registry.models.push(model);existing.add(model.id);ports.add(model.ports[0]);row.state='promoted_general_text';row.runtimeId=pool.registry.runtimeId;row.validatedContext=model.context;row.validatedAt=new Date().toISOString();report.promoted.push(model.id);
     }catch(error){
      row.state='runtime_validation_failed';row.reason=error.message;
      if(instance){try{await pool.controller.stop(instance);instance=null;}catch(cleanup){row.cleanup=cleanup.message;}}
      // A timed-out/unhealthy process may still exist. Never kill it or load another.
      halt=true; // Keep the overlay controller tracking any retained validation process.
     }finally{pool.loading=null;await pool.refresh(true);}
    });
   }catch(error){row.state='pending';row.reason=error.message;}
   await save();
  }
  report.state=report.models.some(m=>m.state==='pending_runtime_validation')?'paused':'complete';await save();
 })().catch(async error=>{report.state='failed';report.error=error.message;try{await save();}catch{};});
 pool.discoveryDone=work;return work;
}
