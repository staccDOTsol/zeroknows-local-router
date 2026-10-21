import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateManifest, planDownloads, downloadAll, artifactPaths, pendingRegistry,
  resolveUrl, validateDownloadUrl, GiB} from './download-models.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const data = Buffer.from('GGUF tiny fixture bytes, never real model weights\n');
function artifact(extra = {}) {
  return {id: 'tiny-weights', modelId: 'tiny', repository: 'staccs/tiny-lecore-GGUF',
    revision: '1'.repeat(40), path: 'tiny-lecore.gguf', bytes: data.length,
    sha256: sha(data), format: 'gguf', role: 'generation', ...extra};
}
function manifest(artifacts = [artifact()]) { return {schemaVersion: 1, publisher: 'staccs', artifacts}; }
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pinned-model-test-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  return {directory, root: path.join(directory, 'models')};
}
const ample = async () => 100 * GiB;
const opts = {reserveBytes: 1, freeBytes: ample};
function response(body = data, extra = {}) {
  return {status: 200, headers: {'content-length': String(body.length)},
    body: (async function* () { yield body; })(), cancel() {}, ...extra};
}
async function putPartial(root, a, prefix = data.subarray(0, 10), changes = {}) {
  const p = artifactPaths(root, a);
  await fs.mkdir(path.dirname(p.part), {recursive: true});
  await fs.writeFile(p.part, prefix);
  await fs.writeFile(p.meta, JSON.stringify({schemaVersion: 1, repository: a.repository,
    revision: a.revision, path: a.path, bytes: a.bytes, sha256: a.sha256,
    completedBytes: prefix.length, prefixSha256: sha(prefix), ...changes}));
  return p;
}

test('manifest accepts only immutable staccs GGUF artifacts and safe Windows names', () => {
  assert.equal(validateManifest(manifest()).artifacts.length, 1);
  const cases = [{revision: 'main'}, {sha256: 'bad'}, {repository: 'other/repo'},
    {repository: 'staccs/../repo'}, {path: '../escape.gguf'}, {path: 'foo\\bar.gguf'},
    {path: '/absolute.gguf'}, {path: 'C:evil.gguf'}, {path: 'CON.gguf'},
    {path: 'folder./foo.gguf'}, {path: 'foo%2fbar.gguf'}, {path: 'a.py'}, {format: 'pickle'},
    {bytes: Number.MAX_SAFE_INTEGER + 1}, {bytes: 0}, {role: 'execute'},
    {url: 'https://evil.invalid/a.gguf'}, {enabled: true}];
  for (const item of cases) assert.throws(() => validateManifest(manifest([artifact(item)])), JSON.stringify(item));
  assert.throws(() => validateManifest(manifest([artifact(), artifact({id: 'other'})])), /Duplicate/);
  assert.throws(() => validateManifest(manifest([artifact(), artifact({id: 'other', path: 'TINY-LECORE.gguf'})])), /Duplicate/);
});

test('read-only default plan hashes existing files and never creates destination', async t => {
  const {root, directory} = await fixture(t);
  const before = await fs.readdir(directory);
  const p = await planDownloads(manifest(), root, opts);
  assert.deepEqual(await fs.readdir(directory), before);
  assert.equal(p.totalMissingBytes, data.length);
  assert.equal(p.requiredFreeBytes, data.length + 1);
  assert.equal(p.readonly, true);
  assert.equal(p.files[0].state, 'missing');
  const a = artifactPaths(root, artifact());
  await fs.mkdir(path.dirname(a.final), {recursive: true});
  await fs.writeFile(a.final, data);
  assert.equal((await planDownloads(manifest(), root, opts)).files[0].state, 'verified');
  await fs.writeFile(a.final, Buffer.alloc(data.length));
  const conflict = await planDownloads(manifest(), root, opts);
  assert.equal(conflict.files[0].state, 'conflict');
  assert.equal(conflict.canDownload, false);
});

test('disk estimate includes every missing artifact and reserve, not largest file alone', async t => {
  const {root} = await fixture(t);
  const m = manifest([artifact(), artifact({id: 'b', path: 'b.gguf', bytes: 101})]);
  const p = await planDownloads(m, root, {reserveBytes: 17, freeBytes: async () => data.length + 101 + 16});
  assert.equal(p.totalMissingBytes, data.length + 101);
  assert.equal(p.requiredFreeBytes, data.length + 101 + 17);
  assert.equal(p.canDownload, false);
  let called = false;
  await assert.rejects(downloadAll(m, root, {reserveBytes: 17, freeBytes: async () => 0,
    request: async () => { called = true; }}), /Preflight blocked/);
  assert.equal(called, false);
  await assert.rejects(fs.stat(root), {code: 'ENOENT'});
});

