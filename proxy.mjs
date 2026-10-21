import http from 'node:http';
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {freemem} from 'node:os';
import {adaptRequest} from './tool-adapter.mjs';
import {GatewayError,Limiter,localURL,readJSON,sseFrames,frameData,SSEChannel,superviseSSE} from './gateway-runtime.mjs';
import {toChat,fromChat,chatEvents} from './actual-adapter.mjs';
import {startDiscovery} from './startup-discovery.mjs';
import {ModelPool,WindowsController,readRegistry} from './model-router.mjs';
import {ContextWindow,contextWindowConfiguration,requireMemory} from './context-window.mjs';
import {SessionMemory,memoryConfiguration,memoryAccess,sessionHeader,withSessionEvidence,assertMemoryPromptBudget} from './session-memory.mjs';
import {buildCodexCatalog,readCatalogTemplate} from './model-catalog.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const defaults={port:8090,requestMs:86400000,queueMs:86400000,maxQueued:4096,minFreeMemoryGiB:16,heartbeatMs:15000,responseHeartbeatMode:'event',streamIdleMs:86400000,routeHeaderTimeoutMs:86400000,chat:{url:'http://127.0.0.1:8080',protocol:'responses',maxActive:1},embedding:{url:'http://127.0.0.1:8081',protocol:'responses',maxActive:2},actual:null};
export function configuration(file){
 const config={...structuredClone(defaults),...(file?JSON.parse(readFileSync(file,'utf8')):{})};
 for(const key of ['chat','embedding','actual'])if(config[key]){
  const backend=config[key];backend.url=localURL(backend.url);
  if(!['responses','chat'].includes(backend.protocol))throw new Error('Unknown backend protocol');
  if(!Number.isInteger(backend.maxActive)||backend.maxActive<1||backend.maxActive>4)throw new Error('Backend maxActive must be 1..4');
  backend.limiter=new Limiter(backend.maxActive,config.maxQueued,config.queueMs);
 }
 if(config.actual&&(!Array.isArray(config.actual.models)||!config.actual.models.length))throw new Error('Actual backend requires explicit model aliases');
 if(config.registry){const registryPath=fileURLToPath(new URL(config.registry,new URL('.',import.meta.url)));config.pool=new ModelPool(readRegistry(registryPath),new WindowsController(registryPath,config.powershell||'pwsh'),config);}
 for(const [key,min,max] of [['port',1024,65535],['requestMs',100,86400000],['queueMs',10,86400000],['maxQueued',0,4096],['minFreeMemoryGiB',0,64],['heartbeatMs',10,60000],['streamIdleMs',100,86400000],['routeHeaderTimeoutMs',10,86400000]])if(!Number.isInteger(config[key])||config[key]<min||config[key]>max)throw new Error(`Invalid ${key}`);
 if(!['event','comment'].includes(config.responseHeartbeatMode))throw new Error('Invalid responseHeartbeatMode');
 config.sessionMemory=memoryConfiguration(config.sessionMemory);
 config.contextWindow=contextWindowConfiguration(config.contextWindow);
 return config;
}
const allowed=new Set(['/v1/responses','/v1/chat/completions','/v1/embeddings','/v1/models','/health','/admin/models','/memory/bind','/memory/append','/memory/recall','/memory/delete']);
function json(res,status,value){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));}
function fail(res,status,message){json(res,status,{error:{type:'invalid_request_error',message}});}
export async function* normalizeResponses(stream,adapter){
 let sequence=0;const indexes=new Map(),finishedArgs=new Set(),custom=new Set();
 function encode(event){event.sequence_number=sequence++;return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;}
 function* frame(text){
  const raw=frameData(text);
  if(!raw||raw==='[DONE]'){yield text+'\n\n';return;}
  let event;try{event=JSON.parse(raw);}catch{yield text+'\n\n';return;}
  const id=event.item?.id||event.item_id;
  if(event.type==='response.output_item.added'&&event.item?.type==='function_call'){
   if(adapter.map.get(event.item.name)?.type==='custom')custom.add(id);
   event.item=adapter.toClient(event.item,true);
  }
  if(event.type==='response.output_item.added'&&!indexes.has(id))indexes.set(id,indexes.size);
  if(id&&indexes.has(id))event.output_index??=indexes.get(id);
  if(event.type?.startsWith('response.output_text.')||event.type?.startsWith('response.content_part.'))event.content_index??=0;
  if(event.type==='response.function_call_arguments.done')finishedArgs.add(id);
  if(custom.has(id)&&event.type?.startsWith('response.function_call_arguments.'))return;
  if(event.type==='response.output_item.done'&&event.item?.type==='function_call'&&custom.has(id)){
   event.item=adapter.toClient(event.item);
   yield encode({type:'response.custom_tool_call_input.delta',item_id:id,output_index:event.output_index,delta:event.item.input});
   yield encode({type:'response.custom_tool_call_input.done',item_id:id,output_index:event.output_index,input:event.item.input});
  }else if(event.type==='response.output_item.done'&&event.item)event.item=adapter.toClient(event.item);
  if(event.type==='response.output_item.done'&&event.item?.type==='function_call'&&!finishedArgs.has(id)){
   finishedArgs.add(id);yield encode({type:'response.function_call_arguments.done',item_id:id,output_index:event.output_index,arguments:event.item.arguments});
  }
  if(['response.completed','response.incomplete','response.failed'].includes(event.type)&&event.response)event.response=adapter.response(event.response);
  yield encode(event);
 }
 for await(const frameText of sseFrames(stream))yield*frame(frameText);
}
export function createGateway(config=configuration(),{log=true,captureTools=false}={}){
const port=config.port;
const memory=config.sessionMemory?new SessionMemory(config.sessionMemory):null;
const contextWindow=config.contextWindow?new ContextWindow(requireMemory(memory),config.contextWindow):null;
const server=http.createServer(async(req,res)=>{
 const started=Date.now(),requestId=randomUUID(),abort=new AbortController();let status=500,model=null,upstream=null,release=null,queueMs=0,outcome='complete',memoryAttached=false,channel=null;
 res.setHeader('x-request-id',requestId);
 const deadline=setTimeout(()=>abort.abort(new GatewayError(504,'Local request deadline exceeded')),config.requestMs);
 abort.signal.addEventListener('abort',()=>{if(!req.complete)req.destroy();},{once:true});
 const disconnected=()=>{if(!res.writableEnded){outcome='client_disconnected';abort.abort(new GatewayError(499,'Client disconnected'));}};
 res.on('close',disconnected);req.on('aborted',disconnected);
 const path=new URL(req.url,'http://127.0.0.1').pathname;
 try{
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))return fail(res,status=403,'Loopback Host required');
  if(req.headers.origin){
   const origin=new URL(req.headers.origin);
   if(!['localhost','127.0.0.1','[::1]'].includes(origin.hostname))return fail(res,status=403,'Only localhost browser origins are allowed');
   res.setHeader('access-control-allow-origin',origin.origin);
   res.setHeader('vary','Origin');
  }
  if(req.method==='OPTIONS'){res.writeHead(status=204,{'access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'Content-Type, Authorization'});return res.end();}
  if(path==='/codex/models.json' && req.method==='GET'){
   const template=readCatalogTemplate(config.codexCatalog||root+'setup/local-model-catalog.json',{optional:!!config.pool});
   const catalog=config.pool?buildCodexCatalog(config.pool.registry.models,template,{windowed:!!config.contextWindow}):template;
   res.setHeader('cache-control','no-store');
   return json(res,status=200,catalog);
  }
  if(!allowed.has(path))return fail(res,status=404,'Unsupported endpoint');
  if(!['GET','POST'].includes(req.method))return fail(res,status=405,'Unsupported method');
  if(path==='/health'&&config.pool)return json(res,status=200,{status:'ok',scope:'gateway',router:{...await config.pool.status(),startup_discovery:config.pool.discovery??null}});
  if(path==='/v1/models'&&req.method==='GET'&&config.pool){const state=await config.pool.status();return json(res,status=200,{object:'list',data:[{id:'auto',object:'model',owned_by:'local',routing:'capability'},...state.models.filter(m=>m.ready).map(m=>({id:m.id,object:'model',owned_by:'local',context:m.context,tasks:m.tasks}))]});}
  if(path.startsWith('/memory/')){
   if(!memory)return fail(res,status=404,'Session memory is not enabled');
   memoryAccess(req);
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>262144)throw new GatewayError(413,'Memory request exceeds 256 KiB');chunks.push(chunk);}
   let command;try{command=JSON.parse(Buffer.concat(chunks));}catch{throw new GatewayError(400,'Invalid JSON');}
   const action=path.slice('/memory/'.length),fields={bind:[],append:['documents'],recall:['query','limit'],delete:['document_ids']}[action];
   if(!command||typeof command!=='object'||Array.isArray(command)||Object.keys(command).some(key=>!fields.includes(key)))throw new GatewayError(400,'Unknown or invalid memory fields');
   const value=await memory.command({...command,action,...(action==='bind'?{}:{session:sessionHeader(req)})},{signal:abort.signal});
   res.setHeader('cache-control','no-store');return json(res,status=200,value);
  }
  if(path==='/admin/models'){
   if(!config.pool)return fail(res,status=404,'Managed routing is not enabled');
   if(req.method!=='POST'||req.headers['x-local-control']!=='1'||req.headers.origin)return fail(res,status=403,'Lifecycle control requires a local non-browser POST with X-Local-Control: 1');
   const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>4096)throw new GatewayError(413,'Control request too large');chunks.push(chunk);}
   const command=JSON.parse(Buffer.concat(chunks));return json(res,status=200,await config.pool.manual(command.action,command.model));
  }
  // Gateway liveness must not depend on Qwen when it is intentionally paused
  // to make RAM available for an explicitly selected Actual model.
  if(path==='/health'&&req.method==='GET')return json(res,status=200,{status:'ok',scope:'gateway',backends:Object.fromEntries(['chat','embedding','actual'].filter(key=>config[key]).map(key=>[key,{url:config[key].url,active:config[key].limiter.active,queued:config[key].limiter.queue.length}]))});
  if(path==='/v1/models'&&req.method==='GET'&&config.actual){
   const lists=await Promise.all([config.chat,config.actual].map(async backend=>{
    try{const reply=await fetch(backend.url+'/v1/models',{redirect:'error',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});if(!reply.ok)return [];const value=await readJSON(reply,1024*1024);return value.data.filter(x=>backend===config.chat||backend.models.includes(x.id));}catch{return [];}
   }));
   return json(res,status=200,{object:'list',data:[...new Map(lists.flat().map(x=>[x.id,x])).values()]});
  }
  let body,adapter,originalBody,embeddingMetadata,backend=config.chat;
  if(req.method==='POST'){
   let size=0;const chunks=[];
   for await(const chunk of req){size+=chunk.length;if(size>512*1024*1024)return fail(res,status=413,'Request exceeds 512 MiB');chunks.push(chunk);}
   try{body=JSON.parse(Buffer.concat(chunks));}catch{return fail(res,status=400,'Invalid JSON');}
   if(!body||typeof body!=='object'||Array.isArray(body))return fail(res,status=400,'JSON object required');
   model=body.model;
   if(body.reasoning?.effort==='none')body.chat_template_kwargs={...body.chat_template_kwargs,enable_thinking:false};
   // Desktop tool calls may contain whole files. A 2048-token default cut
   // Nemotron calls in mid-JSON and made every later history replay fail.
   if(path==='/v1/responses')body.max_output_tokens??=model==='nemotron-super-vl-q4'?8192:2048;
   if(body.previous_response_id)return fail(res,status=400,'Use full replayed input; previous_response_id is not supported by this stateless local gateway');
   if(body.background)return fail(res,status=400,'Background Responses are unsupported');
   if(req.headers['x-local-session']!==undefined){
    if(!memory)throw new GatewayError(409,'Session memory is not enabled');
    memoryAccess(req);memoryAttached=true;
    const prepared=await withSessionEvidence(body,path,sessionHeader(req),memory,abort.signal);body=prepared.body;
    res.setHeader('x-local-memory-matches',String(prepared.matches));res.setHeader('x-local-memory-revision',String(prepared.revision));
   }
   // Indexed context window replaces client compaction: bounded prompt + lecore recall per conversation.
   if(contextWindow&&path==='/v1/responses'&&typeof body.prompt_cache_key==='string'){
    try{const windowed=await contextWindow.prepare(body,body.prompt_cache_key,abort.signal);body=windowed.body;res.setHeader('x-local-context',`${windowed.action};${windowed.keptItems??''}/${windowed.totalItems??''};~${windowed.estimatedTokens??''}t`);}
    catch(error){if(abort.signal.aborted)throw error;res.setHeader('x-local-context','error');}
   }
   originalBody=structuredClone(body);
   if(path==='/v1/responses'){
    if(captureTools&&(body.tools||[]).some(t=>t.name==='apply_patch'||(t.tools||[]).some(c=>c.name==='apply_patch'))){
     const redact=(key,value)=>key==='description'?undefined:value;
     writeFileSync(root+'logs/client-tool-schema.json',JSON.stringify(body.tools,redact,2));
    }
    try{adapter=adaptRequest(body);body=adapter.body;}catch(error){return fail(res,status=400,error.message);}
   }
   if(memoryAttached)assertMemoryPromptBudget(body,memory);
   if(body.stream===true&&['/v1/responses','/v1/chat/completions'].includes(path))channel=new SSEChannel(res,{signal:abort.signal,heartbeatMs:config.heartbeatMs,requestId,protocol:path==='/v1/responses'?'responses':'chat',heartbeatMode:path==='/v1/responses'?config.responseHeartbeatMode:'comment',onError:error=>abort.abort(error)});
   if(!config.pool){
   backend=path==='/v1/embeddings'?config.embedding:config.actual?.models.includes(model)?config.actual:config.chat;
   upstream=backend.url;
   const queued=Date.now();release=await backend.limiter.acquire(abort.signal);queueMs=Date.now()-queued;
   if(freemem()<config.minFreeMemoryGiB*1024**3)throw new GatewayError(503,`Insufficient free physical memory: preserve ${config.minFreeMemoryGiB} GiB Windows headroom`);
   const list=await fetch(upstream+'/v1/models',{redirect:'error',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});
   if(!list.ok)throw new GatewayError(503,'Local model is not ready');
   const ids=(await readJSON(list,1024*1024)).data.map(m=>m.id);
   if(!ids.includes(model))throw new GatewayError(409,`Requested model is not loaded. Active: ${ids.join(', ')}. Use start-model.ps1 to switch explicitly.`);
   }
  }else upstream=config.chat.url;
  let upstreamPath=path,upstreamBody=body;
  if(adapter&&backend.protocol==='chat'){upstreamPath='/v1/chat/completions';upstreamBody=toChat(body,backend.capabilities);}
  if(memoryAttached)assertMemoryPromptBudget(upstreamBody,memory);
  // Deliberately do not forward Authorization, cookies, or user credentials.
  let reply,routeHeaders;
  if(config.pool&&body){
   // Admission must account for the actual expanded tool schemas/replay that
   // will be forwarded, not the smaller pre-adaptation client representation.
   const routingBody=structuredClone(body);
   if(Array.isArray(body.tools)&&body.tools.length){try{const sourceTools=(originalBody?.tools||body.tools).flatMap(t=>t.type==='namespace'?(t.tools||[]).map(c=>(t.name||t.namespace||'ns')+'.'+(c.name||c.type)):[t.name||t.function?.name||t.type]);const names=sourceTools.filter(Boolean).sort().join(',');if(names!==config.lastToolNames){config.lastToolNames=names;appendFileSync(root+'logs/tool-offers.jsonl',JSON.stringify({time:new Date().toISOString(),model,effort:body.reasoning?.effort??null,count:sourceTools.length,tools:names.split(',')})+'\n');}}catch{}}
   const requestedModel=model,excluded=[],routeErrors=[];const attempts=requestedModel==='auto'?2:1;
   for(let attempt=0;attempt<attempts;attempt++){
    const queued=Date.now();const lease=await config.pool.acquire({...routingBody,model:requestedModel},path,abort.signal,excluded);queueMs+=Date.now()-queued;
    release=lease.release;backend=lease.backend;upstream=backend.url;model=lease.model;body.model=model;
    if(path==='/v1/embeddings'){embeddingMetadata={embedding_identity:lease.embeddingIdentity,dimensions:lease.embeddingDimensions};res.setHeader('x-local-embedding-identity',lease.embeddingIdentity);delete body.embedding_identity;}
    if(path==='/v1/responses'){adapter=adaptRequest({...originalBody,model});body=adapter.body;}
    // Reasoning effort "none" turns thinking off for every local model (templates without the flag ignore it).
    if(body.reasoning?.effort==='none')body.chat_template_kwargs={...body.chat_template_kwargs,enable_thinking:false};
    if(memoryAttached)assertMemoryPromptBudget(body,memory);
    // Do not publish a tentative model before a possible pre-output failover.
    routeHeaders={'x-local-model':model,'x-local-instance':lease.instance.key,'x-local-route':lease.info.task,'x-local-attempts':String(attempt+1)};
    if(routeErrors.length)routeHeaders['x-local-failover']=routeErrors.join(',');
    const attemptAbort=new AbortController();const attemptTimer=setTimeout(()=>attemptAbort.abort(new GatewayError(504,'Backend did not return response headers before the route timeout')),config.routeHeaderTimeoutMs??120000);
    try{
     reply=await fetch(upstream+path,{redirect:'error',method:req.method,headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([abort.signal,attemptAbort.signal])});
     if(attempt+1<attempts&&[429,502,503,504,507].includes(reply.status)){
      const code=reply.status;await reply.body?.cancel();excluded.push(model);routeErrors.push(`${model}:${code}`);release();release=null;continue;
     }
     if(attempt+1<attempts&&[400,413,422,500].includes(reply.status)){
      const errorBody=await readJSON(reply,1024*1024);const errorCode=errorBody?.error?.type==='exceed_context_size_error'?'context_length_exceeded':errorBody?.error?.code;
      if(['out_of_memory','context_length_exceeded','unsupported_modality'].includes(errorCode)){
       excluded.push(model);routeErrors.push(`${model}:${errorCode}`);release();release=null;continue;
      }
      // Natural-language refusal text is never classified as a transport failure.
      reply=new Response(JSON.stringify(errorBody),{status:reply.status,headers:reply.headers});
     }
     break;
    }catch(error){
     if(abort.signal.aborted||attempt+1===attempts)throw error;
     excluded.push(model);routeErrors.push(`${model}:connection_or_timeout`);release();release=null;
    }finally{clearTimeout(attemptTimer);}
   }
  }else {
   const headerAbort=new AbortController(),headerTimer=setTimeout(()=>headerAbort.abort(new GatewayError(504,'Backend did not return response headers before the route timeout')),config.routeHeaderTimeoutMs??120000);
   try{reply=await fetch(upstream+upstreamPath,{redirect:'error',method:req.method,headers:{'content-type':'application/json'},body:upstreamBody?JSON.stringify(upstreamBody):undefined,signal:AbortSignal.any([abort.signal,headerAbort.signal])});}
   finally{clearTimeout(headerTimer);}
  }
  if(routeHeaders){if(channel)channel.headers(routeHeaders);else for(const [key,value] of Object.entries(routeHeaders))res.setHeader(key,value);}
  status=reply.status;
  if(status>=400){
   const errorText=JSON.stringify(await readJSON(reply,1024*1024));
   if(status===500&&/Jinja Exception|System message must be at the beginning|context size|exceeds.*context|Failed to parse tool call arguments as JSON/i.test(errorText))status=400;
   if(channel?.committed){const error=JSON.parse(errorText)?.error;throw new GatewayError(status,error?.message||`Local upstream returned HTTP ${status}`,error);}
   channel?.stop();
   res.writeHead(status,{'content-type':reply.headers.get('content-type')||'application/json'});res.end(errorText);return;
  }
  if(embeddingMetadata&&status===200){
   const value=await readJSON(reply);
   if(!Array.isArray(value.data)||value.data.some(item=>!Array.isArray(item.embedding)||item.embedding.length!==embeddingMetadata.dimensions))throw new GatewayError(502,'Embedding vector dimension differs from the verified registry; do not index this response');
   return json(res,status,{...value,...embeddingMetadata});
  }
  if(adapter&&status===200&&!body.stream){const value=await readJSON(reply);return json(res,status,backend.protocol==='chat'?fromChat(value,body,adapter):adapter.response(value));}
  if(channel&&status===200&&reply.headers.get('content-type')?.includes('text/event-stream')){
   let source=superviseSSE(reply.body,{idleMs:config.streamIdleMs,protocol:adapter?backend.protocol:path==='/v1/responses'?'responses':'chat',onTimeout:error=>abort.abort(error)});
   if(adapter){if(backend.protocol==='chat')source=chatEvents(source,body);source=normalizeResponses(source,adapter);}
   // Unlike pipeline(), a source error must not destroy the destination before
   // a terminal error can be delivered. Each write still awaits backpressure.
   for await(const chunk of source)await channel.write(chunk);
   channel.end();return;
  }
  if(channel?.committed)throw new GatewayError(502,'Backend did not provide the requested SSE stream');
  channel?.stop();
  res.writeHead(status,{'content-type':reply.headers.get('content-type')||'application/json','cache-control':'no-store','x-accel-buffering':'no'});
  if(reply.body){
   let source=reply.body;
   if(adapter&&body?.stream&&status===200){if(backend.protocol==='chat')source=Readable.from(chatEvents(source,body));source=Readable.from(normalizeResponses(source,adapter),{highWaterMark:1});}
   else source=Readable.fromWeb(source);
   await pipeline(source,res,{signal:abort.signal});
  }else res.end();
 }catch(error){
  const reason=error?.memoryWriteUncertain?error:abort.signal.aborted?abort.signal.reason:error;status=reason?.status||502;outcome=status===499?'client_disconnected':status===504?'timeout':'error';
  if(!res.headersSent&&!res.destroyed)fail(res,status,'Local upstream unavailable: '+reason.message);else if(channel)channel.fail(reason);else res.destroy();
 }finally{
  channel?.stop();clearTimeout(deadline);abort.abort();release?.();res.removeListener('close',disconnected);req.removeListener('aborted',disconnected);
  if(log)appendFileSync(root+'logs/proxy.jsonl',JSON.stringify({time:new Date().toISOString(),requestId,method:req.method,path,model,upstream,status,outcome,queueMs,ms:Date.now()-started})+'\n');
 }
});
server.on('close',()=>{server.memoryClosed=memory?.close()||Promise.resolve();});
server.requestTimeout=60000;server.headersTimeout=15000;
return server;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const config=configuration(process.argv[2]);
 createGateway(config).listen(config.port,'127.0.0.1',()=>{
  if(config.pool&&config.startupDiscovery)startDiscovery(config.pool,config.startupDiscovery,{root});
  writeFileSync(root+'logs/proxy.pid',String(process.pid));
  console.log(`Local model gateway PID ${process.pid}: http://127.0.0.1:${config.port}/v1`);
 });
}
