import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createGateway,configuration} from './proxy.mjs';
import {Limiter,frameData,sseFrames} from './gateway-runtime.mjs';
import {ModelPool} from './model-router.mjs';

let nextPort=20830;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message){const end=Date.now()+1500;while(!predicate()&&Date.now()<end)await sleep(5);assert.ok(predicate(),message);}
const emit=(res,value)=>res.write(`data: ${JSON.stringify(value)}\n\n`);
function complete(res,marker){res.setHeader?.('content-type','text/event-stream');emit(res,{type:'response.output_text.delta',item_id:'msg_'+marker,delta:marker});emit(res,{type:'response.completed',response:{id:'resp_'+marker,object:'response',status:'completed',output:[{type:'message',content:[{type:'output_text',text:marker}]}]}});res.end();}
const isKeepalive=frame=>frame.startsWith('event: local.gateway.keepalive')||frame.startsWith(': local-keepalive');
async function read(response){const frames=[];for await(const frame of sseFrames(response.body))frames.push(frame);const all=frames.map(frameData).filter(raw=>raw&&raw!=='[DONE]').map(raw=>JSON.parse(raw));return {frames,controls:all.filter(event=>event.type==='local.gateway.keepalive'),events:all.filter(event=>event.type!=='local.gateway.keepalive')};}
async function fixture(t,handler,options={}){
 const received=[];let closed=0;
 const backend=http.createServer(async(req,res)=>{
  if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end('{"data":[{"id":"mock-model"}]}');return;}
  let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);received.push(body);res.on('close',()=>closed++);
  try{await handler(body,res,req);}catch(error){if(!res.destroyed)res.destroy(error);}
 });backend.listen(0,'127.0.0.1');await once(backend,'listening');
 const config=configuration();Object.assign(config,{port:nextPort++,heartbeatMs:25,streamIdleMs:350,requestMs:2000,routeHeaderTimeoutMs:600,minFreeMemoryGiB:0,...options});
 config.chat={url:`http://127.0.0.1:${backend.address().port}`,protocol:'responses',maxActive:options.maxActive||1,limiter:new Limiter(options.maxActive||1,options.maxQueued??2,options.queueMs??600)};
 const gateway=createGateway(config,{log:false});gateway.listen(config.port,'127.0.0.1');await once(gateway,'listening');
 t.after(async()=>{await Promise.all([backend,gateway].map(server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})));});
 const url=`http://127.0.0.1:${gateway.address().port}/v1/responses`;
 const request=(input,extra={},signal)=>fetch(url,{method:'POST',headers:{host:`127.0.0.1:${config.port}`,'content-type':'application/json'},body:JSON.stringify({model:'mock-model',input,stream:true,...extra}),signal});
 return {config,backend,request,received,url,closed:()=>closed};
}
function managed(config,{delay=0,queueMs=600}={}){
 const port=new URL(config.chat.url).port;
 const model={id:'mock-model',tasks:['general'],ports:[Number(port)],context:65536,nativeContext:65536,weightBytes:2*1024**3,kvBytesPerToken:256,fixedCacheMiB:0,promptCacheGiB:1};
 const controller={instances:[],starts:0,async status(){return {instances:this.instances,models:[{id:model.id,ready:true}],freeBytes:100*1024**3};},async start(m,replica,slots,automatic){this.starts++;await sleep(delay);const instance={key:m.id+'-0',model:m.id,replica,slots,automatic,port:Number(port),ready:true,context:m.context};this.instances.push(instance);return instance;}};
 const pool=new ModelPool({models:[model],idleEvictMs:60000},controller,{queueMs,maxQueued:4,pollMs:2});config.pool=pool;return {pool,controller};
}

test('delayed backend headers receive parsed control heartbeats before model output',async t=>{
 let sent=false;const f=await fixture(t,async(body,res)=>{await sleep(160);sent=true;complete(res,body.input);});
 const response=await f.request('delayed-headers');assert.equal(response.status,200);assert.equal(sent,false);assert.match(response.headers.get('content-type'),/event-stream/);
 const value=await read(response);assert.equal(isKeepalive(value.frames[0]),true);assert.ok(value.frames.filter(isKeepalive).length>=2);assert.equal(value.events.at(-1).response.output[0].content[0].text,'delayed-headers');
});

