import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {buildCodexCatalog, readCatalogTemplate} from './model-catalog.mjs';
import {exportCatalog} from './export-codex-catalog.mjs';
import {configuration, createGateway} from './proxy.mjs';

const definitions = [
  {id: 'local-code', context: 8192, tasks: ['general', 'coding', 'reasoning']},
  {id: 'local-vision', context: 16384, tasks: ['vision', 'general']},
  {id: 'local-embed', context: 512, tasks: ['embedding']},
];
function temp(t) {
  const path = mkdtempSync(join(tmpdir(), 'local-catalog-'));
  t.after(() => rmSync(path, {recursive: true, force: true}));
  return path;
}
function registry(models = definitions) {
  return {memoryMode: 'uma', serverPath: 'not-executed.exe', idleEvictMs: 60000,
    models: models.map((model, index) => ({...model, nativeContext: model.context,
      ports: [19001 + index], kvBytesPerToken: 1, fixedCacheMiB: 0, promptCacheGiB: 0,
      weightBytes: 1, embeddingDimensions: 2,
      files: [{path: 'not-loaded.gguf', bytes: 1, sha256: 'a'.repeat(64),
        role: 'model', verificationJournal: 'not-read.log'}]}))};
}

test('native Codex catalog includes visible, highest-priority AUTO and conversational models only', () => {
  const catalog = buildCodexCatalog(definitions);
  assert.deepEqual(catalog.models.map(model => model.slug), ['auto', 'local-code', 'local-vision']);
  const auto = catalog.models[0];
  assert.equal(auto.visibility, 'list');
  assert.equal(auto.supported_in_api, true);
  assert.ok(catalog.models.slice(1).every(model => auto.priority < model.priority));
  assert.equal(auto.context_window, 8192);
  assert.equal(auto.max_context_window, 8192);
  assert.deepEqual(auto.input_modalities, ['text', 'image']);
  assert.deepEqual(catalog.models[1].input_modalities, ['text']);
  assert.equal(catalog.models[2].context_window, 16384);
  assert.ok(catalog.models.every(model => typeof model.base_instructions === 'string'));
});

test('stale templates cannot hide AUTO, advertise retired models, or overstate registry capabilities', () => {
  const template = {models: [
    {slug: 'auto', display_name: 'My AUTO', visibility: 'hide', hidden: true, isDefault: false, show_in_picker: false, id: 'wrong', model: 'wrong', supported_in_api: false, priority: 999, context_window: 999999},
    {slug: 'local-code', base_instructions: 'Keep my instructions', input_modalities: ['image', 'audio'], max_context_window: 999999},
    {slug: 'retired-model', visibility: 'list'},
  ]};
  const before = structuredClone(template);
  const {models} = buildCodexCatalog(definitions, template);
  assert.equal(models[0].display_name, 'My AUTO');
  assert.equal(models[0].visibility, 'list');
  assert.equal(models[0].priority, -1);
  assert.equal(models[0].supported_in_api, true);
  for (const key of ['hidden', 'isDefault', 'show_in_picker', 'id', 'model']) assert.equal(Object.hasOwn(models[0], key), false);
  assert.equal(models[1].base_instructions, 'Keep my instructions');
  assert.equal(models[1].max_context_window, 8192);
  assert.deepEqual(models[1].input_modalities, ['text']);
  assert.equal(models.some(model => model.slug === 'retired-model'), false);
  assert.deepEqual(template, before);
});

test('text-only AUTO does not advertise images; invalid and embedding-only registries fail clearly', () => {
  assert.deepEqual(buildCodexCatalog([definitions[0]]).models[0].input_modalities, ['text']);
  assert.throws(() => buildCodexCatalog([definitions[2]]), /conversational/);
  assert.throws(() => buildCodexCatalog([{...definitions[0], context: NaN}]), /context/);
  assert.throws(() => buildCodexCatalog([{...definitions[0], id: 'auto'}]), /reserved/);
  assert.throws(() => buildCodexCatalog([definitions[0], definitions[0]]), /duplicate/);
  assert.throws(() => buildCodexCatalog(definitions, {models: [{slug: 'auto'}, {slug: 'auto'}]}), /duplicate/);
  assert.throws(() => buildCodexCatalog(definitions, {models: [null]}), /invalid/);
});

test('optional template handles missing files and Windows BOM but does not swallow invalid JSON', t => {
  const path = join(temp(t), 'template.json');
  assert.deepEqual(readCatalogTemplate(path, {optional: true}), {models: []});
  assert.throws(() => readCatalogTemplate(path), {code: 'ENOENT'});
  writeFileSync(path, '\uFEFF{"models":[]}');
  assert.deepEqual(readCatalogTemplate(path), {models: []});
  writeFileSync(path, '{');
  assert.throws(() => readCatalogTemplate(path, {optional: true}), SyntaxError);
  writeFileSync(path, '{"models":[{"slug":"auto"},{"slug":"auto"}]}');
  assert.throws(() => readCatalogTemplate(path), /duplicate/);
});

test('export derives catalog from validated registry without loading models and never overwrites', t => {
  const dir = temp(t), registryPath = join(dir, 'registry.json'), output = join(dir, 'catalog.json');
  writeFileSync(registryPath, JSON.stringify(registry()));
  const exported = exportCatalog({registry: registryPath, output});
  assert.deepEqual(exported.models, ['auto', 'local-code', 'local-vision']);
  const original = readFileSync(output, 'utf8');
  assert.deepEqual(JSON.parse(original), buildCodexCatalog(definitions));
  assert.throws(() => exportCatalog({registry: registryPath, output}), {code: 'EEXIST'});
  assert.equal(readFileSync(output, 'utf8'), original);
});

