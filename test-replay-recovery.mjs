import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {adaptRequest} from './tool-adapter.mjs';
import {recoverMalformedToolHistory} from './replay-recovery.mjs';
import {createGateway,configuration} from './proxy.mjs';

const broken = {type:'function_call',name:'exec_command',call_id:'broken',arguments:'{"cmd":"never execute this incomplete'};
const history = [
 {type:'message',role:'user',content:'Remember marker GREEN842.'},
 broken,
 {type:'function_call_output',call_id:'broken',output:'failed to parse function arguments: EOF'},
 {type:'function_call',name:'sum',call_id:'good',arguments:'{"a":1,"b":2}'},
 {type:'function_call_output',call_id:'good',output:'3'},
 {type:'message',role:'user',content:'What marker did I give you?'}
];
const original = structuredClone(history);
const recovered = adaptRequest({model:'nemotron-super-vl-q4',input:history}).body.input;
assert.deepEqual(history,original,'Original saved history must not change');
assert.deepEqual(JSON.parse(recovered[1].arguments),{});
assert.match(recovered[2].output,/history replay only/);
assert.ok(recovered[2].output.includes(broken.arguments));
assert.match(recovered[2].output,/failed to parse function arguments/);
assert.deepEqual(recovered.slice(3),history.slice(3));
assert.equal(recoverMalformedToolHistory([broken])[1].call_id,'broken');
assert.throws(()=>recoverMalformedToolHistory([{...broken,call_id:null}]),/no call_id/);
for(const args of ['{','null','"text"','[]']) {
 assert.equal(recoverMalformedToolHistory([{...broken,arguments:args}])[0].arguments,'{}');
}
const valid=[{...broken,arguments:'{"cmd":"Write-Output 42"}'}];
assert.strictEqual(recoverMalformedToolHistory(valid),valid);

let received;
const backend=http.createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'nemotron-super-vl-q4'}]}));
 let raw='';for await(const chunk of req)raw+=chunk;
 received=JSON.parse(raw);
 if(received.input==='parse-error'){res.statusCode=500;return res.end(JSON.stringify({error:{message:'Failed to parse tool call arguments as JSON'}}));}
 for(const item of received.input||[])if(item.type==='function_call')JSON.parse(item.arguments);
 res.end(JSON.stringify({id:'mock',output:[]}));
});
backend.listen(0,'127.0.0.1');await once(backend,'listening');
const config=configuration();
config.port=18094;
config.minFreeMemoryGiB=0;
config.actual={url:`http://127.0.0.1:${backend.address().port}`,protocol:'responses',models:['nemotron-super-vl-q4'],limiter:config.chat.limiter};
const gateway=createGateway(config,{log:false});
gateway.listen(config.port,'127.0.0.1');await once(gateway,'listening');
const url=`http://127.0.0.1:${gateway.address().port}/v1/responses`;
async function post(extra) {
 return fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'nemotron-super-vl-q4',input:history,...extra})});
}
try {
 assert.equal((await post()).status,200);
 assert.equal(received.max_output_tokens,8192);
 assert.equal(received.input[1].arguments,'{}');
 assert.equal((await post({max_output_tokens:80})).status,200);
 assert.equal(received.max_output_tokens,80,'Explicit caller limits must be preserved');
 assert.equal((await post({input:'parse-error'})).status,400,'Deterministic parse failures must not trigger server retries');
 console.log('PASS: malformed-history recovery, preserved valid history, no source mutation, missing result recovery, 8192 default, explicit limits, non-retryable parse errors');
} finally {
 gateway.closeAllConnections();backend.closeAllConnections();
 await Promise.all([new Promise(r=>gateway.close(r)),new Promise(r=>backend.close(r))]);
}