test('delayed first token receives control heartbeats despite upstream headers already being ready',async t=>{
 const f=await fixture(t,async(body,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();await sleep(150);emit(res,{type:'response.output_text.delta',delta:body.input});emit(res,{type:'response.completed',response:{output:[]}});res.end();});
 const value=await read(await f.request('first-token'));assert.ok(value.frames.filter(isKeepalive).length>=2);assert.equal(value.events[0].delta,'first-token');assert.equal(value.events.at(-1).type,'response.completed');
});

test('slow queue stays alive, remains bounded, and never mixes concurrent request output',async t=>{
 const f=await fixture(t,async(body,res)=>{if(body.input==='slow-owner')await sleep(170);complete(res,body.input);},{maxQueued:1});
 const first=await f.request('slow-owner'),second=await f.request('queued-fast');assert.equal(f.received.length,1);
 const overflow=await f.request('overflow');assert.equal(overflow.status,429);assert.match((await overflow.json()).error.message,/queue is full/);
 const [a,b]=await Promise.all([read(first),read(second)]);assert.notEqual(first.headers.get('x-request-id'),second.headers.get('x-request-id'));
 assert.ok(b.frames.some(isKeepalive));assert.equal(a.events[0].delta,'slow-owner');assert.equal(b.events[0].delta,'queued-fast');assert.equal(f.config.chat.limiter.active,0);
});

test('real ModelPool cold admission heartbeats and publishes final route as a comment',async t=>{
 const f=await fixture(t,(body,res)=>complete(res,body.input));const {pool,controller}=managed(f.config,{delay:150});
 const response=await f.request('cold-model',{model:'auto'});assert.equal(response.headers.get('x-local-model'),null);assert.equal(controller.starts,1);
 const result=await read(response);const route=result.frames.find(frame=>frame.startsWith(': local-route '));assert.ok(route);assert.equal(JSON.parse(route.slice(': local-route '.length))['x-local-model'],'mock-model');assert.equal(result.events.at(-1).type,'response.completed');assert.equal(pool.waiters,0);assert.equal(pool.active(controller.instances[0]),0);
 const warm=await f.request('warm-model',{model:'auto'});assert.equal(warm.headers.get('x-local-model'),'mock-model');await read(warm);assert.equal(controller.starts,1);
});

test('upstream comments and ping events cannot mask idle model failure',async t=>{
 for(const ping of [': backend-alive\n\n','event: ping\ndata: {}\n\n','event: ping\ndata: still alive\n\n','data: {"type":"heartbeat"}\n\n']){
  const f=await fixture(t,(_body,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();const timer=setInterval(()=>res.write(ping),15);res.once('close',()=>clearInterval(timer));},{streamIdleMs:120});
  const started=Date.now(),value=await read(await f.request('idle'));assert.equal(value.events.length,1);assert.equal(value.events.at(-1).type,'response.failed');assert.equal(value.events.at(-1).status,504);assert.match(value.events.at(-1).response.error.message,/idle deadline/);assert.ok(Date.now()-started<1200);await until(()=>f.config.chat.limiter.active===0&&f.closed()===1,'idle timeout releases slot and aborts upstream');
 }
});

test('absolute request deadline still bounds genuinely progressing streams',async t=>{
 const f=await fixture(t,(_body,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});const timer=setInterval(()=>emit(res,{type:'response.output_text.delta',delta:'progress'}),20);res.once('close',()=>clearInterval(timer));},{requestMs:180,streamIdleMs:100});
 const result=await read(await f.request('never-finishes'));assert.ok(result.events.filter(event=>event.type==='response.output_text.delta').length>=2);assert.equal(result.events.at(-1).type,'response.failed');assert.match(result.events.at(-1).response.error.message,/request deadline/);assert.equal(f.received.length,1);await until(()=>f.config.chat.limiter.active===0,'deadline releases active slot');
});

test('disconnect after queue heartbeat removes queued work without submitting it',async t=>{
 const f=await fixture(t,()=>{});const active=await f.request('active-hang'),queued=await f.request('queued-cancel');assert.equal(f.config.chat.limiter.queue.length,1);
 await queued.body.cancel();await until(()=>f.config.chat.limiter.queue.length===0,'disconnect removes waiter');assert.equal(f.received.length,1);await active.body.cancel();await until(()=>f.config.chat.limiter.active===0,'disconnect releases active request');
});

