import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configuration,createGateway} from './proxy.mjs';
import {Limiter} from './gateway-runtime.mjs';
import {buildCodexCatalog} from './model-catalog.mjs';

// Optional actual-client contract, not an inference/Windows smoke test. Pinned
// parser reference: openai/codex rust-v0.163.0, codex-api/src/sse/responses.rs.
// Fresh homes, ephemeral sessions, no auth inherited, loopback provider/catalog,
// no model-generated tools. Do not weaken the sandbox if CLI startup is blocked.
const options={skip:!process.env.CODEX_STREAM_TEST_BIN,timeout:30000};
let gatewayPort=20920;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const emit=(res,value)=>res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
function finish(res){
 emit(res,{type:'response.output_item.done',item:{id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'SYNTHETIC_STREAM_SUCCESS'}]}});
 emit(res,{type:'response.completed',response:{id:'resp_fixture',status:'completed',output:[],usage:{input_tokens:1,output_tokens:2,total_tokens:3}}});res.end();
}
async function fixture(t,handler,{direct=false,...overrides}={}){
 const state={requests:0,auth:false,comments:0,closedAt:0,startedAt:0};
 const backend=http.createServer(async(req,res)=>{
  state.auth||=!!req.headers.authorization;
  if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end('{"data":[{"id":"mock-model"}]}');return;}
  if(req.method!=='POST'||!req.url.endsWith('/responses')){res.writeHead(404);res.end('{}');return;}
  for await(const _ of req){}state.requests++;state.startedAt=Date.now();res.on('close',()=>state.closedAt=Date.now());
  try{await handler(res,state);}catch(error){if(!res.destroyed)res.destroy(error);}
 });backend.listen(0,'127.0.0.1');await once(backend,'listening');let base=`http://127.0.0.1:${backend.address().port}/v1`;
 const servers=[backend];
 if(!direct){
  const config=configuration();Object.assign(config,{port:gatewayPort++,heartbeatMs:60,requestMs:2500,routeHeaderTimeoutMs:1800,streamIdleMs:1800,minFreeMemoryGiB:0,...overrides});
  config.chat={url:base.slice(0,-3),protocol:'responses',maxActive:1,limiter:new Limiter(1,1,1500)};
  const gateway=createGateway(config,{log:false});gateway.listen(config.port,'127.0.0.1');await once(gateway,'listening');servers.push(gateway);base=`http://127.0.0.1:${config.port}/v1`;
 }
 t.after(()=>Promise.all(servers.map(server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})))) ;
 return {base,state};
}
async function cli(t,base){
 const home=mkdtempSync(join(tmpdir(),'local-router-codex-stream-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 writeFileSync(join(home,'catalog.json'),JSON.stringify(buildCodexCatalog([{id:'mock-model',context:65536,tasks:['general']}])));
 const args=['exec','--skip-git-repo-check','--json','--ephemeral','-C',home,'-m','mock-model',
  '-c','project_doc_max_bytes=0','-c','web_search="disabled"','-c','model_provider="local_stream_test"','-c',`model_catalog_json=${JSON.stringify(join(home,'catalog.json'))}`,
  '-c','model_providers.local_stream_test.name="Local stream test"','-c',`model_providers.local_stream_test.base_url=${JSON.stringify(base)}`,
  '-c','model_providers.local_stream_test.wire_api="responses"','-c','model_providers.local_stream_test.requires_openai_auth=false',
  '-c','model_providers.local_stream_test.request_max_retries=0','-c','model_providers.local_stream_test.stream_max_retries=0',
  '-c','model_providers.local_stream_test.stream_idle_timeout_ms=450','-c','features.responses_websockets=false','-c',`chatgpt_base_url=${JSON.stringify(base)}`,
  'Return the synthetic fixture response. Do not call tools.'];
 const child=spawn(process.env.CODEX_STREAM_TEST_BIN,args,{env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,HOME:home,USERPROFILE:home,CODEX_HOME:home},stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});
 let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
 const [code,signal]=await once(child,'exit');assert.equal(signal,null,stderr);return {code,stdout,stderr,events:stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))};
}

test('official CLI counterfactual: comment bytes do not reset its parsed SSE idle timer',options,async t=>{
 const f=await fixture(t,async(res,state)=>{
  res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();
  const interval=setInterval(()=>{state.comments++;res.write(': keepalive\n\n');},60);res.once('close',()=>clearInterval(interval));await sleep(1100);if(!res.destroyed)finish(res);
 },{direct:true});
 const result=await cli(t,f.base);assert.notEqual(result.code,0);assert.match(result.stdout,/idle timeout waiting for SSE/);assert.ok(f.state.comments>=3);assert.equal(f.state.requests,1);assert.equal(f.state.auth,false);assert.ok(f.state.closedAt-f.state.startedAt<1000);
});

test('official CLI: gateway control events survive delayed first headers without fake output or retry',options,async t=>{
 const f=await fixture(t,async res=>{await sleep(1100);res.writeHead(200,{'content-type':'text/event-stream'});finish(res);});
 const result=await cli(t,f.base);assert.equal(result.code,0,result.stderr+'\n'+result.stdout);assert.doesNotMatch(result.stdout,/idle timeout/);assert.equal(f.state.requests,1);assert.equal(f.state.auth,false);
 assert.deepEqual(result.events.filter(event=>event.type==='item.completed').map(event=>event.item.text),['SYNTHETIC_STREAM_SUCCESS']);assert.equal(result.events.at(-1).type,'turn.completed');
});

test('official CLI: upstream comment flood cannot hide gateway idle failure or suppress parsed heartbeat',options,async t=>{
 const f=await fixture(t,(res,state)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();const timer=setInterval(()=>{state.comments++;res.write(': upstream-alive\n\n');},15);res.once('close',()=>clearInterval(timer));},{streamIdleMs:850});
 const result=await cli(t,f.base);assert.notEqual(result.code,0);assert.match(result.stdout,/no streaming progress before the idle deadline/);assert.doesNotMatch(result.stdout,/idle timeout waiting for SSE|stream closed before response.completed/);assert.equal(f.state.requests,1);assert.equal(f.state.auth,false);assert.ok(f.state.closedAt-f.state.startedAt>=700);assert.ok(f.state.closedAt-f.state.startedAt<1800);assert.equal(result.events.filter(event=>event.type==='item.completed').length,0);
});

test('official CLI: generic upstream error is preserved as response.failed then immediate EOF',options,async t=>{
 const f=await fixture(t,async res=>{res.writeHead(200,{'content-type':'text/event-stream'});emit(res,{type:'response.created',response:{id:'upstream-fixture-id',status:'in_progress',output:[]}});await sleep(850);emit(res,{type:'error',message:'SYNTHETIC_TERMINAL_FAILURE'});res.end();});
 const result=await cli(t,f.base);assert.notEqual(result.code,0);assert.match(result.stdout,/SYNTHETIC_TERMINAL_FAILURE/);assert.doesNotMatch(result.stdout,/idle timeout waiting for SSE|stream closed before response.completed/);assert.equal(f.state.requests,1);assert.equal(f.state.auth,false);
});
