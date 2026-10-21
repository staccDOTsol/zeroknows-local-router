export class GatewayError extends Error {
 constructor(status,message,upstreamError){super(message);this.status=status;if(upstreamError)this.upstreamError={...(typeof upstreamError.code==='string'?{code:upstreamError.code}:{}),...(typeof upstreamError.type==='string'&&upstreamError.type!=='error'?{type:upstreamError.type}:{})};}
}
export function localURL(value){
 const url=new URL(value);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw new Error('Backend must be an uncredentialed loopback HTTP origin');
 return url.origin;
}
export class Limiter {
 constructor(maxActive=1,maxQueued=8,queueMs=120000){this.active=0;this.queue=[];this.maxActive=maxActive;this.maxQueued=maxQueued;this.queueMs=queueMs;}
 acquire(signal){
  if(signal.aborted)return Promise.reject(signal.reason);
  if(this.active<this.maxActive){this.active++;return Promise.resolve(this.release());}
  if(this.queue.length>=this.maxQueued)return Promise.reject(new GatewayError(429,'Local backend queue is full; retry later'));
  return new Promise((resolve,reject)=>{
   const entry={resolve,reject};
   const remove=()=>{const i=this.queue.indexOf(entry);if(i>=0)this.queue.splice(i,1);entry.cleanup();};
   const cancel=()=>{remove();reject(signal.reason);};
   const timer=setTimeout(()=>{remove();reject(new GatewayError(504,'Local backend queue wait timed out'));},this.queueMs);
   entry.cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);};
   signal.addEventListener('abort',cancel,{once:true});this.queue.push(entry);
  });
 }
 release(){let released=false;return ()=>{if(released)return;released=true;const next=this.queue.shift();if(next){next.cleanup();next.resolve(this.release());}else this.active--;};}
}
export async function readJSON(response,maxBytes=512*1024*1024){
 let bytes=0;const chunks=[];
 for await(const chunk of response.body){bytes+=chunk.length;if(bytes>maxBytes)throw new GatewayError(502,'Backend response exceeds buffer limit');chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks));}catch{throw new GatewayError(502,'Backend returned invalid JSON');}
}
export async function* sseFrames(stream,maxFrameBytes=256*1024*1024){
 const decoder=new TextDecoder();let buffer='';
 for await(const chunk of stream){
  buffer+=typeof chunk==='string'?chunk:decoder.decode(chunk,{stream:true});
  // Match CRLF as well as LF even when the CR/LF arrives in separate chunks.
  let match;
  while((match=/\r?\n\r?\n/.exec(buffer))){
   const frame=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);
   if(Buffer.byteLength(frame)>maxFrameBytes)throw new GatewayError(502,'Backend SSE frame exceeds limit');
   yield frame.replaceAll('\r\n','\n');
  }
  if(Buffer.byteLength(buffer)>maxFrameBytes)throw new GatewayError(502,'Backend SSE frame exceeds limit');
 }
 buffer+=decoder.decode();if(buffer.trim())yield buffer.replaceAll('\r\n','\n');
}
export function frameData(frame){return frame.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');}

// A delayed first heartbeat preserves ordinary HTTP validation/admission errors.
// Once the first heartbeat commits HTTP 200, later failures must be SSE errors:
// status codes and route headers can no longer be changed on that connection.
export class SSEChannel {
 constructor(response,{signal,heartbeatMs=15000,requestId,protocol='responses',heartbeatMode=protocol==='responses'?'event':'comment',onError=()=>{}}={}){
  this.response=response;this.signal=signal;this.requestId=requestId;this.protocol=protocol;
  this.heartbeatMode=heartbeatMode;this.blocked=null;this.metadata=null;this.nextSequence=0;this.lastWrite=this.lastEvent=Date.now();
  this.timer=setInterval(()=>{
   const lastActivity=heartbeatMode==='event'?this.lastEvent:this.lastWrite;
   if(this.blocked||response.destroyed||response.writableEnded||Date.now()-lastActivity<heartbeatMs)return;
   // Codex 0.163 times out parsed SSE events, not raw comment bytes. This is
   // explicitly gateway transport metadata, never a model delta/tool/lifecycle
   // event, and deliberately has no model sequence_number or response id.
   const frame=heartbeatMode==='event'?`event: local.gateway.keepalive\ndata: ${JSON.stringify({type:'local.gateway.keepalive',request_id:requestId})}\n\n`:': local-keepalive\n\n';
   this.write(frame).catch(onError);
  },heartbeatMs);this.timer.unref?.();
 }
 get committed(){return this.response.headersSent;}
 open(){
  if(!this.committed)this.response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no','x-local-heartbeat':this.heartbeatMode==='event'?'local.gateway.keepalive':'comment','x-local-route-metadata':this.metadata?'sse-comment':'headers-or-sse-comment'});
 }
 headers(headers){
  if(!this.committed){for(const [key,value] of Object.entries(headers))this.response.setHeader(key,value);}
  else this.metadata={...this.metadata,...headers};
 }
 async write(chunk){
  if(this.blocked)await this.blocked;
  if(this.signal?.aborted)throw this.signal.reason;
  if(this.response.destroyed||this.response.writableEnded)throw new GatewayError(499,'Client disconnected');
  this.open();
  if(this.metadata){const metadata=this.metadata;this.metadata=null;await this.raw(': local-route '+JSON.stringify(metadata)+'\n\n');}
  const data=frameData(String(chunk));
  if(data)this.lastEvent=Date.now();
  try{const value=JSON.parse(data);if(Number.isInteger(value.sequence_number))this.nextSequence=Math.max(this.nextSequence,value.sequence_number+1);if(typeof value.response?.id==='string')this.responseId=value.response.id;}catch{}
  await this.raw(chunk);
 }
 async raw(chunk){
  this.lastWrite=Date.now();
  if(this.response.write(chunk))return;
  this.blocked=new Promise((resolve,reject)=>{
   const clean=()=>{this.response.off('drain',drain);this.response.off('close',close);this.response.off('error',error);this.signal?.removeEventListener('abort',cancel);};
   const drain=()=>{clean();resolve();},close=()=>{clean();reject(new GatewayError(499,'Client disconnected'));},error=err=>{clean();reject(err);},cancel=()=>{clean();reject(this.signal.reason);};
   this.response.once('drain',drain);this.response.once('close',close);this.response.once('error',error);this.signal?.addEventListener('abort',cancel,{once:true});
   if(this.signal?.aborted)cancel();
  });
  try{await this.blocked;}finally{this.blocked=null;}
 }
 stop(){clearInterval(this.timer);}
 end(){this.stop();this.response.end();}
 fail(error){
  this.stop();
  if(this.response.destroyed||this.response.writableEnded)return;
  // Never queue an error behind an unbounded slow consumer. The request deadline
  // also bounds backpressure; cancellation must release its backend lease.
  if(this.blocked||this.response.writableNeedDrain||error.status===499){this.response.destroy();return;}
  const detail={code:error.status===504?'local_upstream_timeout':'local_upstream_error',type:'server_error',...error.upstreamError,message:error.message};
  // Codex ignores generic type:error except a narrow provider-specific code.
  // response.failed plus immediate EOF preserves the real error instead of
  // falling back to "stream closed before response.completed" or another idle.
  const value=this.protocol==='responses'?{type:'response.failed',sequence_number:this.nextSequence,request_id:this.requestId,status:error.status||502,response:{id:this.responseId||`resp_local_${this.requestId}`,object:'response',status:'failed',output:[],error:{...detail,param:null}}}:{error:{...detail,request_id:this.requestId,status:error.status||502}};
  this.response.end((this.protocol==='responses'?'event: response.failed\n':'')+'data: '+JSON.stringify(value)+'\n\n');
 }
}

// Only upstream data progresses this clock; downstream keepalives and upstream
// SSE comments/pings cannot keep a stuck model alive. The outer request deadline
// remains absolute even when the upstream emits real progress indefinitely.
export async function* superviseSSE(stream,{idleMs=120000,protocol='responses',onTimeout=()=>{}}={}){
 let timer,terminal=false,remaining=idleMs,waitingAt;
 const wait=()=>{waitingAt=Date.now();timer=setTimeout(()=>onTimeout(new GatewayError(504,'Local upstream made no streaming progress before the idle deadline')),Math.max(1,remaining));timer.unref?.();};
 wait();
 try{
  for await(const frame of sseFrames(stream)){
   clearTimeout(timer);remaining-=Date.now()-waitingAt;
   const raw=frameData(frame),eventName=frame.split('\n').find(line=>line.startsWith('event:'))?.slice(6).trim();let value;
   if(protocol==='responses'&&raw==='[DONE]')throw new GatewayError(502,'Backend stream ended before a terminal event; partial output was not retried');
   let keepalive=['ping','heartbeat','keepalive'].includes(eventName);
   if(raw&&raw!=='[DONE]'&&!keepalive){
    try{value=JSON.parse(raw);}catch{throw new GatewayError(502,'Backend returned invalid SSE JSON');}
    if(protocol==='responses'&&value?.type==='error')throw new GatewayError(Number.isInteger(value.status)&&value.status>=400&&value.status<=599?value.status:502,value.message||value.error?.message||'Backend stream error',value.error||value);
    const idleEvents=['ping','heartbeat','keepalive','response.queued','response.in_progress','response.created'];
    keepalive=['ping','heartbeat','keepalive'].includes(value?.type);
    const nonempty=value=>typeof value==='string'&&value.length>0;
    const progress=protocol==='responses'
     ? nonempty(value?.delta)||['response.output_item.added','response.output_item.done','response.content_part.added','response.content_part.done','response.completed','response.incomplete','response.failed','error'].includes(value?.type)
     : value?.choices?.some(choice=>nonempty(choice.finish_reason)||['content','reasoning_content','reasoning','refusal'].some(key=>nonempty(choice.delta?.[key]))||choice.delta?.tool_calls?.some(call=>nonempty(call.id)||nonempty(call.function?.name)||nonempty(call.function?.arguments)));
    if(progress&&!idleEvents.includes(value?.type)&&!idleEvents.includes(eventName))remaining=idleMs;
    if(protocol==='responses'&&value?.error&&!['response.failed','error'].includes(value.type))throw new GatewayError(502,value.error.message||'Backend stream error',value.error);
   }
   if(protocol==='responses')terminal=['response.completed','response.incomplete','response.failed','error'].includes(value?.type);
   else terminal=raw==='[DONE]'||terminal||!!value?.choices?.some(choice=>choice.finish_reason)||!!value?.error;
   // Transport pings are comments, not fake Responses events (with undefined
   // type/sequence) that a strict client could mistake for malformed output.
   yield keepalive?': upstream-keepalive\n\n':frame+'\n\n';
   if(protocol==='responses'&&terminal||protocol==='chat'&&(raw==='[DONE]'||value?.error))return;
   // Time spent waiting for a downstream drain is not upstream idleness. It is
   // still bounded by the absolute request deadline in the gateway.
   wait();
  }
  if(!terminal)throw new GatewayError(502,'Backend stream ended before a terminal event; partial output was not retried');
 }finally{clearTimeout(timer);}
}
