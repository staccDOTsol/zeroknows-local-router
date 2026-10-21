import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelPool, classify, readRegistry} from './model-router.mjs';
import {modelFingerprint, memoryEstimate, validateRoutingPolicy, evaluationFor} from './routing-policy.mjs';

// SYNTHETIC policy fixtures only. These scores are not model benchmarks.
const GiB = 1024 ** 3, NOW = Date.parse('2026-10-21T00:00:00Z');
const request = (extra = {}) => ({model: 'auto', input: 'Hello', max_output_tokens: 32, ...extra});
const imageRequest = () => request({input: [{type: 'input_image', image_url: 'data:image/png;base64,YQ=='}]});
function model(id, extra = {}) {
  return {id, tasks: ['general', 'coding', 'reasoning'], ports: [22001, 22101],
    context: 65536, nativeContext: 65536, weightBytes: 2 * GiB, kvBytesPerToken: 256,
    fixedCacheMiB: 0, promptCacheGiB: 1,
    files: [{path: `${id}.gguf`, role: 'model', bytes: 2 * GiB, sha256: 'a'.repeat(64), verificationJournal: 'synthetic.log'}],
    routing: {auto: true, compatibility: {status: 'verified', runtimeId: 'synthetic-runtime', evidence: 'synthetic-smoke-test'}, capabilities: {text: true}},
    ...extra};
}
function instance(m) {return {key: `${m.id}-0`, model: m.id, ready: true, slots: 1, replica: 0, port: m.ports[0], context: m.context};}
function fixture(models, {warm = [], freeBytes = 100 * GiB, version = 2} = {}) {
  const registry = {models, runtimeId: 'synthetic-runtime', memoryMode: 'uma', serverPath: 'never-started.exe', idleEvictMs: 60000, routingPolicy: {version}};
  const controller = {instances: warm.map(instance), starts: [],
    async status() {return {instances: this.instances, freeBytes, models: models.map(m => ({id: m.id, ready: true}))};},
    async start(m, replica, slots) {this.starts.push(m.id);const i = {...instance(m), replica, slots};this.instances.push(i);return i;},
  };
  return {registry, controller, pool: new ModelPool(registry, controller, {queueMs: 100, pollMs: 1})};
}
function evaluation(m, score = 0.5, extra = {}) {
  return {kind: 'measured', task: 'general', suite: 'synthetic-only', suiteVersion: '1', metric: 'pass_rate', score, samples: 20,
    contextTokens: 65536, runtimeId: 'synthetic-runtime', modelFingerprint: modelFingerprint(m),
    recordedAt: '2026-10-20T00:00:00Z', evidence: 'synthetic-fixture-not-a-benchmark', harnessVersion: 'fixture-1', ...extra};
}
function suite(registry, extra = {}) {registry.routingPolicy.qualitySuites = {general: {suite: 'synthetic-only', version: '1', metric: 'pass_rate', minSamples: 10, maxAgeDays: 30, ...extra}};}

test('legacy registry keeps its original routes without claiming verified compatibility', async () => {
  const m = model('legacy-model');delete m.routing;
  const {pool} = fixture([m], {version: 1, warm: [m]});
  const lease = await pool.acquire(request(), '/v1/responses');lease.release();
  assert.equal(lease.selection.compatibility, 'legacy_operator_configured');
  assert.equal(lease.selection.quality.status, 'unverified');
  assert.equal((await pool.status()).routing_policy_version, 1);
});

test('strict routing fails closed on unknown runtime, capabilities and auto opt-in', () => {
  const m = model('strict-model'), {pool} = fixture([m]);
  m.routing.compatibility.status = 'unverified';
  assert.throws(() => pool.candidates(request(), '/v1/responses'), /runtime_compatibility_unverified/);
  m.routing.compatibility.status = 'verified';m.routing.auto = false;
  assert.throws(() => pool.candidates(request(), '/v1/responses'), /automatic_routing_disabled/);
  assert.equal(pool.candidates(request({model: m.id}), '/v1/responses').candidates[0].id, m.id);
  delete m.routing;
  assert.throws(() => pool.candidates(request({model: m.id}), '/v1/responses'), /runtime_compatibility_unverified/);
});

