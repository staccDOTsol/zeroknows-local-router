// Loop guard: local models sometimes re-run the same tool call and get the same
// result dozens of times without changing anything. When the latest tool call has
// been repeated with identical arguments and identical output at least `threshold`
// times, append one short user note to the end of the request. Appending keeps the
// forwarded prefix (and the backend prompt cache) unchanged. Works for Responses
// `input` items and Chat Completions `messages`.
const callTypes = new Set(['function_call', 'custom_tool_call']);
const outputTypes = new Set(['function_call_output', 'custom_tool_call_output']);
const text = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');

function toolPairs(items, chat) {
  const outputs = new Map(), calls = [];
  for (const item of items) {
    if (chat) {
      if (item?.role === 'tool') outputs.set(item.tool_call_id, text(item.content));
      else if (item?.role === 'assistant' && Array.isArray(item.tool_calls)) {
        for (const call of item.tool_calls) calls.push({id: call.id, name: call.function?.name, args: text(call.function?.arguments)});
      }
    } else if (outputTypes.has(item?.type)) outputs.set(item.call_id, text(item.output));
    else if (callTypes.has(item?.type)) calls.push({id: item.call_id, name: item.name, args: text(item.arguments ?? item.input)});
  }
  return calls.filter(call => outputs.has(call.id)).map(call => ({...call, output: outputs.get(call.id), signature: `${call.name}\u0000${call.args}`}));
}

const isWrite = name => /write|edit|patch|create|replace/i.test(name ?? '');
const isRun = name => /bash|shell|exec|command|terminal|run/i.test(name ?? '');

export function loopGuard(body, {threshold = 3, window = 40, unverifiedWrites = 4} = {}) {
  const chat = Array.isArray(body?.messages);
  const items = chat ? body.messages : body?.input;
  if (!Array.isArray(items) || !items.length) return {body, repeats: 0};
  // Only intervene when the most recent item is a tool result (the model is about to act on it).
  const tail = items[items.length - 1];
  if (!(chat ? tail?.role === 'tool' : outputTypes.has(tail?.type))) return {body, repeats: 0};
  const pairs = toolPairs(items, chat).slice(-window);
  if (!pairs.length) return {body, repeats: 0};
  const last = pairs[pairs.length - 1];
  const repeats = pairs.filter(pair => pair.signature === last.signature && pair.output === last.output).length;
  let note;
  if (repeats >= threshold) {
    const shown = last.args.length > 300 ? last.args.slice(0, 300) + '...' : last.args;
    note = `LOOP WARNING from the local gateway: you have called ${last.name} with the same arguments ${repeats} times and received the identical result each time (${shown}). `
      + 'Running it again will not change the result. Read the error message carefully, change the code or input that causes it, and only then run it again; or try a different approach.';
  } else {
    // Local models tend to scaffold file after file without ever running anything.
    let writes = 0;
    for (let i = pairs.length - 1; i >= 0 && !isRun(pairs[i].name); i--) if (isWrite(pairs[i].name)) writes++;
    if (writes < unverifiedWrites) return {body, repeats};
    note = `VERIFY WARNING from the local gateway: you have written ${writes} files in a row without running anything. `
      + 'Before writing another file, run a check that covers what you wrote: install dependencies if they are missing, then run the typecheck, build or tests. Fix what fails first.';
  }
  const message = chat ? {role: 'user', content: note} : {type: 'message', role: 'user', content: [{type: 'input_text', text: note}]};
  return {body: {...body, [chat ? 'messages' : 'input']: [...items, message]}, repeats};
}
