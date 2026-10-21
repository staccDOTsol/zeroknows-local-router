import http from 'node:http';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {once} from 'node:events';
import {createGateway,configuration} from './proxy.mjs';
import {Limiter,sseFrames,frameData} from './gateway-runtime.mjs';
import {toChat,fromChat} from './actual-adapter.mjs';
import {adaptRequest} from './tool-adapter.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let active=0,peak=0,cancelled=0,slowChunks=0;const received=[];
const backend=http.createServer(async(req,res)=>{
 if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'mock-actual'},{id:'mock-llama'}]}));return;}
 let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);received.push(body);
 active++;peak=Math.max(peak,active);let done=false;
 res.on('close',()=>{active--;if(!done)cancelled++;});
 const marker=body.messages?.at(-1)?.content||body.input;
 if(String(marker).includes('hang')){return;}
 if(req.url==='/v1/responses'){
  if(marker==='slow-reader'){
   res.writeHead(200,{'content-type':'text/event-stream'});
   for(let i=0;i<4096&&!res.destroyed;i++){
    slowChunks++;const frame=`data: ${JSON.stringify({type:'response.output_text.delta',item_id:'slow',delta:'x'.repeat(32768)})}\n\n`;
    if(!res.write(frame))await new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});
   }
   if(!res.destroyed){done=true;res.end();}return;
  }
  res.setHeader('content-type','application/json');done=true;res.end(JSON.stringify({id:'fallback',output:[{type:'message',content:[{type:'output_text',text:marker}]}]}));return;
 }
 res.writeHead(200,{'content-type':'text/event-stream'});
 const emit=async obj=>{const data=`data: ${JSON.stringify(obj)}\r\n\r\n`;for(let i=0;i<data.length;i+=7){if(res.destroyed)return;if(!res.write(data.slice(i,i+7)))await once(res,'drain');}};
 if(body.tools?.length){
  const name=body.tools[0].function.name,input='raw\n'+marker+' "雪"';
  await emit({choices:[{delta:{tool_calls:[{index:0,id:'call_'+marker,function:{name:name.slice(0,7),arguments:'{"input":'}}]}}]});await sleep(25);
  await emit({choices:[{delta:{tool_calls:[{index:0,function:{name:name.slice(7),arguments:JSON.stringify(input)+'}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}});
 }else{
  for(const piece of [String(marker).slice(0,3),String(marker).slice(3)]){await emit({choices:[{delta:{content:piece}}]});await sleep(40);}
  await emit({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}});
 }
 done=true;res.end('data: [DONE]\r\n\r\n');
});
await new Promise(r=>backend.listen(0,'127.0.0.1',r));
const upstream='http://127.0.0.1:'+backend.address().port;
const config=configuration();config.port=18090;config.requestMs=1500;config.queueMs=120;config.maxQueued=2;
config.chat={url:upstream,protocol:'responses',maxActive:1,limiter:new Limiter(1,2,120)};
config.actual={url:upstream,protocol:'chat',models:['mock-actual'],maxActive:4,limiter:new Limiter(4,2,120),capabilities:{tools:true,vision:true}};
const gateway=createGateway(config,{log:false});await new Promise(r=>gateway.listen(config.port,'127.0.0.1',r));
const url=`http://127.0.0.1:${config.port}/v1/responses`;
const request=(marker,tools,signal)=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'mock-actual',input:marker,stream:true,tools}),signal});
async function run(marker,tools){const res=await request(marker,tools);assert.equal(res.status,200);const events=[];for await(const frame of sseFrames(res.body)){const raw=frameData(frame);if(raw&&raw!=='[DONE]')events.push(JSON.parse(raw));}return {requestId:res.headers.get('x-request-id'),events,final:events.at(-1).response};}
const results=[];
try{
 const savedChatURL=config.chat.url;config.chat.url='http://127.0.0.1:1';const health=await fetch(`http://127.0.0.1:${config.port}/health`);assert.equal(health.status,200);assert.equal((await health.json()).scope,'gateway');config.chat.url=savedChatURL;results.push({test:'gateway liveness while Qwen backend is paused',passed:true});
 for(const count of [1,2,4]){
  peak=0;const batch=await Promise.all(Array.from({length:count},(_,i)=>run(`stream_${count}_${i}`)));
  assert.equal(new Set(batch.map(x=>x.requestId)).size,count);assert.equal(new Set(batch.map(x=>x.final.id)).size,count);assert.equal(peak,count);
  batch.forEach((r,i)=>{assert.equal(r.final.output[0].content[0].text,`stream_${count}_${i}`);assert.deepEqual(r.events.map(e=>e.sequence_number),r.events.map((_,n)=>n));});results.push({test:`${count} concurrent streams`,passed:true,peak});
 }
 const custom=await Promise.all([0,1,2,3].map(i=>run(`custom_${i}`,[{type:'namespace',name:`space_${i}`,tools:[{type:'custom',name:'patch',description:'raw'}]}])));
 custom.forEach((r,i)=>{const call=r.final.output[0];assert.equal(call.type,'custom_tool_call');assert.equal(call.namespace,`space_${i}`);assert.equal(call.name,'patch');assert.equal(call.call_id,`call_custom_${i}`);assert.equal(call.input,`raw\ncustom_${i} "雪"`);assert.equal(r.events.filter(e=>e.type==='response.custom_tool_call_input.done').length,1);});results.push({test:'custom namespace identity and raw text isolation',passed:true});
 const fallback=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'mock-llama',input:'fallback-only'})});assert.equal((await fallback.json()).output[0].content[0].text,'fallback-only');results.push({test:'llama fallback preserved',passed:true});
 assert.ok(received.filter(x=>x.messages).every(x=>x.messages.length===1));results.push({test:'no cross-request history',passed:true});
 const raw=http.request(url,{method:'POST',headers:{'content-type':'application/json'}});raw.on('error',()=>{});const paused=new Promise(r=>raw.once('response',r));raw.end(JSON.stringify({model:'mock-llama',input:'slow-reader',stream:true}));const reader=await paused;reader.pause();await sleep(100);const fast=await run('unrelated-fast');assert.equal(fast.final.output[0].content[0].text,'unrelated-fast');assert.ok(slowChunks<4096);raw.destroy();reader.destroy();await sleep(60);results.push({test:'slow reader backpressure and independent stream progress',passed:true,upstreamChunksBeforeCancel:slowChunks});
 const replay=toChat({model:'mock-actual',input:[{type:'function_call',call_id:'a',name:'one',arguments:'{}'},{type:'function_call',call_id:'b',name:'two',arguments:'{}'},{type:'function_call_output',call_id:'a',output:'A'},{type:'function_call_output',call_id:'b',output:'B'}]},{});assert.equal(replay.messages[0].tool_calls.length,2);assert.equal(replay.messages[2].tool_call_id,'b');
 const partial=fromChat({choices:[{message:{content:'partial'},finish_reason:'length'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}},{model:'mock-actual'},adaptRequest({}));assert.equal(partial.status,'incomplete');results.push({test:'parallel tool replay and output limit status',passed:true});
 config.actual.limiter=new Limiter(1,1,120);
 const ac=new AbortController();const hanging=request('hang-active',null,ac.signal).catch(e=>e);await sleep(60);
 const queued=request('queued');await sleep(20);const full=await request('overflow');assert.equal(full.status,429);assert.equal((await queued).status,504);ac.abort();await hanging;await sleep(80);assert.ok(cancelled>=1);assert.equal(config.actual.limiter.active,0);results.push({test:'queue bound, queue timeout, active disconnect cancellation',passed:true});
 const firstAbort=new AbortController(),secondAbort=new AbortController();const first=request('hang-again',null,firstAbort.signal).catch(e=>e);await sleep(40);const second=request('cancel-queued',null,secondAbort.signal).catch(e=>e);await sleep(20);secondAbort.abort();await second;await sleep(30);assert.equal(config.actual.limiter.queue.length,0);firstAbort.abort();await first;await sleep(40);results.push({test:'queued disconnect removed',passed:true});
 const timeout=await request('hang-timeout');assert.equal(timeout.status,504);await sleep(40);assert.equal(config.actual.limiter.active,0);results.push({test:'overall deadline frees slot',passed:true});
 let limited=false;try{for await(const _ of sseFrames((async function*(){yield Buffer.from('x'.repeat(1025));})(),1024)){} }catch{limited=true;}assert.ok(limited);results.push({test:'SSE buffer cap',passed:true});
 const previous=config.minFreeMemoryGiB;config.minFreeMemoryGiB=1000000;assert.equal((await request('memory-guard')).status,503);config.minFreeMemoryGiB=previous;assert.equal(config.actual.limiter.active,0);results.push({test:'RAM headroom rejection frees slot',passed:true});
 console.log(JSON.stringify(results,null,2));writeFileSync('logs/concurrency-tests.json',JSON.stringify({timestamp:new Date().toISOString(),mock:true,results},null,2));
}finally{gateway.closeAllConnections();backend.closeAllConnections();await Promise.all([new Promise(r=>gateway.close(r)),new Promise(r=>backend.close(r))]);}