test('new disabled candidate cannot be activated inside a legacy registry or manually loaded', async () => {
  const m = model('pending-model');m.routing = {auto: false, compatibility: {status: 'unverified'}, capabilities: {}};
  const {pool, controller} = fixture([m], {version: 1});
  assert.throws(() => pool.candidates(request(), '/v1/responses'), /runtime_compatibility_unverified/);
  await assert.rejects(pool.manual('load', m.id), /runtime_compatibility_unverified/);
  assert.deepEqual(controller.starts, []);
});

test('tools, tool history, structured output and images have independent gates', () => {
  const m = model('strict-model'), {pool} = fixture([m]);
  const histories = ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'tool_use', 'tool_result'].map(type => request({input: [{type, call_id: 'a', output: 'ok'}]}));
  histories.push(request({messages: [{role: 'function', content: 'ok'}], input: undefined}), request({messages: [{role: 'assistant', function_call: {name: 'read', arguments: '{}'}}], input: undefined}));
  for (const body of [request({tools: [{type: 'function', name: 'read'}]}), ...histories]) {
    assert.throws(() => pool.candidates(body, '/v1/responses'), /capability_tools_unverified/);
  }
  assert.throws(() => pool.candidates(request({text: {format: {type: 'json_schema', schema: {type: 'object'}}}}), '/v1/responses'), /capability_json_unverified/);
  assert.throws(() => pool.candidates(imageRequest(), '/v1/responses'), /capability_vision_unverified/);
  m.routing.capabilities.tools = true;m.routing.capabilities.json = true;
  assert.equal(pool.candidates(request({tools: [{type: 'function', name: 'read'}], response_format: {type: 'json_object'}}), '/v1/responses').candidates.length, 1);
});

test('context estimates count output, UTF-8, tool schemas, JSON keys, arrays and primitives', () => {
  const body = request({input: '😀', tools: [{type: 'function', parameters: {properties: {["x".repeat(800)]: {enum: Array(500).fill(null)}}}}]});
  const info = classify(body, '/v1/responses');
  assert.ok(info.inputTokens >= Buffer.byteLength(JSON.stringify(body.tools)));
  assert.equal(info.tokens, info.inputTokens + 32);
  assert.equal(info.outputTokens, 32);
  assert.ok(info.requirements.includes('tools'));
});

test('request demand is reported but cold admission retains full-context reservation', () => {
  const m = model('memory-model'), info = classify(request(), '/v1/responses');
  const estimate = memoryEstimate(m, info, 2), {pool} = fixture([m]);
  assert.ok(estimate.requestKvBytes < estimate.allocatedKvBytes);
  assert.equal(estimate.allocatedKvBytes, m.kvBytesPerToken * m.context * 2);
  assert.equal(pool.required(m, 2), estimate.coldRequiredBytes);
  assert.equal(estimate.headroomBytes, 16 * GiB);
});

test('cold-fit candidate wins over an infeasible higher-ranked model without attempting its load', async () => {
  const large = model('large-model', {weightBytes: 10 * GiB, rank: {general: 0}}), small = model('small-model', {rank: {general: 99}});
  const {pool, controller} = fixture([large, small], {freeBytes: 30 * GiB});
  const lease = await pool.acquire(request(), '/v1/responses');
  assert.equal(lease.model, small.id);assert.deepEqual(controller.starts, [small.id]);lease.release();
});

test('matching measured quality wins over model size and operator rank within a ready tier', async () => {
  const small = model('small-model', {rank: {general: 0}}), large = model('large-model', {weightBytes: 10 * GiB, rank: {general: 99}});
  small.routing.evaluations = [evaluation(small, 0.4)];large.routing.evaluations = [evaluation(large, 0.9)];
  const {pool, registry} = fixture([small, large], {warm: [small, large]});suite(registry);pool.now = () => NOW;
  const lease = await pool.acquire(request(), '/v1/responses');
  assert.equal(lease.model, large.id);assert.equal(lease.selection.quality.score, 0.9);lease.release();
});

