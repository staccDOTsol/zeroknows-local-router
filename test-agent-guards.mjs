import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelPool} from './model-router.mjs';
import {loopGuard} from './loop-guard.mjs';

const model = (id, tasks, rank) => ({id, tasks, rank, ports: [9000 + id.length], context: 65536, nativeContext: 65536, weightBytes: 2 * 1024 ** 3, kvBytesPerToken: 256, fixedCacheMiB: 0, promptCacheGiB: 1});
const pool = models => new ModelPool({models, idleEvictMs: 60000}, {async status() { return {instances: [], models: [], freeBytes: 0}; }}, {});
const tools = [{type: 'function', function: {name: 'write', parameters: {type: 'object', properties: {}}}}];
const ask = (content, extra = {}) => ({model: 'auto', messages: [{role: 'user', content}], ...extra});

test('tool requests go only to coding-capable models, ranked by coding', () => {
  const p = pool([model('small-chat', ['general'], {general: 0}), model('coder', ['general', 'coding'], {general: 2, coding: 0}), model('generalist', ['general', 'coding'], {general: 1, coding: 1})]);
  const agent = p.candidates(ask('Build the API client for token quotes', {tools}), '/v1/chat/completions');
  assert.equal(agent.info.agent, true);
  assert.deepEqual(agent.candidates.map(m => m.id), ['coder', 'generalist']);
  const chat = p.candidates(ask('hello there'), '/v1/chat/completions');
  assert.equal(chat.info.agent, false);
  assert.deepEqual(chat.candidates.map(m => m.id), ['small-chat', 'generalist', 'coder']);
});

test('tool requests fall back to the request task when no model can code', () => {
  const p = pool([model('a', ['general'], {general: 1}), model('b', ['general'], {general: 0})]);
  assert.deepEqual(p.candidates(ask('hi', {tools}), '/v1/chat/completions').candidates.map(m => m.id), ['b', 'a']);
});

test('explicit model choice is never narrowed by agent routing', () => {
  const p = pool([model('small-chat', ['general'], {general: 0}), model('coder', ['general', 'coding'], {coding: 0})]);
  assert.deepEqual(p.candidates({...ask('hi', {tools}), model: 'small-chat'}, '/v1/chat/completions').candidates.map(m => m.id), ['small-chat']);
});

const call = (id, name, args) => ({role: 'assistant', content: '', tool_calls: [{id, type: 'function', function: {name, arguments: JSON.stringify(args)}}]});
const result = (id, content) => ({role: 'tool', tool_call_id: id, content});
const note = body => {
  const out = loopGuard(body);
  return out.body === body ? null : out.body.messages.at(-1).content;
};

test('loop guard flags an identical call with an identical result', () => {
  const messages = [{role: 'user', content: 'fix it'}];
  for (let i = 0; i < 3; i++) messages.push(call('c' + i, 'bash', {command: 'cargo build'}), result('c' + i, 'error[E0425]'));
  assert.match(note({messages}), /^LOOP WARNING/);
  assert.equal(note({messages: messages.slice(0, 5)}), null);
});

test('verify guard flags four writes in a row without running anything', () => {
  const messages = [{role: 'user', content: 'build it'}];
  for (let i = 0; i < 4; i++) messages.push(call('w' + i, 'write', {filePath: `f${i}.ts`, content: String(i)}), result('w' + i, 'Wrote file successfully.'));
  assert.match(note({messages}), /^VERIFY WARNING.*4 files/);
  assert.equal(note({messages: messages.slice(0, 7)}), null);
  const checked = [...messages, call('b', 'bash', {command: 'npx tsc --noEmit'}), result('b', 'ok'), call('w9', 'write', {filePath: 'g.ts'}), result('w9', 'Wrote file successfully.')];
  assert.equal(note({messages: checked}), null);
  assert.equal(note({messages: [...messages, {role: 'assistant', content: 'done'}]}), null);
});

test('guards append to the end and leave the prefix untouched (Responses input)', () => {
  const input = [{type: 'message', role: 'user', content: [{type: 'input_text', text: 'build it'}]}];
  for (let i = 0; i < 4; i++) input.push({type: 'function_call', call_id: 'w' + i, name: 'apply_patch', arguments: String(i)}, {type: 'function_call_output', call_id: 'w' + i, output: 'Done'});
  const out = loopGuard({input});
  assert.deepEqual(out.body.input.slice(0, input.length), input);
  assert.match(out.body.input.at(-1).content[0].text, /^VERIFY WARNING/);
});

test('edit guard flags a whole-file rewrite of a file already read or written', () => {
  const messages = [{role: 'user', content: 'fix the build'},
    call('r', 'read', {filePath: 'src/a.ts'}), result('r', 'export const a = 1'),
    call('w', 'write', {filePath: 'src/a.ts', content: 'export const a = 2'}), result('w', 'Wrote file successfully.')];
  assert.match(note({messages}), /^EDIT WARNING.*src\/a\.ts/);
  const fresh = [{role: 'user', content: 'build'}, call('w', 'write', {filePath: 'src/new.ts', content: 'x'}), result('w', 'Wrote file successfully.')];
  assert.equal(note({messages: fresh}), null);
  const edited = [...messages.slice(0, 3), call('e', 'edit', {filePath: 'src/a.ts', oldString: '1', newString: '2'}), result('e', 'Edit applied.')];
  assert.equal(note({messages: edited}), null);
});
