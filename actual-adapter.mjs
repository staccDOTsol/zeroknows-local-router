// Stateless Responses -> OpenAI Chat Completions bridge. Actual is enabled only
// through an explicit loopback backend configuration, after capability checks.
import {randomUUID} from 'node:crypto';
import {GatewayError,sseFrames,frameData} from './gateway-runtime.mjs';
const id=prefix=>prefix+'_'+randomUUID().replaceAll('-','');
export function toChat(body,capabilities={}){
 if(body.reasoning?.effort&&!['none'].includes(body.reasoning.effort)&&!capabilities.reasoning)throw new GatewayError(400,'This backend has no verified reasoning-effort support');
 const messages=[];
 if(body.instructions)messages.push({role:'system',content:body.instructions});
 const input=typeof body.input==='string'?[{role:'user',content:body.input}]:body.input||[];
 for(const item of input){
  if(item.type==='function_call'){
   const call={id:item.call_id||item.id,type:'function',function:{name:item.name,arguments:item.arguments}};
   if(messages.at(-1)?.role==='assistant'){(messages.at(-1).tool_calls??=[]).push(call);}else messages.push({role:'assistant',content:null,tool_calls:[call]});continue;
  }
  if(item.type==='function_call_output'){
   messages.push({role:'tool',tool_call_id:item.call_id,content:typeof item.output==='string'?item.output:JSON.stringify(item.output)});continue;
  }
  if(item.type==='reasoning')throw new GatewayError(400,'Opaque reasoning replay is not supported by the chat backend');
  if(item.type&&item.type!=='message')throw new GatewayError(400,`Unsupported replay item: ${item.type}`);
  if(!['user','assistant','system','developer'].includes(item.role))throw new GatewayError(400,'Unsupported message role');
  const content=typeof item.content==='string'?item.content:(item.content||[]).map(part=>{
   if(['input_text','output_text','text'].includes(part.type))return {type:'text',text:part.text};
   if(part.type==='input_image'){
    if(!capabilities.vision)throw new GatewayError(400,'Vision is not enabled for this backend');
    if(!part.image_url)throw new GatewayError(400,'Image URL required');
    return {type:'image_url',image_url:{url:part.image_url,detail:part.detail||'auto'}};
   }
   throw new GatewayError(400,`Unsupported content part: ${part.type}`);
  });
  messages.push({role:item.role==='developer'?'system':item.role,content});
 }
 if(body.tools?.length&&!capabilities.tools)throw new GatewayError(400,'Tools are not enabled for this backend');
 const result={model:body.model,messages,stream:!!body.stream,max_tokens:body.max_output_tokens??2048};
 for(const key of ['temperature','top_p','seed','parallel_tool_calls'])if(body[key]!==undefined)result[key]=body[key];
 if(body.tools)result.tools=body.tools.map(({type,name,description,parameters,strict})=>({type:'function',function:{name,description,parameters,strict}}));
 if(body.tool_choice)result.tool_choice=typeof body.tool_choice==='string'?body.tool_choice:{type:'function',function:{name:body.tool_choice.name}};
 if(body.text?.format){const format=body.text.format;if(!capabilities.structuredOutput)throw new GatewayError(400,'Structured output is not enabled for this backend');result.response_format=format.type==='json_schema'?{type:'json_schema',json_schema:{name:format.name,schema:format.schema,strict:format.strict}}:format;}
 if(body.reasoning?.effort&&capabilities.reasoning)result.reasoning_effort=body.reasoning.effort;
 if(body.stream)result.stream_options={include_usage:true};
 return result;
}
export function createResponse(body){return {id:id('resp'),object:'response',created_at:Math.floor(Date.now()/1000),model:body.model,status:'in_progress',output:[]};}
function usage(u={}){return {input_tokens:u.prompt_tokens||0,output_tokens:u.completion_tokens||0,total_tokens:u.total_tokens||0,input_tokens_details:{cached_tokens:u.prompt_tokens_details?.cached_tokens||0}};}
function finish(response,reason,u){return {...response,status:reason==='length'?'incomplete':'completed',completed_at:Math.floor(Date.now()/1000),...(reason==='length'?{incomplete_details:{reason:'max_output_tokens'}}:{}),usage:usage(u)};}
export function fromChat(value,body,adapter){
 const choice=value.choices?.[0];if(!choice)throw new GatewayError(502,'Chat backend returned no choice');
 const response=createResponse(body),message=choice.message;
 if(message.content)response.output.push({type:'message',id:id('msg'),role:'assistant',status:'completed',content:[{type:'output_text',text:message.content,annotations:[]}]});
 for(const call of message.tool_calls||[])response.output.push({type:'function_call',id:id('fc'),call_id:call.id||id('call'),name:call.function.name,arguments:call.function.arguments,status:'completed'});
 return adapter.response(finish(response,choice.finish_reason,value.usage));
}
export async function* chatEvents(stream,body){
 const response=createResponse(body);let sequence=0,message=null,text='',reason=null,tokenUsage,finished=false,bytes=0;
 const calls=new Map();
 const emit=event=>`event: ${event.type}\ndata: ${JSON.stringify({...event,sequence_number:sequence++})}\n\n`;
 yield emit({type:'response.created',response});
 yield emit({type:'response.in_progress',response});
 for await(const frame of sseFrames(stream)){
  const raw=frameData(frame);if(!raw)continue;if(raw==='[DONE]'){finished=true;break;}
  const chunk=JSON.parse(raw);if(chunk.error)throw new GatewayError(502,chunk.error.message||'Chat backend stream error');
  if(chunk.usage)tokenUsage=chunk.usage;
  const choice=chunk.choices?.[0];if(!choice)continue;
  const delta=choice.delta||{};if(choice.finish_reason)reason=choice.finish_reason;
  if(delta.content){
   bytes+=Buffer.byteLength(delta.content);if(bytes>512*1024*1024)throw new GatewayError(502,'Accumulated output exceeds limit');
   if(!message){message={type:'message',id:id('msg'),role:'assistant',status:'in_progress',content:[]};response.output.push(message);yield emit({type:'response.output_item.added',output_index:response.output.indexOf(message),item:message});yield emit({type:'response.content_part.added',item_id:message.id,output_index:response.output.indexOf(message),content_index:0,part:{type:'output_text',text:'',annotations:[]}});}
   text+=delta.content;yield emit({type:'response.output_text.delta',item_id:message.id,output_index:response.output.indexOf(message),content_index:0,delta:delta.content});
  }
  for(const tool of delta.tool_calls||[]){
   if(!Number.isInteger(tool.index)||tool.index<0||tool.index>=128)throw new GatewayError(502,'Invalid tool index');
   let call=calls.get(tool.index);
   if(!call){call={type:'function_call',id:id('fc'),call_id:tool.id||id('call'),name:'',arguments:'',status:'in_progress'};calls.set(tool.index,call);response.output.push(call);}
   if(tool.id)call.call_id=tool.id;
   if(tool.function?.name)call.name+=tool.function.name;
   const args=tool.function?.arguments||'';call.arguments+=args;bytes+=Buffer.byteLength(args);if(bytes>512*1024*1024)throw new GatewayError(502,'Accumulated tool input exceeds limit');
  }
 }
 if(!reason)throw new GatewayError(502,'Chat backend stream ended without a finish reason');
 // Buffer tool names/arguments until complete: providers may split a function
 // name across chunks. Text remains incremental; raw custom text stays exact.
 for(const call of calls.values()){
  if(!call.name)throw new GatewayError(502,'Backend tool call has no name');
  const index=response.output.indexOf(call),args=call.arguments;
  yield emit({type:'response.output_item.added',output_index:index,item:{...call,arguments:''}});
  yield emit({type:'response.function_call_arguments.delta',item_id:call.id,output_index:index,delta:args});
  yield emit({type:'response.function_call_arguments.done',item_id:call.id,output_index:index,arguments:args});
  call.status='completed';yield emit({type:'response.output_item.done',output_index:index,item:call});
 }
 if(message){const index=response.output.indexOf(message);message.status='completed';message.content=[{type:'output_text',text,annotations:[]}];yield emit({type:'response.output_text.done',item_id:message.id,output_index:index,content_index:0,text});yield emit({type:'response.content_part.done',item_id:message.id,output_index:index,content_index:0,part:message.content[0]});yield emit({type:'response.output_item.done',output_index:index,item:message});}
 const final=finish(response,reason,tokenUsage);yield emit({type:final.status==='incomplete'?'response.incomplete':'response.completed',response:final});
}