test('full download verifies disk SHA256 and publishes without partial remnants', async t => {
  const {root} = await fixture(t);
  let requested = 0;
  const result = await downloadAll(manifest(), root, {...opts, request: async (u, o) => {
    requested++;
    assert.equal(u.toString(), resolveUrl(artifact()).toString());
    assert.deepEqual(Object.keys(o.headers).sort(), ['accept-encoding', 'user-agent']);
    return response();
  }});
  const p = artifactPaths(root, artifact());
  assert.deepEqual(await fs.readFile(p.final), data);
  for (const f of [p.part, p.meta, path.join(root, '.staccs-download.lock')]) await assert.rejects(fs.stat(f), {code: 'ENOENT'});
  assert.equal(requested, 1);
  assert.equal(result.pendingRegistry.models[0].enabled, false);
  assert.equal(result.pendingRegistry.models[0].routing.auto, false);
  assert.equal(result.pendingRegistry.models[0].routing.compatibility.status, 'unverified');
  assert.equal(result.pendingRegistry.models[0].files[0].hashVerified, true);
  await downloadAll(manifest(), root, {...opts, request: () => assert.fail('Already verified file must not download')});
});

test('matching partial is rehashed and resumed with exact Range + Content-Range', async t => {
  const {root} = await fixture(t);
  await putPartial(root, artifact());
  const p = await planDownloads(manifest(), root, opts);
  assert.equal(p.files[0].state, 'resumable');
  assert.equal(p.totalMissingBytes, data.length - 10);
  await downloadAll(manifest(), root, {...opts, request: async (url, o) => {
    assert.equal(o.headers.range, 'bytes=10-');
    return response(data.subarray(10), {status: 206, headers: {'content-range': `bytes 10-${data.length - 1}/${data.length}`, 'content-length': String(data.length - 10)}});
  }});
  assert.deepEqual(await fs.readFile(artifactPaths(root, artifact()).final), data);
});

test('fully verified partial is promoted without network', async t => {
  const {root} = await fixture(t);
  await putPartial(root, artifact(), data);
  assert.equal((await planDownloads(manifest(), root, opts)).files[0].state, 'verified-part');
  await downloadAll(manifest(), root, {...opts, request: () => assert.fail('Completed partial should not fetch')});
});

test('partial identity, length and prefix corruption block resume', async t => {
  const {root} = await fixture(t);
  for (const [n, changes] of [{revision: '2'.repeat(40)}, {sha256: '0'.repeat(64)},
    {completedBytes: 9}, {prefixSha256: '0'.repeat(64)}, {path: 'different.gguf'}].entries()) {
    const destination = path.join(root, String(n));
    await putPartial(destination, artifact(), data.subarray(0, 10), changes);
    assert.equal((await planDownloads(manifest(), destination, opts)).canDownload, false);
    await assert.rejects(downloadAll(manifest(), destination, {...opts, request: () => assert.fail('Unsafe resume')}), /Preflight blocked/);
  }
});

test('orphaned metadata or partial requires manual review, never deletion', async t => {
  const {root} = await fixture(t);
  const p = await putPartial(root, artifact());
  await fs.unlink(p.meta);
  assert.equal((await planDownloads(manifest(), root, opts)).canDownload, false);
  assert.equal((await fs.stat(p.part)).size, 10);
});

test('ignored Range and malformed Content-Range preserve existing partial', async t => {
  const {root} = await fixture(t);
  const p = await putPartial(root, artifact());
  await assert.rejects(downloadAll(manifest(), root, {...opts, request: async () => response()}), /Unexpected HTTP 200/);
  assert.equal((await fs.stat(p.part)).size, 10);
  await assert.rejects(downloadAll(manifest(), root, {...opts, request: async () => response(data.subarray(10),
    {status: 206, headers: {'content-range': `bytes 0-${data.length - 1}/${data.length}`}})}), /Content-Range/);
  assert.equal((await fs.stat(p.part)).size, 10);
});

