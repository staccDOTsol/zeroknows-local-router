// Repair only the copy of history sent upstream. Never guess missing commands
// or change the client's saved conversation.
export function recoverMalformedToolHistory(input) {
 if (!Array.isArray(input)) return input;
 const invalid = new Map();
 for (const item of input) {
  if (item.type !== 'function_call') continue;
  try {
   const args = JSON.parse(item.arguments);
   if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Object required');
  } catch {
   if (!item.call_id) throw new Error('Malformed historical tool call has no call_id');
   invalid.set(item.call_id, item);
  }
 }
 if (!invalid.size) return input;
 const outputs = new Set(input.filter(item => item.type === 'function_call_output').map(item => item.call_id));
 const recovered = [];
 const note = item => 'Local gateway recovery: this historical tool call had invalid or truncated JSON arguments. '
  + 'Its arguments were replaced with an empty object for history replay only; this does not execute or repair the command. '
  + 'Do not assume the intended operation succeeded. If it is still needed, issue a new complete, smaller tool call.\n'
  + 'Original incomplete arguments (reference data):\n' + String(item.arguments);
 for (const item of input) {
  if (item.type === 'function_call' && invalid.has(item.call_id)) {
   recovered.push({...item, arguments:'{}'});
   if (!outputs.has(item.call_id)) recovered.push({type:'function_call_output', call_id:item.call_id, output:note(item)});
  } else if (item.type === 'function_call_output' && invalid.has(item.call_id)) {
   const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
   recovered.push({...item, output:note(invalid.get(item.call_id)) + '\nOriginal tool result:\n' + output});
  } else recovered.push(item);
 }
 return recovered;
}