test('disconnect while cold load is started leaves no inference or orphaned lease',async t=>{
 const f=await fixture(t,(body,res)=>complete(res,body.input));const {pool,controller}=managed(f.config,{delay:150});
 const response=await f.request('cancel-cold',{model:'auto'});assert.equal(controller.starts,1);await response.body.cancel();await until(()=>pool.waiters===0,'cold waiter removed');await pool.serial;assert.equal(controller.starts,1);assert.equal(f.received.length,0);assert.equal(pool.active(controller.instances[0]),0);
});

test('late upstream HTTP rejection becomes terminal SSE error; early and nonstream errors retain status',async t=>{
 const f=await fixture(t,async(body,res)=>{if(body.input==='late'||!body.stream)await sleep(100);res.writeHead(422,{'content-type':'application/json'});res.end('{"error":{"message":"model rejects shape"}}');});
 const early=await f.request('early');assert.equal(early.status,422);assert.equal((await early.json()).error.message,'model rejects shape');
 const late=await f.request('late');assert.equal(late.status,200);const value=await read(late);assert.equal(value.events.at(-1).type,'response.failed');assert.equal(value.events.at(-1).status,422);assert.equal(value.events.at(-1).response.error.message,'model rejects shape');
 const nonstream=await f.request('nonstream',{stream:false});assert.equal(nonstream.status,422);assert.match(nonstream.headers.get('content-type'),/json/);assert.equal((await nonstream.json()).error.message,'model rejects shape');
});

test('partial tool output followed by socket failure is not replayed and gets terminal error',async t=>{
 const f=await fixture(t,(_body,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});emit(res,{type:'response.output_item.added',item:{id:'tool-1',type:'function_call',call_id:'call-1',name:'write_file',arguments:''}});emit(res,{type:'response.function_call_arguments.delta',item_id:'tool-1',delta:'{"path":'});setTimeout(()=>res.destroy(),35);});
 const {pool}=managed(f.config);const result=await read(await f.request('partial-tool',{model:'auto',tools:[{type:'function',name:'write_file',parameters:{type:'object',properties:{}}}]}));
 assert.equal(result.events.filter(event=>event.type==='response.output_item.added').length,1);assert.equal(result.events.at(-1).type,'response.failed');assert.deepEqual(result.events.map(event=>event.sequence_number),result.events.map((_,index)=>index));assert.equal(f.received.length,1);assert.equal(pool.events.filter(event=>event.type==='route').length,1);
});

test('premature clean EOF is terminal error, not a successful response',async t=>{
 const f=await fixture(t,(_body,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});emit(res,{type:'response.output_text.delta',delta:'partial'});res.end('data: [DONE]\n\n');});
 const result=await read(await f.request('eof'));assert.equal(result.events.at(-1).type,'response.failed');assert.match(result.events.at(-1).response.error.message,/before a terminal event/);assert.ok(result.frames.every(frame=>frameData(frame)!=='[DONE]'));assert.equal(f.received.length,1);
});

test('terminal response ends immediately even if backend leaves its connection open',async t=>{
 const f=await fixture(t,(_body,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});emit(res,{type:'response.completed',response:{id:'terminal',output:[]}});});
 const result=await read(await f.request('terminal'));assert.equal(result.events.length,1);assert.equal(result.events[0].type,'response.completed');await until(()=>f.closed()===1&&f.config.chat.limiter.active===0,'terminal closes backend and releases slot');
});

test('slow reader applies backpressure while fast stream proceeds, and cancellation frees both slots',async t=>{
 let chunks=0;const f=await fixture(t,async(body,res)=>{
  if(body.input!=='slow-reader'){complete(res,body.input);return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(let i=0;i<4096&&!res.destroyed;i++){
   chunks++;if(!emit(res,{type:'response.output_text.delta',delta:'x'.repeat(32768)}))await new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});
  }
 },{maxActive:2,streamIdleMs:100,requestMs:2000});
 const req=http.request(f.url,{method:'POST',headers:{host:`127.0.0.1:${f.config.port}`,'content-type':'application/json'}});req.on('error',()=>{});const incoming=once(req,'response');req.end(JSON.stringify({model:'mock-model',input:'slow-reader',stream:true}));const [reader]=await incoming;reader.pause();await sleep(130);
 const fast=await read(await f.request('independent-fast'));assert.equal(fast.events[0].delta,'independent-fast');assert.ok(chunks<4096);assert.equal(f.config.chat.limiter.active,1);req.destroy();reader.destroy();await until(()=>f.config.chat.limiter.active===0,'slow consumer cancellation releases slot');
});