async function catalogGateway(t, config) {
  config.port = 18996;
  const gateway = createGateway(config, {log: false});
  gateway.listen(config.port, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => new Promise(resolve => {gateway.closeAllConnections(); gateway.close(resolve);}));
  return () => fetch(`http://127.0.0.1:${config.port}/codex/models.json`);
}

test('managed HTTP catalog synthesizes AUTO without the ignored catalog file or a controller call', async t => {
  const config = configuration();
  config.codexCatalog = join(temp(t), 'missing.json');
  config.pool = {registry: {models: definitions}, status() {throw new Error('Must not start a controller');}};
  const get = await catalogGateway(t, config);
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), buildCodexCatalog(definitions));
  config.pool.registry.models = [definitions[0]];
  assert.deepEqual((await (await get()).json()).models.map(model => model.slug), ['auto', 'local-code']);
});

test('managed HTTP catalog repairs stale AUTO metadata; unmanaged catalog remains unchanged', async t => {
  const config = configuration(), templatePath = join(temp(t), 'template.json');
  const template = {models: [{...buildCodexCatalog([definitions[0]]).models[0], visibility: 'hide'}]};
  writeFileSync(templatePath, JSON.stringify(template));
  config.codexCatalog = templatePath;
  const get = await catalogGateway(t, config);
  assert.deepEqual(await (await get()).json(), template);
  config.pool = {registry: {models: definitions}};
  assert.equal((await (await get()).json()).models[0].visibility, 'list');
});

// Opt-in contract test against the installed official CLI. No inference, login,
// model weights, network provider, or user Codex home is used.
async function officialModelList(t, dir, catalogArgs) {
  const child = spawn(process.env.CODEX_CATALOG_TEST_BIN, ['app-server', '--listen', 'stdio://',
    ...catalogArgs,
    '-c', 'model_provider="local_catalog_test"',
    '-c', 'model_providers.local_catalog_test.name="Local catalog test"',
    '-c', 'model_providers.local_catalog_test.base_url="http://127.0.0.1:1/v1"',
    '-c', 'model_providers.local_catalog_test.wire_api="responses"',
    '-c', 'model_providers.local_catalog_test.requires_openai_auth=false'],
  {env: {PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, CODEX_HOME: dir,
    HOME: dir, USERPROFILE: dir}, stdio: ['pipe', 'pipe', 'pipe']});
  t.after(() => {child.stdin.destroy(); child.kill();});
  let errors = '';
  child.stderr.on('data', chunk => {errors += chunk;});
  const lines = createInterface({input: child.stdout});
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  try {
    return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('model/list timed out: ' + errors)), 20000);
    const finish = (error, value) => {clearTimeout(timeout); error ? reject(error) : resolve(value);};
    child.on('error', error => finish(error));
    child.on('exit', code => finish(new Error(`app-server exited ${code}: ${errors}`)));
    lines.on('line', line => {
      let message; try {message = JSON.parse(line);} catch {return;}
      if (message.error) return finish(new Error(JSON.stringify(message.error)));
      if (message.id === 1) {
        send({method: 'initialized', params: {}});
        send({id: 2, method: 'model/list', params: {includeHidden: true}});
      }
      if (message.id === 2) finish(null, message.result);
    });
    send({id: 1, method: 'initialize', params: {clientInfo: {name: 'local_catalog_test', version: '1.0'}}});
    });
  } finally {
    lines.close();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
  }
}
function assertOfficialAuto(result) {
  assert.deepEqual(result.data.map(model => model.model), ['auto', 'local-code', 'local-vision']);
  assert.equal(result.data[0].hidden, false);
  assert.equal(result.data[0].isDefault, true);
  assert.equal(result.data[0].displayName, 'AUTO (local)');
  assert.equal(result.nextCursor, null);
}
const officialOptions = {skip: !process.env.CODEX_CATALOG_TEST_BIN, timeout: 30000};
test('official app-server model/list accepts exported AUTO as visible and default', officialOptions, async t => {
  const dir = temp(t), catalogPath = join(dir, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify(buildCodexCatalog(definitions)));
  assertOfficialAuto(await officialModelList(t, dir, ['-c', `model_catalog_json=${JSON.stringify(catalogPath)}`]));
});
test('official app-server prefers the explicit catalog file over an unavailable provider catalog URL', officialOptions, async t => {
  const dir = temp(t), catalogPath = join(dir, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify(buildCodexCatalog(definitions)));
  assertOfficialAuto(await officialModelList(t, dir, [
    '-c', `model_catalog_json=${JSON.stringify(catalogPath)}`,
    '-c', 'model_providers.local_catalog_test.model_catalog_url="http://127.0.0.1:1/unavailable"',
  ]));
});

test('windowed catalog: gateway context window means no client compaction and AUTO advertises the largest route', () => {
  const catalog = buildCodexCatalog(definitions, {models: []}, {windowed: true});
  const auto = catalog.models.find(model => model.slug === 'auto');
  assert.equal(auto.context_window, 1048576);
  assert.equal(auto.auto_compact_token_limit, 1000000);
  for (const model of catalog.models) {
    assert.ok(model.context_window >= 1048576);
    assert.equal(model.multi_agent_version, 'v1');
  }
  const plain = buildCodexCatalog(definitions);
  assert.equal(plain.models.find(model => model.slug === 'auto').context_window, 8192);
  assert.equal(plain.models.find(model => model.slug === 'local-vision').auto_compact_token_limit, Math.floor(16384 * 0.8));
});
