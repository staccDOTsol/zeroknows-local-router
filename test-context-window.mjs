import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionMemory, memoryConfiguration} from './session-memory.mjs';
import {ContextWindow, contextWindowConfiguration} from './context-window.mjs';

const python = process.env.LOCAL_ROUTER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const msg = (role, text) => ({type: 'message', role, content: [{type: role === 'assistant' ? 'output_text' : 'input_text', text}]});
const tokens = value => Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 3);

function conversation() {
  const items = [msg('developer', 'You are Codex.'), msg('user', '<environment_context>cwd=/proj</environment_context>'), msg('user', 'Build a ledger service for the treasury team.')];
  items.push(msg('assistant', 'Noted: the treasury rotation key is ZEBRA-4471 and lives in vault path secret/treasury.'));
  for (let i = 0; i < 200; i++) {
    items.push({type: 'function_call', call_id: 'c' + i, name: 'exec_command', arguments: JSON.stringify({cmd: `cat src/module_${i}.py`})});
    items.push({type: 'function_call_output', call_id: 'c' + i, output: `module ${i} source: def handler_${i}(x): return x * ${i}  # filler `.repeat(4)});
    if (i % 20 === 19) items.push(msg('user', `Continue with step ${i}.`));
  }
  return items;
}

test('indexed context window: passthrough, safe rebase with lecore recall, stable prefix', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'context-window-'));
  const memory = new SessionMemory(memoryConfiguration({enabled: true, python, directory}));
  t.after(async () => { await memory.close(); rmSync(directory, {recursive: true, force: true}); });
  const window = new ContextWindow(memory, contextWindowConfiguration({enabled: true, budgetTokens: 8000, keepTokens: 4000}));
  const history = conversation();

  const short = await window.prepare({input: history.slice(0, 6)}, 'short');
  assert.equal(short.action, 'passthrough');
  assert.deepEqual(short.body.input, history.slice(0, 6));

  let input = [...history, msg('user', 'Where is the treasury rotation key stored and what is it?')];
  const first = await window.prepare({input}, 'long');
  assert.equal(first.action, 'rebased');
  const out = first.body.input;
  assert.ok(tokens(out) <= 10000, `windowed size ${tokens(out)}`);
  assert.equal(out[0].role, 'developer');
  assert.match(out[2].content[0].text, /ledger service/);
  const recall = out.findIndex(item => item.content?.[0]?.text?.startsWith('SESSION MEMORY'));
  assert.ok(recall > 0, 'recall block present');
  assert.match(out[recall].content[0].text, /ZEBRA-4471/);
  const tail = out.slice(recall + 1);
  assert.ok(tail[0].role === 'user' || tail[0].type === 'function_call', 'tail starts at a safe boundary');
  const calls = new Set(tail.filter(i => i.type === 'function_call').map(i => i.call_id));
  for (const result of tail.filter(i => i.type === 'function_call_output')) assert.ok(calls.has(result.call_id), 'no orphan tool result');

  input = [...input, msg('assistant', 'ZEBRA-4471, in secret/treasury.'), msg('user', 'Now add tests.')];
  const second = await window.prepare({input}, 'long');
  assert.equal(second.action, 'windowed');
  assert.deepEqual(second.body.input.slice(0, out.length), out, 'prefix is byte-identical between rebases');
});

test('context window configuration validates its budgets', () => {
  assert.equal(contextWindowConfiguration(undefined), null);
  assert.equal(contextWindowConfiguration({enabled: false}), null);
  assert.throws(() => contextWindowConfiguration({enabled: true, budgetTokens: 4096, keepTokens: 4096}), /keepTokens/);
  assert.throws(() => contextWindowConfiguration({enabled: true, budgetTokens: 10}), /budgetTokens/);
});