test('header wait is bounded for static backends as well as managed routes',async t=>{
 const f=await fixture(t,()=>{},{routeHeaderTimeoutMs:120,requestMs:1000});
 const result=await read(await f.request('header-timeout'));assert.equal(result.events.at(-1).status,504);assert.match(result.events.at(-1).response.error.message,/response headers/);await until(()=>f.config.chat.limiter.active===0,'header timeout releases slot');
});

test('queue deadline after heartbeats is an SSE error, not infinite keepalive',async t=>{
 const f=await fixture(t,()=>{},{queueMs:100});const active=await f.request('active');
 const response=await f.request('queue-expiry'),value=await read(response);assert.equal(response.status,200);assert.ok(value.frames.some(isKeepalive));assert.equal(value.events.at(-1).status,504);assert.match(value.events.at(-1).response.error.message,/queue wait timed out/);assert.equal(f.received.length,1);assert.equal(f.config.chat.limiter.queue.length,0);await active.body.cancel();await until(()=>f.config.chat.limiter.active===0,'active owner canceled');
});

test('comments do not prevent pre-output failover and final route metadata names the actual backend',async t=>{
 const a=await fixture(t,()=>{},{routeHeaderTimeoutMs:110}),b=await fixture(t,(body,res)=>complete(res,body.input));
 const models=[a,b].map((f,index)=>({id:index?'second-model':'first-model',tasks:['general'],rank:{general:index},ports:[Number(new URL(f.config.chat.url).port)],context:65536,nativeContext:65536,weightBytes:2*1024**3,kvBytesPerToken:256,fixedCacheMiB:0,promptCacheGiB:1}));
 const instances=models.map(m=>({key:m.id+'-0',model:m.id,port:m.ports[0],replica:0,slots:1,ready:true,context:m.context}));
 const controller={async status(){return {instances,models:models.map(m=>({id:m.id,ready:true})),freeBytes:100*1024**3};}};
 const pool=new ModelPool({models,idleEvictMs:60000},controller,{queueMs:500,pollMs:2});a.config.pool=pool;
 const response=await a.request('retry-safe',{model:'auto'}),value=await read(response);assert.equal(response.headers.get('x-local-model'),null);const route=JSON.parse(value.frames.find(frame=>frame.startsWith(': local-route ')).slice(': local-route '.length));assert.equal(route['x-local-model'],'second-model');assert.equal(route['x-local-attempts'],'2');assert.match(route['x-local-failover'],/first-model:connection_or_timeout/);assert.equal(a.received.length,1);assert.equal(b.received.length,1);assert.equal(value.events[0].delta,'retry-safe');assert.ok([...pool.leases.values()].every(count=>count===0));
});

test('empty Chat chunks and usage-only events are not model progress',async t=>{
 const f=await fixture(t,(_body,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});const timer=setInterval(()=>{emit(res,{choices:[{delta:{}}]});emit(res,{choices:[],usage:{prompt_tokens:1}});},15);res.once('close',()=>clearInterval(timer));},{streamIdleMs:110});f.config.chat.protocol='chat';
 const result=await read(await f.request('empty-chat'));assert.equal(result.events[0].type,'response.created');assert.equal(result.events.at(-1).type,'response.failed');assert.equal(result.events.at(-1).status,504);assert.equal(result.events.filter(event=>event.type==='response.completed').length,0);
});

