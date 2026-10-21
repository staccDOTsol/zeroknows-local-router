import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {GatewayError,localURL} from './gateway-runtime.mjs';
import {validateRoutingPolicy,eligibility,compatibilityReasons,memoryEstimate,scoreCandidates,parallelSlots,HEADROOM_BYTES,SERVE_FLOOR_BYTES} from './routing-policy.mjs';
const GiB=1024**3;
const root=fileURLToPath(new URL('.',import.meta.url));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(promise,signal,ms){
 let timer,cancel;
 try{return await Promise.race([promise,new Promise((_,reject)=>{cancel=()=>reject(signal.reason);if(signal?.aborted)return cancel();signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(()=>reject(new GatewayError(503,'Local admission queue deadline exceeded; an already-started load may finish in the background')),Math.max(1,ms));})]);}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}

// Deterministic task routing, not a quality classifier or a refusal detector.
export function classify(body,path){
 let bytes=0,images=0,unsupported=false,tools=false,text='';
 function walk(value,key=''){
  if(value===undefined)return;
  if(value===null){bytes+=4;return;}
  if(Array.isArray(value)){bytes+=value.length+2;for(const part of value)walk(part,key);return;}
  if(typeof value==='object'){
   if(/audio|video|file/.test(value.type||''))unsupported=true;
   if(['function_call','function_call_output','custom_tool_call','custom_tool_call_output','tool_use','tool_result'].includes(value.type)||['tool','function'].includes(value.role)||value.tool_calls||value.function_call)tools=true;
   if(['input_image','image_url'].includes(value.type)){
    images++;const url=typeof value.image_url==='string'?value.image_url:value.image_url?.url;
    if(!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url||''))throw new GatewayError(400,'Images must be local PNG/JPEG/WebP data URLs; remote URLs and file references are unsupported');
    return;
   }
   // Include schema keys, punctuation and non-string primitives, not just text.
   bytes+=2;for(const [k,v] of Object.entries(value)){bytes+=Buffer.byteLength(JSON.stringify(k))+2;walk(v,k);}return;
  }
  if(typeof value==='string'){bytes+=Buffer.byteLength(JSON.stringify(value));if(['text','content','input'].includes(key))text+=' '+value;}
  else bytes+=String(value).length;
 }
 walk(body.input??body.messages??'', 'input');walk(body.instructions,'text');walk(body.tools);walk(body.tool_choice);walk(body.response_format);walk(body.text?.format);
 if(unsupported)throw new GatewayError(415,'Audio, video and file inputs are not supported by these local backends');
  const output=body.max_output_tokens??body.max_completion_tokens??body.max_tokens??2048;
 if(!Number.isInteger(output)||output<1||output>10485760)throw new GatewayError(400,'Output token limit must be an integer from 1 to 10485760');
 const embedding=path==='/v1/embeddings';
 if(embedding&&(!(typeof body.input==='string'||Array.isArray(body.input)&&body.input.every(x=>typeof x==='string'))||body.encoding_format&&body.encoding_format!=='float'))throw new GatewayError(400,'Embeddings require text input and float output encoding');
 if(embedding&&images)throw new GatewayError(415,'This embedding model accepts text only');
 // ~3 serialized JSON bytes per token (measured Codex traffic is ~3.8) plus framing. No input is trimmed;
 // a backend context overflow still fails over before output via exceed_context_size_error.
 const inputTokens=Math.ceil(bytes/3)+512+images*16384,outputTokens=embedding?0:output,tokens=inputTokens+outputTokens;
 const task=embedding?'embedding':images?'vision':/```|\b(code|coding|debug|function|typescript|python|javascript|compile|repository|refactor|sql)\b/i.test(text)?'coding':/\b(reason|prove|math|calculate|analyse|analyze|solve)\b/i.test(text)?'reasoning':'general';
 const format=body.response_format?.type??body.text?.format?.type;
 const requirements=[embedding?'embedding':'text',...(images?['vision']:[]),...(tools||body.tools?.length?['tools']:[]),...(['json_object','json_schema'].includes(format)?['json']:[])];
 // Text requests that carry tools are agent work, whatever their wording.
 const agent=!embedding&&!images&&requirements.includes('tools');
 return {task,agent,tokens,inputTokens,outputTokens,images,requirements,estimate:'serialized UTF-8 bytes/3 + framing + output + image allowance'};
}

export function readRegistry(path){
 return validateRegistry(JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,'')));
}
export function validateRegistry(registry){
 if(registry.memoryMode!=='uma'||typeof registry.serverPath!=='string'||!Number.isInteger(registry.idleEvictMs)||registry.idleEvictMs<60000)throw Error('Configure a UMA runtime and an idle eviction interval of at least 60 seconds');
 if(!Array.isArray(registry.models)||!registry.models.length||registry.models.length>32)throw Error('Configure 1..32 local models');
 const ids=new Set(),ports=new Set();
 for(const m of registry.models){
  if(!/^[a-z0-9](?:[a-z0-9-]|\.(?!\.))+$/.test(m.id)||ids.has(m.id))throw Error('Invalid/duplicate model id');ids.add(m.id);
  if(!Number.isInteger(m.context)||m.context<512||m.context>m.nativeContext)throw Error('Invalid/native-exceeding context');
  if(!Number.isSafeInteger(m.nativeContext)||m.nativeContext>10485760)throw Error('Invalid native context');
  if(!Array.isArray(m.tasks)||!m.tasks.length||m.tasks.some(t=>!['general','reasoning','coding','vision','embedding'].includes(t)))throw Error('Invalid model task capabilities');
  if(!Number.isSafeInteger(m.kvBytesPerToken)||m.kvBytesPerToken<=0||!Number.isSafeInteger(m.weightBytes)||m.weightBytes<=0)throw Error('Verified positive weight and KV accounting is required');
  for(const key of ['fixedCacheMiB','promptCacheGiB'])if(!Number.isSafeInteger(m[key])||m[key]<0)throw Error('Invalid cache accounting');
  if(!Array.isArray(m.files)||!m.files.length||m.files.some(f=>!Number.isSafeInteger(f.bytes)||f.bytes<=0||!/^[a-f0-9]{64}$/i.test(f.sha256)||typeof f.path!=='string'||typeof f.verificationJournal!=='string'||!['model','projector'].includes(f.role)))throw Error('Verified local file sizes, SHA256 values, roles and journal paths are required');
  if(m.files.reduce((n,f)=>n+f.bytes,0)!==m.weightBytes)throw Error('Weight bytes must include all model and projector files');
  if(m.tasks.includes('embedding')){
   if(!Number.isInteger(m.embeddingDimensions)||m.embeddingDimensions<1)throw Error('Embedding models require a verified vector dimension');
   m.embeddingIdentity=`${m.id}:sha256:${createHash('sha256').update(m.files.map(f=>f.sha256.toLowerCase()).join(':')).digest('hex')}`;
  }
  if(!Array.isArray(m.ports)||m.ports.length<1||m.ports.length>2)throw Error('One or two bounded instance ports required');
  for(const p of m.ports){if(!Number.isInteger(p)||p<1024||p>65535||ports.has(p))throw Error('Invalid/duplicate instance port');ports.add(p);}
 }
 validateRoutingPolicy(registry);
 return registry;
}

export class WindowsController{
 constructor(registryPath,powershell='pwsh'){this.registryPath=registryPath;this.powershell=powershell;}
 async run(action,model='',replica=0,slots=1,automatic=false){
  const args=['-NoProfile','-File',root+'instance-control.ps1','-Registry',this.registryPath,'-Action',action];
  if(model)args.push('-Model',model,'-Replica',String(replica),'-Slots',String(slots));
  if(automatic)args.push('-Automatic');
  // Windows descendants can retain inherited pipe handles after PowerShell exits.
  // Resolve on the helper's exit, not child_process execFile's stdio-close event.
  const stdout=await new Promise((resolve,reject)=>{
   const child=spawn(this.powershell,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',errors='',done=false;
   const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);child.stdout.destroy();child.stderr.destroy();if(error)reject(error);else resolve(output);};
   const timer=setTimeout(()=>{child.kill();finish(new GatewayError(504,'Instance controller timeout; inspect ownership records before retrying'));},1860000);
   child.stdout.on('data',chunk=>{output+=chunk;if(output.length>2*1024*1024){child.kill();finish(new Error('Controller output limit exceeded'));}});
   child.stderr.on('data',chunk=>{if(errors.length<8192)errors+=chunk;});
   child.on('error',finish);child.on('exit',code=>setTimeout(()=>finish(code===0?null:new GatewayError(503,`Instance controller exited ${code}: ${errors}`)),25));
  });
  const result=JSON.parse(stdout.replace(/^\uFEFF/,''));
  if(result.error)throw new GatewayError(result.status||503,result.error);
  return result;
 }
 status(){return this.run('Status');}
 start(m,replica,slots,automatic){return this.run('Start',m.id,replica,slots,automatic);}
 stop(instance){return this.run('Stop',instance.model,instance.replica);}
 pin(instance){return this.run('Pin',instance.model,instance.replica);}
}

export class ModelPool{
 constructor(registry,controller,{queueMs=120000,maxQueued=8,pollMs=1000,now=()=>Date.now()}={}){
  this.registry=registry;this.controller=controller;this.queueMs=queueMs;this.maxQueued=maxQueued;this.pollMs=pollMs;this.now=now;
  this.affinity=new Map();this.instances=[];this.inventory=[];this.freeBytes=0;this.pending=new Map();this.leases=new Map();this.lastUsed=new Map();this.draining=new Set();this.serial=Promise.resolve();this.refreshing=null;this.refreshed=0;this.events=[];this.loading=null;this.waiters=0;this.closed=false;
 }
 async refresh(force=false){
  if(!force&&this.refreshed&&this.now()-this.refreshed<1000)return;
  if(!this.refreshing)this.refreshing=this.controller.status().then(s=>{this.instances=s.instances;for(const i of s.instances)if(!this.lastUsed.has(i.key))this.lastUsed.set(i.key,this.now());this.inventory=s.models;this.freeBytes=s.freeBytes;this.refreshed=this.now();}).finally(()=>this.refreshing=null);
  await this.refreshing;
 }
 event(type,details){this.events.push({time:new Date(this.now()).toISOString(),type,...details});this.events=this.events.slice(-20);}
 exclusive(fn){const next=this.serial.then(fn);this.serial=next.catch(()=>{});return next;}
 candidates(body,path,exclude=[]){
  const info=classify(body,path),explicit=body.model!=='auto';
  if(typeof body.model!=='string')throw new GatewayError(400,'An explicit model id or model="auto" is required');
  const considered=this.registry.models.filter(m=>(!explicit||m.id===body.model)&&!exclude.includes(m.id));
  const rejected=[];
  let candidates=considered.filter(m=>{const reasons=eligibility(m,info,this.registry,{automatic:!explicit,now:this.now()});if(reasons.length)rejected.push({id:m.id,reasons});return !reasons.length;});
  if(info.task==='embedding'){
   if(!explicit){const selected=this.registry.embeddingModel||(candidates.length===1?candidates[0].id:null);candidates=candidates.filter(m=>m.id===selected);}
   if(body.embedding_identity)candidates=candidates.filter(m=>m.embeddingIdentity===body.embedding_identity);
  }
  if(!candidates.length)throw new GatewayError(explicit?422:503,`No compatible local model for ${info.task}, estimated ${info.tokens} context tokens; input was not truncated${rejected.length?'; '+rejected.map(m=>m.id+': '+m.reasons.join(', ')).join('; '):''}`);
  // Agent work goes only to coding-capable models when any is eligible, so least-busy
  // spreading never hands a tool loop to a small chat model that refuses or stalls.
  if(info.agent&&!explicit){const coders=candidates.filter(m=>m.tasks.includes('coding'));if(coders.length)candidates=coders;}
  const key=info.agent?'coding':info.task;
  candidates.sort((a,b)=>(a.rank?.[key]??a.rank?.[info.task]??99)-(b.rank?.[key]??b.rank?.[info.task]??99));
  return {candidates,info,explicit,rejected};
 }
 required(m,slots=1){return memoryEstimate(m,{tokens:m.context},slots).coldRequiredBytes;}
 async explain(body,path){await this.refresh();const {candidates,info,explicit,rejected}=this.candidates(body,path);return {mode:explicit?'explicit':'auto',task:info.task,estimated_tokens:info.tokens,requirements:info.requirements,rejected,candidates:scoreCandidates(this,candidates,info).map(row=>row.explanation)};}
 usable(m,requiredContext=0){return this.draining.has(m.id)?[]:this.instances.filter(i=>i.model===m.id&&i.ready&&(i.context??m.context)>=requiredContext);}
 active(i){return this.leases.get(i.key)||0;}
  async status(){await this.refresh();return {version:2,routing_policy_version:this.registry.routingPolicy?.version??1,free_ram_gib:this.freeBytes/GiB,headroom_gib:HEADROOM_BYTES/GiB,loading:this.loading,queued:this.waiters,instances:this.instances.map(i=>({...i,active:this.active(i),last_used:this.lastUsed.get(i.key)||null})),models:this.registry.models.map(m=>({id:m.id,context:m.context,native_context:m.nativeContext,tasks:m.tasks,embedding_identity:m.embeddingIdentity,embedding_dimensions:m.embeddingDimensions,ready:!!this.inventory.find(x=>x.id===m.id)?.ready,compatibility:m.routing?.compatibility?.status||'legacy_operator_configured',automatic_routing:!compatibilityReasons(m,this.registry,{automatic:true}).length,routing_blockers:compatibilityReasons(m,this.registry),quality:m.routing?.evaluations?.length?'recorded_requires_task_match':'unverified',required_gib:this.required(m)/GiB})),events:this.events};}
 async ensure(m,automatic,replicate=false,signal,requiredContext=0){
  return this.exclusive(async()=>{
   const blockers=compatibilityReasons(m,this.registry);if(blockers.length)throw new GatewayError(422,`${m.id}: ${blockers.join(', ')}`);
   if(signal?.aborted)throw signal.reason;
   await this.refresh(true);
   const instances=this.usable(m,requiredContext);
   if(!replicate&&instances.length)return instances[0];
   if(instances.some(i=>this.active(i)<i.slots))return instances.find(i=>this.active(i)<i.slots);
   const used=new Set(this.instances.filter(i=>i.model===m.id).map(i=>i.replica));
   const replica=m.ports.findIndex((_,idx)=>!used.has(idx));
   if(replica<0)return null;
   if(!this.inventory.find(x=>x.id===m.id)?.ready)throw new GatewayError(503,`${m.id}: local files missing or unverified`);
   // Parallel slots share one unified KV pool, so concurrent conversations keep their own
   // cached state without extra memory; the count comes from parallelSlots().
   const slots=parallelSlots(m);
   if(this.required(m,slots)>this.freeBytes&&automatic){
    const idle=this.instances.filter(i=>i.automatic&&this.active(i)===0&&i.model!==m.id&&this.now()-(this.lastUsed.get(i.key)||this.now())>this.registry.idleEvictMs).sort((a,b)=>(this.lastUsed.get(a.key)||0)-(this.lastUsed.get(b.key)||0));
    for(const instance of idle){
     this.draining.add(instance.model);
     try{if(this.active(instance)>0||(this.pending.get(instance.model)||0)>0)continue;await this.controller.stop(instance);this.event('evicted_idle',{model:instance.model,instance:instance.key});await this.refresh(true);}finally{this.draining.delete(instance.model);}
     if(this.required(m,slots)<=this.freeBytes)break;
    }
   }
   if(this.required(m,slots)>this.freeBytes)throw new GatewayError(507,`${m.id}: estimated ${ (this.required(m,slots)/GiB).toFixed(2)} GiB free required including ${HEADROOM_BYTES/GiB} GiB headroom; available ${(this.freeBytes/GiB).toFixed(2)} GiB`);
   this.loading={model:m.id,replica,slots};this.event('loading',this.loading);
   try{if(signal?.aborted)throw signal.reason;const instance=await this.controller.start(m,replica,slots,automatic);this.lastUsed.set(instance.key,this.now());await this.refresh(true);this.event('ready',{model:m.id,instance:instance.key});return instance;}
   finally{this.loading=null;}
  });
 }
 async acquire(body,path,signal,exclude=[]){
  const {candidates,info,explicit,rejected}=this.candidates(body,path,exclude);
  const sessionKey=typeof body.prompt_cache_key==='string'&&body.prompt_cache_key?body.prompt_cache_key:null;
  if(this.waiters>=this.maxQueued)throw new GatewayError(429,'Local model admission queue is full');
  this.waiters++;for(const m of candidates)this.pending.set(m.id,(this.pending.get(m.id)||0)+1);
  const until=this.now()+this.queueMs;let last='No eligible instance has free capacity';
  try{
   while(this.now()<until){
    if(signal?.aborted)throw signal.reason;await bounded(this.refresh(),signal,until-this.now());
    if(signal?.aborted)throw signal.reason;
    const ranked=scoreCandidates(this,candidates,info);
    // Conversation affinity: later turns of a conversation (Codex prompt_cache_key) go back
    // to the instance holding its cached prefix; moving it would re-read the whole prompt.
    const sticky=sessionKey?this.affinity.get(sessionKey):null;
    if(sticky){const at=ranked.findIndex(row=>row.model.id===sticky.model);if(at>0)ranked.unshift(...ranked.splice(at,1));}
    for(const {model:m,explanation} of ranked){
     const open=this.usable(m).filter(i=>this.active(i)<i.slots&&(i.context??m.context)>=info.tokens);
     const instance=(sticky&&sticky.model===m.id&&open.find(i=>i.key===sticky.instance))||open[0];
     if(instance&&this.freeBytes>=SERVE_FLOOR_BYTES){
      this.leases.set(instance.key,this.active(instance)+1);this.lastUsed.set(instance.key,this.now());let released=false;
      if(sessionKey){this.affinity.delete(sessionKey);this.affinity.set(sessionKey,{model:m.id,instance:instance.key});if(this.affinity.size>4096)this.affinity.delete(this.affinity.keys().next().value);}
      this.event('route',{model:m.id,instance:instance.key,task:info.task,mode:explicit?'explicit':'auto',selection:explanation,alternatives:ranked.filter(row=>row.model.id!==m.id).map(row=>row.explanation),rejected});
      return {model:m.id,instance,selection:explanation,embeddingIdentity:m.embeddingIdentity,embeddingDimensions:m.embeddingDimensions,backend:{url:localURL(`http://127.0.0.1:${instance.port}`),protocol:'responses'},info,release:()=>{if(!released){released=true;this.leases.set(instance.key,Math.max(0,this.active(instance)-1));this.lastUsed.set(instance.key,this.now());}}};
     }
    }
    // Existing slots are always considered before another copy of any weights.
    for(const {model:m} of ranked){
     const existing=this.usable(m,info.tokens);const queued=this.pending.get(m.id)||0;
     if(existing.length&&queued<2)continue;
     try{const result=await bounded(this.ensure(m,true,existing.length>0,signal,info.tokens),signal,until-this.now());if(result)break;}catch(error){last=error.message;if(signal?.aborted)throw signal.reason;if(explicit&&error.status!==507)throw error;}
     if(signal?.aborted)throw signal.reason;
    }
    await delay(this.pollMs);
   }
   throw new GatewayError(503,`Local queue deadline exceeded: ${last}`);
  }finally{this.waiters--;for(const m of candidates)this.pending.set(m.id,Math.max(0,(this.pending.get(m.id)||1)-1));}
 }
 async manual(action,id){
  const m=this.registry.models.find(m=>m.id===id);if(!m)throw new GatewayError(404,'Unknown model');
  if(action==='load'){const instance=await this.ensure(m,false);if(instance&&this.controller.pin){await this.exclusive(()=>this.controller.pin(instance));await this.refresh(true);}return instance;}
  if(!['unload','reload'].includes(action))throw new GatewayError(400,'Unknown model action');
  await this.exclusive(async()=>{
   this.draining.add(id);
   try{await this.refresh(true);const targets=this.instances.filter(i=>i.model===id);
   if((this.pending.get(id)||0)>0||targets.some(i=>this.active(i)>0))throw new GatewayError(409,'This model has active or queued requests; cancel or finish those requests first');
   for(const instance of targets)await this.controller.stop(instance);
   await this.refresh(true);this.event('unloaded',{model:id});
   }finally{this.draining.delete(id);}
  });
  return action==='reload'?this.ensure(m,false):{unloaded:id};
 }
}