test('unexpected length, hash, compression, and HTTP failures never publish', async t => {
  const {root} = await fixture(t);
  const cases = [
    [() => response(data, {headers: {'content-length': '1'}}), /Content-Length/],
    [() => response(data.subarray(0, 3), {headers: {}}), /Unexpected download length/],
    [() => response(Buffer.concat([data, data]), {headers: {}}), /exceeds pinned/],
    [() => response(Buffer.alloc(data.length)), /SHA256 mismatch/],
    [() => response(data, {headers: {'content-encoding': 'gzip'}}), /content encoding/],
    [() => response(data, {status: 403}), /HTTP 403/]
  ];
  for (const [n, [get, expected]] of cases.entries()) {
    const destination = path.join(root, String(n));
    await assert.rejects(downloadAll(manifest(), destination, {...opts, request: async () => get()}), expected);
    await assert.rejects(fs.stat(artifactPaths(destination, artifact()).final), {code: 'ENOENT'});
  }
});

test('redirects stay HTTPS, approved official hosts and pinned repository paths', () => {
  const a = artifact();
  assert.equal(validateDownloadUrl(resolveUrl(a), a).hostname, 'huggingface.co');
  assert.equal(validateDownloadUrl('https://cas-bridge.xethub.hf.co/opaque?signature=public', a).hostname, 'cas-bridge.xethub.hf.co');
  for (const bad of ['http://huggingface.co/a', 'https://evil.invalid/a', 'https://huggingface.co.evil.invalid/a',
    'https://localhost/a', 'https://127.0.0.1/a', 'https://user:secret@cdn-lfs.hf.co/a',
    'https://cdn-lfs.hf.co:444/a', 'https://huggingface.co/other/repo/resolve/main/a.gguf',
    'https://huggingface.co/staccs/tiny-lecore-GGUF/resolve/main/tiny-lecore.gguf', 'file:///tmp/a'])
    assert.throws(() => validateDownloadUrl(bad, a));
});

test('official redirect followed without credentials; arbitrary redirect rejected before request', async t => {
  const {root} = await fixture(t);
  const calls = [];
  await downloadAll(manifest(), root, {...opts, request: async (u, o) => {
    calls.push(u.hostname);
    assert.equal(o.headers.authorization, undefined);
    assert.equal(o.headers.cookie, undefined);
    return calls.length === 1 ? response(Buffer.alloc(0), {status: 302, headers: {location: 'https://us.aws.cdn.hf.co/object?public-signature=abc'}}) : response();
  }});
  assert.deepEqual(calls, ['huggingface.co', 'us.aws.cdn.hf.co']);
  let requests = 0;
  await assert.rejects(downloadAll(manifest(), `${root}-bad`, {...opts, request: async () => {
    requests++; return response(Buffer.alloc(0), {status: 302, headers: {location: 'https://evil.invalid/steal'}});
  }}), /Rejected/);
  assert.equal(requests, 1);
});

test('redirect loops are bounded', async t => {
  const {root} = await fixture(t);
  let requests = 0;
  await assert.rejects(downloadAll(manifest(), root, {...opts, request: async () => {
    requests++; return response(Buffer.alloc(0), {status: 302, headers: {location: 'https://cdn-lfs.hf.co/loop'}});
  }}), /too many redirects/);
  assert.equal(requests, 6);
});

test('existing different destination is never overwritten or fetched', async t => {
  const {root} = await fixture(t);
  const p = artifactPaths(root, artifact());
  await fs.mkdir(path.dirname(p.final), {recursive: true});
  await fs.writeFile(p.final, 'private file');
  await assert.rejects(downloadAll(manifest(), root, {...opts, request: () => assert.fail('must not fetch')}), /Preflight blocked/);
  assert.equal(await fs.readFile(p.final, 'utf8'), 'private file');
});

test('a destination appearing during transfer wins; publication cannot clobber it', async t => {
  const {root} = await fixture(t);
  const p = artifactPaths(root, artifact());
  await assert.rejects(downloadAll(manifest(), root, {...opts, request: async () => response(data, {
    body: (async function* () { await fs.writeFile(p.final, 'new other file'); yield data; })()
  })}), {code: 'EEXIST'});
  assert.equal(await fs.readFile(p.final, 'utf8'), 'new other file');
});