test('Chat trailing usage and terminal marker survive streaming adaptation',async t=>{
 const f=await fixture(t,async(_body,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});emit(res,{choices:[{delta:{content:'chat-answer'}}]});await sleep(60);emit(res,{choices:[{delta:{},finish_reason:'stop'}]});emit(res,{choices:[],usage:{prompt_tokens:7,completion_tokens:4,total_tokens:11}});res.end('data: [DONE]\n\n');});f.config.chat.protocol='chat';
 const result=await read(await f.request('valid-chat'));assert.equal(result.events.at(-1).type,'response.completed');assert.equal(result.events.at(-1).response.output[0].content[0].text,'chat-answer');assert.equal(result.events.at(-1).response.usage.total_tokens,11);
});

test('direct Chat endpoint uses the Chat error envelope after heartbeat commitment',async t=>{
 const f=await fixture(t,(_body,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();},{streamIdleMs:100});
 const response=await fetch(f.url.replace('/responses','/chat/completions'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'mock-model',messages:[{role:'user',content:'chat'}],stream:true})});
 const value=await read(response);assert.equal(response.status,200);assert.equal(value.events.at(-1).error.status,504);assert.equal(value.events.at(-1).error.type,'server_error');await until(()=>f.config.chat.limiter.active===0,'direct Chat timeout releases slot');
});

test('managed admission receives expanded tool schemas actually sent to the backend',async t=>{
 const f=await fixture(t,(body,res)=>complete(res,'adapted'));const {pool}=managed(f.config);let admitted;const acquire=pool.acquire.bind(pool);pool.acquire=(body,...rest)=>{admitted=structuredClone(body);return acquire(body,...rest);};
 await read(await f.request('tool budgeting',{model:'auto',tools:[{type:'custom',name:'apply_patch',description:'Apply a raw patch'}]}));assert.equal(admitted.tools[0].type,'function');assert.deepEqual(admitted.tools,f.received[0].tools);assert.ok(admitted.tools[0].parameters.properties.input);
});

test('Responses heartbeat extension is namespaced control data without model sequence or output',async t=>{
 const f=await fixture(t,async(body,res)=>{await sleep(120);complete(res,body.input);});
 const response=await f.request('namespaced-heartbeat'),value=await read(response);assert.equal(response.headers.get('x-local-heartbeat'),'local.gateway.keepalive');assert.ok(value.controls.length>=2);
 for(const control of value.controls){assert.deepEqual(Object.keys(control).sort(),['request_id','type']);assert.equal(control.request_id,response.headers.get('x-request-id'));}
 assert.deepEqual(value.events.map(event=>event.sequence_number),value.events.map((_,index)=>index));
});

test('explicit comment mode remains available for clients that reject gateway SSE extensions',async t=>{
 const f=await fixture(t,async(body,res)=>{await sleep(100);complete(res,body.input);},{responseHeartbeatMode:'comment'});
 const response=await f.request('legacy-comment'),value=await read(response);assert.equal(response.headers.get('x-local-heartbeat'),'comment');assert.equal(value.controls.length,0);assert.ok(value.frames.some(frame=>frame.startsWith(': local-keepalive')));assert.equal(value.events.at(-1).type,'response.completed');
});

test('upstream generic error becomes response.failed, preserving real response identity and message',async t=>{
 const f=await fixture(t,async(_body,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});emit(res,{type:'response.created',response:{id:'real-upstream-id',status:'in_progress',output:[]}});await sleep(100);emit(res,{type:'error',message:'SYNTHETIC_UPSTREAM_FAILURE'});res.end();});
 const value=await read(await f.request('error-shape'));const terminal=value.events.at(-1);assert.equal(terminal.type,'response.failed');assert.equal(terminal.response.id,'real-upstream-id');assert.equal(terminal.response.status,'failed');assert.equal(terminal.response.error.message,'SYNTHETIC_UPSTREAM_FAILURE');assert.equal(terminal.sequence_number,1);assert.equal(f.received.length,1);
});

test('upstream generic error preserves classification rather than turning known errors into retryable local failures',async t=>{
 const f=await fixture(t,(_body,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});emit(res,{type:'response.created',response:{id:'context-id'}});emit(res,{type:'error',error:{code:'context_length_exceeded',type:'invalid_request_error',message:'CONTEXT_FIXTURE'}});res.end();});
 const value=await read(await f.request('typed-error'));assert.deepEqual(value.events.at(-1).response.error,{code:'context_length_exceeded',type:'invalid_request_error',message:'CONTEXT_FIXTURE',param:null});
});
