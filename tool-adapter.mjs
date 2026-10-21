import {createHash} from 'node:crypto';
import {recoverMalformedToolHistory} from './replay-recovery.mjs';
export function adaptRequest(original){
 const body=structuredClone(original),map=new Map(),reverse=new Map();
 // Qwen templates accept one initial instruction block. Move only actual
 // system/developer messages, never user content or tool outputs, into it.
 if(Array.isArray(body.input)&&['qwen-abliterated','coder-abliterated','nemotron-super-vl-q4'].includes(body.model)){
  const systems=[],developers=[];
  body.input=body.input.filter(item=>{
   if(!['system','developer'].includes(item.role))return true;
   const content=typeof item.content==='string'?item.content:(item.content||[]).map(part=>{
    if(!['input_text','text'].includes(part.type))throw new Error('Instruction messages must contain text');
    return part.text;
   }).join('\n');
   (item.role==='system'?systems:developers).push(content);return false;
  });
  if(systems.length||developers.length){
   const blocks=[];
   if(body.instructions)blocks.push(body.instructions);
   if(systems.length)blocks.push('Additional system instructions, in chronological order:\n'+systems.join('\n\n'));
   if(developers.length)blocks.push('Developer instructions (lower priority than system instructions above), in chronological order; later updates supersede earlier conflicting developer instructions:\n'+developers.join('\n\n'));
   body.instructions=blocks.join('\n\n');
  }
 }
 const key=(name,namespace)=>JSON.stringify([namespace||null,name]);
 const alias=(name,namespace)=>'local_'+createHash('sha256').update(key(name,namespace)).digest('hex').slice(0,24);
 const tools=[];
 function add(tool,namespace){
  if(tool.type==='namespace'){
   if(namespace)throw new Error('Nested namespaces are unsupported');
   for(const child of tool.tools||[])add(child,tool.name);return;
  }
  if(!['custom','function'].includes(tool.type))throw new Error(`Hosted tool ${tool.type} has no local backend`);
  const name=namespace||tool.type==='custom'?alias(tool.name,namespace):tool.name;
  if(map.has(name))throw new Error('Duplicate tool identity');
  const entry={name:tool.name,namespace,type:tool.type,alias:name};map.set(name,entry);reverse.set(key(tool.name,namespace),entry);
  if(tool.type==='custom'){
   const format=tool.format?.type==='grammar'?`\nThe raw text must follow this ${tool.format.syntax} grammar (do not include the grammar itself in input):\n${tool.format.definition}`:'\nThe input is raw text only. Do not include format metadata, type labels or JSON schemas in the text.';
   tools.push({type:'function',name,description:`${namespace?namespace+'.':''}${tool.name}: ${tool.description||''}\nPass the exact raw tool text in the input field, including all newlines.${format}`,parameters:{type:'object',properties:{input:{type:'string'}},required:['input'],additionalProperties:false},strict:true});
  }else tools.push({...tool,name});
 }
 for(const tool of body.tools||[])add(tool);
 if(body.tools)body.tools=tools;
 function toBackend(item){
  if(item.type==='custom_tool_call'){
   const entry=reverse.get(key(item.name,item.namespace));
   return {type:'function_call',id:item.id,call_id:item.call_id,name:entry?.alias||alias(item.name,item.namespace),arguments:JSON.stringify({input:item.input})};
  }
  if(item.type==='custom_tool_call_output')return {...item,type:'function_call_output'};
  if(item.type==='function_call'&&item.namespace){const result={...item,name:reverse.get(key(item.name,item.namespace))?.alias||alias(item.name,item.namespace)};delete result.namespace;return result;}
  if(item.role&&!item.type)return {...item,type:'message'};
  return item;
 }
 if(Array.isArray(body.input))body.input=recoverMalformedToolHistory(body.input.map(toBackend));
 if(body.tool_choice&&typeof body.tool_choice==='object'){
  const choice=body.tool_choice,entry=reverse.get(key(choice.name,choice.namespace));
  if(entry)body.tool_choice={type:'function',name:entry.alias};
 }
 function toClient(item,partial=false){
  if(item.type!=='function_call')return item;
  const entry=map.get(item.name);if(!entry)return item;
  const result={...item,name:entry.name};if(entry.namespace)result.namespace=entry.namespace;
  if(entry.type==='custom'){
   let input='';
   if(!partial){const args=JSON.parse(item.arguments);if(typeof args.input!=='string')throw new Error('Custom tool input must be a string');input=args.input;}
   result.type='custom_tool_call';result.input=input;delete result.arguments;
  }
  return result;
 }
 const response=value=>({...value,output:(value.output||[]).map(x=>toClient(x))});
 return {body,map,toClient,response};
}