test('symlink/junction destination, ancestor, final and partial are rejected without following', async t => {
  const {directory, root} = await fixture(t);
  const target = path.join(directory, 'target');
  await fs.mkdir(target);
  const linked = path.join(directory, 'linked');
  await fs.symlink(target, linked, 'junction');
  await assert.rejects(planDownloads(manifest(), linked, opts), /symlink\/junction/);
  await assert.rejects(planDownloads(manifest(), path.join(linked, 'below'), opts), /symlink\/junction/);
  const p = artifactPaths(root, artifact());
  await fs.mkdir(path.dirname(p.final), {recursive: true});
  // Directory junction at a file path needs no Windows Developer Mode privilege.
  await fs.symlink(target, p.final, 'junction');
  await assert.rejects(planDownloads(manifest(), root, opts), /symlink\/junction/);
  await fs.unlink(p.final);
  await fs.symlink(target, p.part, 'junction');
  await assert.rejects(planDownloads(manifest(), root, opts), /symlink\/junction/);
  assert.deepEqual(await fs.readdir(target), []);
});

test('multiply-linked partial is refused, preventing writes to another local name', async t => {
  const {root, directory} = await fixture(t);
  const p = await putPartial(root, artifact());
  await fs.link(p.part, path.join(directory, 'other-link'));
  assert.equal((await planDownloads(manifest(), root, opts)).canDownload, false);
});

test('existing process lock blocks, is not automatically removed', async t => {
  const {root} = await fixture(t);
  await fs.mkdir(root);
  const lock = path.join(root, '.staccs-download.lock');
  await fs.writeFile(lock, 'another process');
  await assert.rejects(downloadAll(manifest(), root, opts), /Download lock exists/);
  assert.equal(await fs.readFile(lock, 'utf8'), 'another process');
});

test('cancellation preserves a hash-checked checkpoint that can resume', async t => {
  const {root} = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(downloadAll(manifest(), root, {...opts, signal: controller.signal,
    request: async () => response(data, {body: (async function* () {
      yield data.subarray(0, 10);
      controller.abort(new Error('test cancellation'));
      yield data.subarray(10);
    })()})}), /test cancellation/);
  const plan = await planDownloads(manifest(), root, opts);
  assert.equal(plan.files[0].state, 'resumable');
  assert.equal(plan.files[0].partialBytes, 10);
  await assert.rejects(fs.stat(path.join(root, '.staccs-download.lock')), {code: 'ENOENT'});
});

test('disk headroom is rechecked while writing, not just at preflight', async t => {
  const {root} = await fixture(t);
  let freeCalls = 0;
  await assert.rejects(downloadAll(manifest(), root, {reserveBytes: 10,
    freeBytes: async () => ++freeCalls <= 3 ? 10000 : 10,
    request: async () => response(data, {body: (async function* () {
      yield data.subarray(0, 10); yield data.subarray(10);
    })()})}), /Disk headroom exhausted/);
  assert.equal((await planDownloads(manifest(), root, opts)).files[0].partialBytes, 10);
});

test('concurrency is bounded, all artifacts checked, invalid limits rejected', async t => {
  const {root} = await fixture(t);
  const m = manifest(Array.from({length: 5}, (_, i) => artifact({id: `a${i}`, modelId: `m${i}`, path: `a${i}.gguf`})));
  let active = 0, peak = 0, count = 0;
  await downloadAll(m, root, {...opts, concurrency: 2, request: async () => {
    active++; peak = Math.max(peak, active); count++;
    return response(data, {body: (async function* () {
      try { await new Promise(resolve => setTimeout(resolve, 5)); yield data; }
      finally { active--; }
    })()});
  }});
  assert.equal(count, 5); assert.ok(peak <= 2); assert.ok(peak > 0);
  for (const concurrency of [0, 5, 1.5, NaN]) await assert.rejects(downloadAll(m, root, {...opts, concurrency}), /Concurrency/);
});

test('total timeout propagates abort to stalled requests and releases lock', async t => {
  const {root} = await fixture(t);
  // Keep the test event loop alive while the production timeout is unref-ed.
  const hold = setTimeout(() => {}, 1000); t.after(() => clearTimeout(hold));
  await assert.rejects(downloadAll(manifest(), root, {...opts, totalTimeoutMs: 20,
    request: async (_, {signal}) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      if (signal.aborted) reject(signal.reason);
    })}), /Total download timeout/);
  await assert.rejects(fs.stat(path.join(root, '.staccs-download.lock')), {code: 'ENOENT'});
});