test('incomparable, stale, wrong-file and short-context evaluations remain unverified', () => {
  const m = model('eval-model'), {registry} = fixture([m]);suite(registry);
  const info = classify(request(), '/v1/responses');
  for (const extra of [{suite: 'different'}, {suiteVersion: '2'}, {metric: 'accuracy'}, {runtimeId: 'different'}, {modelFingerprint: 'b'.repeat(64)}, {samples: 2}, {contextTokens: 512}, {recordedAt: '2020-01-01T00:00:00Z'}, {recordedAt: '2030-01-01T00:00:00Z'}]) {
    m.routing.evaluations = [evaluation(m, 0.9, extra)];assert.equal(evaluationFor(m, info, registry, NOW), null);
  }
  m.routing.evaluations = [evaluation(m, 0.8)];assert.equal(evaluationFor(m, info, registry, NOW).score, 0.8);
});

test('required task evaluation is opt-in and does not override explicit model choice', () => {
  const m = model('eval-model'), {registry, pool} = fixture([m]);suite(registry, {requireEvaluation: true});
  assert.throws(() => pool.candidates(request(), '/v1/responses'), /task_evaluation_unverified/);
  assert.equal(pool.candidates(request({model: m.id}), '/v1/responses').candidates.length, 1);
});

test('ready capacity stays ahead of cold measured quality; no unnecessary model fanout', async () => {
  const warm = model('warm-model'), cold = model('cold-model');cold.routing.evaluations = [evaluation(cold, 1)];
  const {pool, registry, controller} = fixture([cold, warm], {warm: [warm]});suite(registry);pool.now = () => NOW;
  const lease = await pool.acquire(request(), '/v1/responses');assert.equal(lease.model, warm.id);assert.deepEqual(controller.starts, []);lease.release();
});

test('score ties are deterministic by id, regardless of registry order, and explain without prompt text', async () => {
  const a = model('a-model'), b = model('b-model');
  for (const models of [[a, b], [b, a]]) {
    const {pool} = fixture(models, {warm: models});
    const explanation = await pool.explain(request({input: 'PRIVATE_PROMPT'}), '/v1/responses');
    assert.equal(explanation.candidates[0].id, a.id);assert.ok(!JSON.stringify(explanation).includes('PRIVATE_PROMPT'));
    assert.equal(explanation.candidates[0].quality.status, 'unverified');
  }
});

function modes() {
  const text = model('muse-text');text.routing.mode = 'text';
  const vision = model('muse-vision', {tasks: ['general', 'vision'], weightBytes: text.weightBytes + GiB,
    files: [...text.files, {path: 'shared-projector.gguf', role: 'projector', bytes: GiB, sha256: 'b'.repeat(64), verificationJournal: 'synthetic.log'}]});
  vision.routing.mode = 'vision';vision.routing.capabilities.vision = true;
  return {text, vision};
}

test('AUTO cold text prefers text mode; image request requires verified vision mode', async () => {
  const {text, vision} = modes(), {pool, controller} = fixture([vision, text]);
  const a = await pool.acquire(request(), '/v1/responses');assert.equal(a.model, text.id);a.release();
  const b = await pool.acquire(imageRequest(), '/v1/responses');assert.equal(b.model, vision.id);b.release();
  assert.deepEqual(controller.starts, [text.id, vision.id]);
  assert.throws(() => pool.candidates({...imageRequest(), model: text.id}, '/v1/responses'), /capability_vision_unverified/);
});

test('warm compatible vision serves text without loading duplicate shared weights', async () => {
  const {text, vision} = modes(), {pool, controller} = fixture([text, vision], {warm: [vision]});
  const lease = await pool.acquire(request(), '/v1/responses');assert.equal(lease.model, vision.id);assert.deepEqual(controller.starts, []);lease.release();
  const textBudget = pool.required(text), visionBudget = pool.required(vision);
  assert.equal(visionBudget - textBudget, GiB); // No cross-process weight subtraction.
  assert.equal(text.files[0].path, vision.files[0].path);
});

