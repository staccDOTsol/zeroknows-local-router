export class GatewayError extends Error {
 constructor(status,message){super(message);this.status=status;}
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
export async function readJSON(response,maxBytes=32*1024*1024){
 let bytes=0;const chunks=[];
 for await(const chunk of response.body){bytes+=chunk.length;if(bytes>maxBytes)throw new GatewayError(502,'Backend response exceeds buffer limit');chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks));}catch{throw new GatewayError(502,'Backend returned invalid JSON');}
}
export async function* sseFrames(stream,maxFrameBytes=1024*1024){
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