test('pending models stay disabled; embedding explicit; projector creates separate text/vision modes', async t => {
  const {root} = await fixture(t);
  const m = manifest([artifact(), artifact({id: 'projector', path: 'mmproj.gguf', role: 'vision-projector'}),
    artifact({id: 'embeddings', modelId: 'embedding-model', path: 'embed.gguf', role: 'embedding'})]);
  const p = pendingRegistry(m, await planDownloads(m, root, opts));
  assert.deepEqual(p.models.map(m => m.id), ['tiny-text', 'tiny-vision', 'embedding-model']);
  assert.equal(p.models[0].files.length, 1);
  assert.equal(p.models[1].files.length, 2);
  assert.equal(p.models[0].routing.mode, 'text');
  assert.equal(p.models[1].routing.mode, 'vision');
  assert.ok(p.models[2].requiredChecks.some(c => c.includes('embedding model revision')));
  for (const model of p.models) {
    assert.equal(model.enabled, false); assert.equal(model.embeddingSpace, null);
    assert.equal(model.routing.auto, false); assert.equal(model.routing.compatibility.status, 'unverified');
    assert.deepEqual(model.routing.capabilities, {});
    assert.ok(model.files.every(f => !f.hashVerified));
  }
});

test('CLI defaults to offline plan and leaves the destination absent', async t => {
  const {root, directory} = await fixture(t);
  const mf = path.join(directory, 'manifest.json');
  await fs.writeFile(mf, JSON.stringify(manifest()));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./download-models.mjs', import.meta.url)),
    '--manifest', mf, '--dest', root, '--reserve-gib', '1'], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, 'plan');
  await assert.rejects(fs.stat(root), {code: 'ENOENT'});
});

test('existing-dir reuses only byte-size + full-hash matches without moving weights', async t => {
  const {directory, root} = await fixture(t);
  const existing = path.join(directory, 'installed'); await fs.mkdir(existing);
  const reuse = path.join(existing, 'renamed-existing.gguf');
  await fs.writeFile(reuse, data);
  await fs.writeFile(path.join(existing, 'unrelated.gguf'), 'different byte size');
  const options = {...opts, existingDir: existing};
  const p = await planDownloads(manifest(), root, options);
  assert.equal(p.totalMissingBytes, 0);
  assert.equal(p.files[0].source, 'verified-existing');
  assert.equal(p.files[0].final, reuse);
  const done = await downloadAll(manifest(), root, {...options, request: () => assert.fail('Must reuse verified installed file')});
  assert.equal(done.pendingRegistry.models[0].files[0].path, reuse);
  await assert.rejects(fs.stat(artifactPaths(root, artifact()).final), {code: 'ENOENT'});
  assert.deepEqual(await fs.readFile(reuse), data);
  // Same size/name is insufficient.
  await fs.writeFile(reuse, Buffer.alloc(data.length));
  assert.equal((await planDownloads(manifest(), root, options)).totalMissingBytes, data.length);
});

test('existing-dir does not traverse symlink/junction; missing explicit directory is clear error', async t => {
  const {directory, root} = await fixture(t);
  const existing = path.join(directory, 'installed'), outside = path.join(directory, 'outside');
  await fs.mkdir(existing); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'tiny.gguf'), data);
  await fs.symlink(outside, path.join(existing, 'junction'), 'junction');
  assert.equal((await planDownloads(manifest(), root, {...opts, existingDir: existing})).totalMissingBytes, data.length);
  await assert.rejects(planDownloads(manifest(), root, {...opts, existingDir: `${existing}-missing`}), /Existing-model directory must exist/);
});

test('separate conversion-staging accepts inert assets only and never enables a backend', async t => {
  const {root} = await fixture(t);
  const tensor = artifact({path: 'model.safetensors', format: 'safetensors'});
  const m = {...manifest([tensor,
    artifact({id: 'template', path: 'chat_template.jinja', format: 'text', role: 'tokenizer'}),
    artifact({id: 'config', path: 'config.json', format: 'json', role: 'metadata'})]), kind: 'conversion-staging'};
  assert.equal(validateManifest(m).artifacts.length, 3);
  assert.throws(() => validateManifest(manifest([tensor])), /allowed inert/);
  for (const bad of [{path: 'model.bin', format: 'safetensors'}, {path: 'custom.py', format: 'text'},
    {path: 'run.ps1', format: 'text'}, {path: 'weights.onnx', format: 'safetensors'},
    {path: 'config.json', format: 'json', bytes: 32 * 1024 ** 2 + 1}])
    assert.throws(() => validateManifest({...manifest([artifact(bad)]), kind: 'conversion-staging'}));
  const p = pendingRegistry(m, await planDownloads(m, root, opts));
  assert.equal(p.models[0].status, 'conversion-required');
  assert.equal(p.models[0].enabled, false);
  assert.equal(p.models[0].routing.compatibility.status, 'unverified');
  assert.ok(p.models[0].requiredChecks.some(check => check.includes('semantic-preserving conversion')));
});