test('strict schema rejects unsupported claims, unknown modes and fabricated benchmark-shaped data', () => {
  const {text, vision} = modes();const {registry} = fixture([text, vision]);validateRoutingPolicy(registry);
  text.routing.mode = 'vision';assert.throws(() => validateRoutingPolicy(registry), /projector/);text.routing.mode = 'text';
  text.routing.compatibility.runtimeId = 'wrong';assert.throws(() => validateRoutingPolicy(registry), /runtimeId/);text.routing.compatibility.runtimeId = registry.runtimeId;
  text.routing.evaluations = [{...evaluation(text), kind: 'card_claim'}];assert.throws(() => validateRoutingPolicy(registry), /measured evaluation/);
  text.routing.evaluations = [evaluation(text, 2)];assert.throws(() => validateRoutingPolicy(registry), /measured evaluation/);
});

test('registry reader validates strict policy and preserves legacy registry parsing', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-policy-'));t.after(() => rmSync(directory, {recursive: true, force: true}));
  const path = join(directory, 'registry.json'), m = model('read-model'), {registry} = fixture([m]);
  writeFileSync(path, '\ufeff' + JSON.stringify(registry));assert.equal(readRegistry(path).routingPolicy.version, 2);
  delete registry.routingPolicy;delete m.routing;delete registry.runtimeId;
  writeFileSync(path, JSON.stringify(registry));assert.equal(readRegistry(path).models[0].id, m.id);
});

test('cancellation during inventory refresh creates neither a lease nor a new load', async () => {
  const m = model('cancel-model'), {pool, controller} = fixture([m], {warm: [m]});
  const abort = new AbortController();let resolveStatus;
  controller.status = () => new Promise(resolve => {resolveStatus = resolve;});
  const pending = pool.acquire(request(), '/v1/responses', abort.signal);
  abort.abort(new Error('cancelled during refresh'));
  resolveStatus({instances: controller.instances, models: [{id: m.id, ready: true}], freeBytes: 100 * GiB});
  await assert.rejects(pending, /cancelled during refresh/);
  assert.equal(pool.waiters, 0);assert.equal(pool.leases.size, 0);assert.deepEqual(controller.starts, []);
});

test('measured cold-load latency is a cost tie-break only for matching hardware/runtime/files', async () => {
  const a = model('a-model'), b = model('b-model');
  b.routing.coldLoad = {milliseconds: 100, samples: 3, evidence: 'synthetic-only', runtimeId: 'synthetic-runtime', environmentId: 'test-uma', recordedAt: '2026-10-20T00:00:00Z', modelFingerprint: modelFingerprint(b)};
  const {pool, registry} = fixture([a, b]);registry.environmentId = 'test-uma';
  let explanation = await pool.explain(request(), '/v1/responses');
  assert.equal(explanation.candidates[0].id, b.id);
  registry.environmentId = 'different-hardware';
  explanation = await pool.explain(request(), '/v1/responses');
  assert.equal(explanation.candidates[0].id, a.id);
  assert.equal(explanation.candidates.find(row => row.id === b.id).coldLoadMs, null);
});

test('undersized warm instance does not block loading an eligible bounded replica', async () => {
  const m = model('context-model'), {pool, controller} = fixture([m], {warm: [m]});
  controller.instances[0].context = 512;
  controller.start = async function (model, replica, slots) {
    this.starts.push(model.id);
    const i = {...instance(model), key: `${model.id}-${replica}`, replica, port: model.ports[replica], slots};
    this.instances.push(i);return i;
  };
  const lease = await pool.acquire(request(), '/v1/responses');
  assert.equal(lease.instance.replica, 1);assert.equal(controller.starts.length, 1);lease.release();
});

test('score memory explains the actual resident two-slot allocation', async () => {
  const m = model('slots-model'), {pool, controller} = fixture([m], {warm: [m]});controller.instances[0].slots = 2;
  const explanation = await pool.explain(request(), '/v1/responses');
  assert.equal(explanation.candidates[0].allocationSlots, 2);
  assert.equal(explanation.candidates[0].allocatedKvBytes, m.context * m.kvBytesPerToken * 2);
});
