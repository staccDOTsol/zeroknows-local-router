import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {ModelPool,classify} from './model-router.mjs';
import {createGateway,configuration} from './proxy.mjs';
const GiB=1024**3, sleep=ms=>new Promise(r=>setTimeout(r,ms));
const definition=(id,tasks=['general','reasoning','coding'],rank=0)=>({id,tasks,rank:Object.fromEntries(tasks.map(t=>[t,rank])),context:65536,nativeContext:65536,ports:[21001+rank,21101+rank],weightBytes:2*GiB,kvBytesPerToken:256,fixedCacheMiB:0,promptCacheGiB:1});
const instance=(m,{replica=0,slots=1,automatic=false}={})=>({key:`${m.id}-${replica}`,model:m.id,replica,port:m.ports[replica],ready:true,slots,context:m.context,automatic});
class FakeController{
 constructor(models,instances=[],freeBytes=100*GiB){this.models=models;this.instances=instances;this.freeBytes=freeBytes;this.starts=[];this.stops=[];this.startDelay=0;this.stopDelay=0;}
 async status(){return {instances:this.instances.map(i=>({...i})),models:this.models.map(m=>({id:m.id,ready:true})),freeBytes:this.freeBytes};}
 async start(m,replica,slots,automatic){this.starts.push({model:m.id,replica,slots});await sleep(this.startDelay);const i=instance(m,{replica,slots,automatic});this.instances.push(i);this.freeBytes-=m.weightBytes;return i;}
 async stop(i){this.stops.push(i.key);await sleep(this.stopDelay);this.instances=this.instances.filter(x=>x.key!==i.key);this.freeBytes+=this.models.find(m=>m.id===i.model).weightBytes;}
}
function fixture(models=[definition('text-model')],instances=[],options={}){const controller=new FakeController(models,instances,options.freeBytes);const pool=new ModelPool({models,idleEvictMs:10},controller,{queueMs:100,maxQueued:8,pollMs:1,...options});return {pool,controller,models};}
const request=(model='auto',input='Hello')=>({model,input,max_output_tokens:16});
test('classification handles code, reasoning, embeddings and actual image input',()=>{
 assert.equal(classify(request('auto','debug this Python function'),'/v1/responses').task,'coding');
 assert.equal(classify(request('auto','solve this equation'),'/v1/responses').task,'reasoning');
 assert.equal(classify(request(),'/v1/embeddings').task,'embedding');
 assert.equal(classify({model:'auto',messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,YQ=='}}]}]},'/v1/chat/completions').task,'vision');
});
test('audio, video, file references and remote images fail clearly',()=>{
 for(const type of ['input_audio','input_file','input_video'])assert.throws(()=>classify({input:[{type}]},'/v1/responses'),e=>e.status===415);
 assert.throws(()=>classify({input:[{type:'input_image',image_url:'https://example.com/private.png'}]},'/v1/responses'),e=>e.status===400);
});
test('explicit selection cannot send an image to text model or exceed context',()=>{
 const {pool}=fixture();assert.throws(()=>pool.candidates({model:'text-model',input:[{type:'input_image',image_url:'data:image/png;base64,YQ=='}]},'/v1/responses'),e=>e.status===422);
 assert.throws(()=>pool.candidates(request('text-model','x'.repeat(66000)),'/v1/responses'),e=>e.status===422);
});
test('explicit model override wins ranking and ready slot avoids loading',async()=>{
 const models=[definition('first-model'),definition('second-model',undefined,1)];const {pool,controller}=fixture(models,[instance(models[1])]);
 const lease=await pool.acquire(request('second-model'),'/v1/responses');assert.equal(lease.model,'second-model');assert.equal(controller.starts.length,0);lease.release();lease.release();assert.equal(pool.active(lease.instance),0);
});
test('independent models run concurrently and unloading busy model is rejected',async()=>{
 const models=[definition('first-model'),definition('second-model',undefined,1)];const {pool,controller}=fixture(models,models.map(m=>instance(m)));
 const [a,b]=await Promise.all(models.map(m=>pool.acquire(request(m.id),'/v1/responses')));
 await assert.rejects(pool.manual('unload',models[0].id),e=>e.status===409);b.release();await pool.manual('unload',models[1].id);assert.deepEqual(controller.stops,['second-model-0']);a.release();
});
test('concurrent cold requests serialize loading and prefer two slots',async()=>{
 const {pool,controller}=fixture();controller.startDelay=15;
 const [a,b]=await Promise.all([pool.acquire(request(),'/v1/responses'),pool.acquire(request(),'/v1/responses')]);
 assert.equal(controller.starts.length,1);assert.equal(controller.starts[0].slots,2);assert.equal(a.instance.key,b.instance.key);a.release();b.release();
});
test('replicas are bounded to two and queued load can use second instance',async()=>{
 const m=definition('text-model');const {pool,controller}=fixture([m],[instance(m)]);
 const a=await pool.acquire(request(),'/v1/responses');const [b,c]=await Promise.all([pool.acquire(request(),'/v1/responses'),pool.acquire(request(),'/v1/responses')]);
 assert.equal(controller.starts.length,1);assert.equal(controller.starts[0].replica,1);assert.equal(controller.starts[0].slots,2);assert.equal(new Set([a.instance.key,b.instance.key,c.instance.key]).size,2);a.release();b.release();c.release();
});
test('insufficient capacity queues then errors without evicting pinned model',async()=>{
 const models=[definition('first-model'),definition('second-model',undefined,1)];const {pool,controller}=fixture(models,[instance(models[0])],{freeBytes:20*GiB,queueMs:25});
 await assert.rejects(pool.acquire(request('second-model'),'/v1/responses'),e=>e.status===503&&/memory|GiB/.test(e.message));assert.equal(controller.starts.length,0);assert.equal(controller.stops.length,0);
});
test('only idle automatically owned instances can be evicted',async()=>{
 let now=1000;const models=[definition('first-model'),definition('second-model',undefined,1)];const {pool,controller}=fixture(models,[instance(models[0],{automatic:true})],{freeBytes:26*GiB,now:()=>now});
 await pool.refresh();now+=100;const lease=await pool.acquire(request('second-model'),'/v1/responses');assert.deepEqual(controller.stops,['first-model-0']);lease.release();
});
test('cancellation releases queue count while a started load remains tracked',async()=>{
 const {pool,controller}=fixture();controller.startDelay=30;const abort=new AbortController();const pending=pool.acquire(request(),'/v1/responses',abort.signal);await sleep(5);abort.abort(new Error('cancelled'));
 await assert.rejects(pending,/cancelled/);assert.equal(pool.waiters,0);await pool.serial;assert.equal(controller.starts.length,1);assert.equal(pool.active(controller.instances[0]),0);
});
test('queued request cannot reserve a model while targeted unload is draining',async()=>{
 const m=definition('text-model');const {pool,controller}=fixture([m],[instance(m)]);await pool.refresh();controller.stopDelay=15;
 const stopping=pool.manual('unload',m.id);await sleep(2);const acquisition=pool.acquire(request(m.id),'/v1/responses');await stopping;const lease=await acquisition;assert.equal(controller.starts.length,1);lease.release();
});
test('queue bound and output validation are enforced',async()=>{
 const {pool}=fixture(undefined,[],{maxQueued:0});await assert.rejects(pool.acquire(request(),'/v1/responses'),e=>e.status===429);
 assert.throws(()=>classify({...request(),max_output_tokens:-1},'/v1/responses'),e=>e.status===400);
});

async function mockServer(fn){const server=http.createServer(fn);server.listen(0,'127.0.0.1');await once(server,'listening');return server;}
async function gatewayFixture(t,handlerA,handlerB){
 const servers=await Promise.all([mockServer(handlerA),mockServer(handlerB)]);const models=[definition('first-model'),definition('second-model',undefined,1)];models.forEach((m,i)=>m.ports[0]=servers[i].address().port);
 const {pool,controller}=fixture(models,models.map(m=>instance(m)));const config=configuration();config.port=18995;config.pool=pool;config.routeHeaderTimeoutMs=30;
 const gateway=createGateway(config,{log:false});gateway.listen(config.port,'127.0.0.1');await once(gateway,'listening');
 t.after(async()=>{await Promise.all([...servers,gateway].map(s=>new Promise(r=>{s.closeAllConnections();s.close(r);})));});
 return {pool,controller,url:`http://127.0.0.1:${config.port}`};
}
const ok=(req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'r',object:'response',model:'second-model',output:[{type:'message',content:[{type:'output_text',text:'hello'}]}]}));};
test('AUTO operational failure retries another local model before output',async t=>{
 let first=0,second=0;const {url}=await gatewayFixture(t,(req,res)=>{first++;res.writeHead(503);res.end('{}');},(req,res)=>{second++;ok(req,res);});
 const response=await fetch(url+'/v1/responses',{method:'POST',body:JSON.stringify(request())});assert.equal(response.status,200);assert.equal(response.headers.get('x-local-model'),'second-model');assert.equal(response.headers.get('x-local-attempts'),'2');await response.text();assert.equal(first,1);assert.equal(second,1);
});
test('explicit operational failure does not silently switch models',async t=>{
 let second=0;const {url}=await gatewayFixture(t,(req,res)=>{res.writeHead(503,{'content-type':'application/json'});res.end('{}');},(req,res)=>{second++;ok(req,res);});
 const response=await fetch(url+'/v1/responses',{method:'POST',body:JSON.stringify(request('first-model'))});assert.equal(response.status,503);await response.text();assert.equal(second,0);
});
test('content refusal is returned unchanged without failover',async t=>{
 let second=0;const {url}=await gatewayFixture(t,(req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({output:[{type:'message',content:[{type:'refusal',refusal:'I cannot help with that.'}]}]}));},(req,res)=>{second++;ok(req,res);});
 const response=await fetch(url+'/v1/responses',{method:'POST',body:JSON.stringify(request())});assert.equal(response.status,200);assert.match(await response.text(),/cannot help/);assert.equal(second,0);
});
test('partial streamed output never triggers another backend',async t=>{
 let second=0;const {url}=await gatewayFixture(t,(req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');setTimeout(()=>res.destroy(),5);},(req,res)=>{second++;ok(req,res);});
 try{const response=await fetch(url+'/v1/responses',{method:'POST',body:JSON.stringify({...request(),stream:true})});await response.text();}catch{}
 assert.equal(second,0);
});
test('lifecycle endpoint rejects browser/simple requests',async t=>{
 const {url,controller}=await gatewayFixture(t,ok,ok);const response=await fetch(url+'/admin/models',{method:'POST',body:JSON.stringify({action:'load',model:'first-model'})});assert.equal(response.status,403);assert.equal(controller.starts.length,0);
});
test('structured OOM can fail over but an ordinary HTTP refusal cannot',async t=>{
 let second=0;const {url}=await gatewayFixture(t,(req,res)=>{res.writeHead(500,{'content-type':'application/json'});res.end('{"error":{"code":"out_of_memory"}}');},(req,res)=>{second++;ok(req,res);});
 const response=await fetch(url+'/v1/responses',{method:'POST',body:JSON.stringify(request())});assert.equal(response.status,200);await response.text();assert.equal(second,1);
});
test('HTTP policy rejection is preserved without inspecting refusal text',async t=>{
 let second=0;const {url}=await gatewayFixture(t,(req,res)=>{res.writeHead(400,{'content-type':'application/json'});res.end('{"error":{"code":"content_policy","message":"Cannot help"}}');},(req,res)=>{second++;ok(req,res);});
 const response=await fetch(url+'/v1/responses',{method:'POST',body:JSON.stringify(request())});assert.equal(response.status,400);assert.match(await response.text(),/content_policy/);assert.equal(second,0);
});
test('header timeout fails over before streaming output',async t=>{
 let second=0;const {url}=await gatewayFixture(t,()=>{},(req,res)=>{second++;ok(req,res);});
 const response=await fetch(url+'/v1/responses',{method:'POST',body:JSON.stringify(request())});assert.equal(response.status,200);await response.text();assert.equal(second,1);
});
test('embedding AUTO is pinned to one vector space and can require its identity',async()=>{
 const a={...definition('embedding',['embedding']),embeddingIdentity:'embedding:sha256:aaa',embeddingDimensions:1024};
 const b={...definition('other-embedding',['embedding'],1),embeddingIdentity:'other-embedding:sha256:bbb',embeddingDimensions:768};
 const {pool}=fixture([a,b],[instance(a),instance(b)]);pool.registry.embeddingModel='embedding';
 const lease=await pool.acquire({...request(),embedding_identity:a.embeddingIdentity},'/v1/embeddings');assert.equal(lease.model,'embedding');assert.equal(lease.embeddingDimensions,1024);lease.release();
 assert.throws(()=>pool.candidates({...request(),embedding_identity:b.embeddingIdentity},'/v1/embeddings'),e=>e.status===503);
 assert.throws(()=>classify({...request(),input:[1,2,3]},'/v1/embeddings'),e=>e.status===400);
});
