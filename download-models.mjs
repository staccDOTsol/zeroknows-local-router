#!/usr/bin/env node
// Public, pinned GGUF bytes only. This module never loads a model or edits the router.
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const GiB = 1024 ** 3;
export const DEFAULT_RESERVE_BYTES = 32 * GiB;
const NOFOLLOW = constants.O_NOFOLLOW || 0;
const MAX_JSON_BYTES = 8 * 1024 ** 2;
const EMPTY_SHA256 = createHash('sha256').digest('hex');
const HOSTS = new Set(['huggingface.co', 'cdn-lfs.huggingface.co', 'cdn-lfs.hf.co',
  'cdn-lfs-us-1.hf.co', 'cdn-lfs-eu-1.hf.co', 'cas-bridge.xethub.hf.co',
  'cas-bridge.xethub-eu.hf.co', 'cas-server.xethub.hf.co', 'cas-server.xethub-eu.hf.co',
  'transfer.xethub.hf.co', 'transfer.xethub-eu.hf.co', 'us.aws.cdn.hf.co', 'us.gcp.cdn.hf.co']);
const fail = message => { throw new Error(message); };
const cancelled = signal => signal?.throwIfAborted();
const integer = n => Number.isSafeInteger(n) && n >= 0;
const sum = values => values.reduce((a, b) => { const n = a + b; if (!integer(n)) fail('Unsafe byte total'); return n; }, 0);
function safeSegment(s) {
  return typeof s === 'string' && s.length <= 180 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)
    && !s.endsWith('.') && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s);
}
export function validateManifest(value) {
  if (value?.schemaVersion !== 1 || value.publisher !== 'staccs' || !Array.isArray(value.artifacts)
      || value.artifacts.length === 0 || value.artifacts.length > 10000) fail('Invalid staccs manifest schema');
  const staging = value.kind === 'conversion-staging';
  if (value.kind && !staging) fail('Unsupported manifest kind');
  const ids = new Set(), targets = new Set();
  const artifacts = value.artifacts.map(a => {
    if (!a || !safeSegment(a.id) || !safeSegment(a.modelId)) fail('Invalid artifact/model identity');
    if (typeof a.repository !== 'string' || !a.repository.startsWith('staccs/')
        || !safeSegment(a.repository.slice(7))) fail(`Invalid repository: ${a.id}`);
    if (!/^[0-9a-f]{40}$/.test(a.revision) || !/^[0-9a-f]{64}$/.test(a.sha256)) fail(`Unpinned artifact: ${a.id}`);
    const formats = staging ? {safetensors: ['.safetensors'], json: ['.json'], text: ['.txt', '.md', '.jinja']} : {gguf: ['.gguf']};
    if (typeof a.path !== 'string' || a.path.length > 512 || !a.path.split('/').every((segment, index, segments) => safeSegment(segment) || (staging && segment === '.lecore_layout.json' && index === segments.length - 1))
        || !formats[a.format]?.some(extension => a.path.endsWith(extension))) fail(`Only explicitly allowed inert artifact paths are accepted: ${a.id}`);
    const roles = staging ? ['generation', 'embedding', 'metadata', 'tokenizer'] : ['generation', 'embedding', 'vision-projector'];
    if (!integer(a.bytes) || a.bytes === 0 || !roles.includes(a.role)) fail(`Invalid size/role: ${a.id}`);
    if (staging && a.format !== 'safetensors' && a.bytes > 32 * 1024 ** 2) fail(`Staging metadata exceeds 32 MiB: ${a.id}`);
    if ('url' in a || 'downloadUrl' in a || a.enabled === true) fail(`Untrusted URL or enabled artifact: ${a.id}`);
    const target = `${a.repository}/${a.revision}/${a.path}`.toLowerCase();
    if (ids.has(a.id.toLowerCase()) || targets.has(target)) fail(`Duplicate artifact/destination: ${a.id}`);
    ids.add(a.id.toLowerCase()); targets.add(target);
    return {...a};
  });
  sum(artifacts.map(a => a.bytes));
  return {...value, artifacts};
}
async function maybeStat(p) {
  try { return await fs.lstat(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
// Reject symlinks/junctions in every existing component, including ancestors of root.
export async function inspectPath(p) {
  const absolute = path.resolve(p), parsed = path.parse(absolute);
  let current = parsed.root, nearest = current;
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const rootStat = await fs.lstat(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail(`Unsafe filesystem root: ${current}`);
  for (let i = 0; i < components.length; i++) {
    current = path.join(current, components[i]);
    const st = await maybeStat(current);
    if (!st) return {absolute, stat: null, nearest};
    if (st.isSymbolicLink()) fail(`Refusing symlink/junction: ${current}`);
    if (i < components.length - 1 && !st.isDirectory()) fail(`Not a directory: ${current}`);
    nearest = current;
    if (i === components.length - 1) return {absolute, stat: st, nearest};
  }
  return {absolute, stat: rootStat, nearest};
}
async function mkdirSafe(p) {
  const absolute = path.resolve(p), parsed = path.parse(absolute);
  let current = parsed.root;
  await inspectPath(absolute);
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { await fs.mkdir(current, {mode: 0o700}); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const st = await fs.lstat(current);
    if (st.isSymbolicLink() || !st.isDirectory()) fail(`Unsafe directory: ${current}`);
  }
}
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
async function openRegular(p, flags, {singleLink = false} = {}) {
  const before = await inspectPath(p);
  if (before.stat && (!before.stat.isFile() || (singleLink && before.stat.nlink !== 1))) fail(`Unsafe/non-regular file: ${p}`);
  const handle = await fs.open(p, flags | NOFOLLOW, 0o600);
  try {
    const st = await handle.stat(), after = await inspectPath(p);
    if (!st.isFile() || !after.stat || !sameFile(st, after.stat) || (before.stat && !sameFile(before.stat, st))
        || (singleLink && st.nlink !== 1)) fail(`File changed or unsafe link: ${p}`);
    return handle;
  } catch (e) { await handle.close(); throw e; }
}
export async function readJsonSafe(p, limit = MAX_JSON_BYTES) {
  const handle = await openRegular(p, constants.O_RDONLY);
  try {
    const size = (await handle.stat()).size;
    if (size > limit) fail(`JSON exceeds ${limit} bytes: ${p}`);
    const data = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const {bytesRead} = await handle.read(data, offset, size - offset, offset);
      if (!bytesRead) fail(`JSON changed while reading: ${p}`);
      offset += bytesRead;
    }
    if ((await handle.stat()).size !== size) fail(`JSON changed while reading: ${p}`);
    return JSON.parse(data.toString('utf8'));
  } finally { await handle.close(); }
}
async function hashHandle(handle, signal) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024 ** 2);
  const before = await handle.stat();
  let bytes = 0;
  for (;;) {
    cancelled(signal);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, bytes);
    if (!bytesRead) break;
    bytes += bytesRead; hash.update(buffer.subarray(0, bytesRead));
  }
  const after = await handle.stat();
  if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('File changed during hash verification');
  return {bytes, sha256: hash.copy().digest('hex'), hash};
}
async function hashFile(p, signal) {
  const h = await openRegular(p, constants.O_RDONLY);
  try { return await hashHandle(h, signal); } finally { await h.close(); }
}
export function artifactPaths(root, a) {
  const final = path.join(path.resolve(root), ...a.repository.split('/'), a.revision, ...a.path.split('/'));
  return {final, part: `${final}.part`, meta: `${final}.part.json`};
}
function identity(a) {
  return {schemaVersion: 1, repository: a.repository, revision: a.revision, path: a.path, bytes: a.bytes, sha256: a.sha256};
}
function identityMatches(meta, a) { return Object.entries(identity(a)).every(([k, v]) => meta?.[k] === v); }
async function existingIndex(directory, artifacts, signal) {
  if (!directory) return null;
  const info = await inspectPath(directory);
  if (!info.stat?.isDirectory()) fail('Existing-model directory must exist and be a directory');
  const sizes = new Set(artifacts.map(a => a.bytes)), index = new Map();
  const queue = [{directory: info.absolute, depth: 0}];
  let visited = 0;
  while (queue.length) {
    cancelled(signal);
    const next = queue.shift();
    for (const entry of await fs.readdir(next.directory, {withFileTypes: true})) {
      if (++visited > 100000) fail('Existing-file scan exceeds 100,000 entries; choose a narrower directory');
      const file = path.join(next.directory, entry.name), st = await fs.lstat(file);
      if (st.isSymbolicLink()) continue; // Never traverse junctions or symlinks, even unrelated ones.
      if (st.isDirectory()) {
        if (next.depth < 8) queue.push({directory: file, depth: next.depth + 1});
      } else if (st.isFile() && sizes.has(st.size) && !file.endsWith('.part')) {
        if (!index.has(st.size)) index.set(st.size, []);
        index.get(st.size).push(file);
      }
    }
  }
  return index;
}
async function inspectArtifact(root, a, signal, candidates) {
  const paths = artifactPaths(root, a), final = await inspectPath(paths.final);
  if (final.stat) {
    if (!final.stat.isFile() || final.stat.size !== a.bytes) return {...paths, id: a.id, state: 'conflict', missingBytes: a.bytes, reason: 'Existing destination is not the pinned file size/type; never overwritten.'};
    const result = await hashFile(paths.final, signal);
    if (result.sha256 !== a.sha256) return {...paths, id: a.id, state: 'conflict', missingBytes: a.bytes, reason: 'Existing destination SHA256 differs; never overwritten.'};
    return {...paths, id: a.id, state: 'verified', missingBytes: 0, verifiedBytes: a.bytes};
  }
  const part = await inspectPath(paths.part), meta = await inspectPath(paths.meta);
  if (!part.stat && !meta.stat) {
    for (const existing of candidates?.get(a.bytes) || []) {
      const result = await hashFile(existing, signal);
      if (result.bytes === a.bytes && result.sha256 === a.sha256) return {...paths, final: existing,
        intendedDestination: paths.final, source: 'verified-existing', id: a.id, state: 'verified', missingBytes: 0, verifiedBytes: a.bytes};
    }
    return {...paths, id: a.id, state: 'missing', missingBytes: a.bytes};
  }
  if (!part.stat || !meta.stat || !part.stat.isFile() || !meta.stat.isFile() || part.stat.nlink !== 1 || meta.stat.nlink !== 1)
    return {...paths, id: a.id, state: 'conflict', missingBytes: a.bytes, reason: 'Orphaned/unsafe partial or metadata; inspect manually.'};
  const record = await readJsonSafe(paths.meta);
  if (!identityMatches(record, a) || !integer(record.completedBytes) || !/^[0-9a-f]{64}$/.test(record.prefixSha256)
      || record.completedBytes !== part.stat.size || part.stat.size > a.bytes)
    return {...paths, id: a.id, state: 'conflict', missingBytes: a.bytes, reason: 'Partial checkpoint does not match pinned artifact/length; inspect manually.'};
  const result = await hashFile(paths.part, signal);
  if (result.sha256 !== record.prefixSha256 || (result.bytes === a.bytes && result.sha256 !== a.sha256))
    return {...paths, id: a.id, state: 'conflict', missingBytes: a.bytes, reason: 'Partial SHA256 mismatch; inspect manually.'};
  return {...paths, id: a.id, state: result.bytes === a.bytes ? 'verified-part' : 'resumable',
    missingBytes: a.bytes - result.bytes, partialBytes: result.bytes};
}
export async function freeBytes(p) {
  const info = await inspectPath(p);
  const stats = await fs.statfs(info.nearest, {bigint: true});
  const bytes = stats.bavail * stats.bsize;
  if (bytes < 0n) fail('Filesystem returned invalid available space');
  return Number(bytes > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : bytes);
}
export async function planDownloads(manifest, root, options = {}) {
  manifest = validateManifest(manifest);
  const reserveBytes = options.reserveBytes ?? DEFAULT_RESERVE_BYTES;
  if (!integer(reserveBytes)) fail('Reserve must be non-negative safe integer bytes');
  const info = await inspectPath(root);
  if (info.stat && !info.stat.isDirectory()) fail('Destination must be a directory');
  const candidates = options.existingIndex ?? await existingIndex(options.existingDir, manifest.artifacts, options.signal);
  const files = [];
  for (const a of manifest.artifacts) { cancelled(options.signal); files.push(await inspectArtifact(root, a, options.signal, candidates)); }
  const totalBytes = sum(manifest.artifacts.map(a => a.bytes)), totalMissingBytes = sum(files.map(f => f.missingBytes));
  const availableBytes = await (options.freeBytes || freeBytes)(root);
  if (!integer(availableBytes)) fail('Invalid disk free-space reading');
  const requiredFreeBytes = sum([totalMissingBytes, reserveBytes]);
  const lock = await inspectPath(path.join(path.resolve(root), '.staccs-download.lock'));
  const blockers = files.filter(f => f.state === 'conflict').map(f => `${f.id}: ${f.reason}`);
  if (lock.stat) blockers.push('Download lock exists; another process may be active. Do not remove until confirmed stopped.');
  if (availableBytes < requiredFreeBytes) blockers.push('Insufficient free disk space for all missing bytes plus reserve.');
  return {schemaVersion: 1, mode: 'plan', readonly: true, destination: path.resolve(root), totalBytes,
    totalMissingBytes, reserveBytes, requiredFreeBytes, availableBytes, canDownload: blockers.length === 0,
    blockers, files, exclusions: manifest.exclusions || [], coverage: manifest.coverage || {},
    runtimeWarning: 'Downloaded bytes do not establish runtime support, context/KV memory, tools, vision, or embedding identity. Nothing is auto-enabled.'};
}
export function resolveUrl(a) {
  return new URL(`https://huggingface.co/${a.repository}/resolve/${a.revision}/${a.path.split('/').map(encodeURIComponent).join('/')}?download=true`);
}
export function validateDownloadUrl(value, artifact) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password || u.hash || !HOSTS.has(u.hostname)) fail('Rejected non-official/unsafe download redirect');
  if (u.hostname === 'huggingface.co') {
    const suffix = `${artifact.repository}/${artifact.revision}/${artifact.path}`;
    const allowed = [`/${artifact.repository}/resolve/${artifact.revision}/${artifact.path}`, `/api/resolve-cache/models/${suffix}`];
    if (!allowed.includes(decodeURIComponent(u.pathname))) fail('Rejected redirect outside pinned repository artifact');
  }
  return u;
}
// Deliberately does not read HF_TOKEN, cookies, netrc, proxy settings, or ambient authorization.
function publicRequest(url, {headers, signal, idleTimeoutMs}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {headers, signal, maxHeaderSize: 32768}, response => {
      clearTimeout(headerTimer);
      response.setTimeout(idleTimeoutMs, () => response.destroy(new Error('Download idle timeout')));
      resolve({status: response.statusCode, headers: response.headers, body: response,
        cancel: () => response.destroy()});
    });
    const headerTimer = setTimeout(() => req.destroy(new Error('Download connection/header timeout')), idleTimeoutMs);
    headerTimer.unref?.();
    req.once('error', () => clearTimeout(headerTimer));
    req.setTimeout(idleTimeoutMs, () => req.destroy(new Error('Download connection/header timeout')));
    req.on('error', reject);
  });
}
function header(response, name) {
  const value = response.headers?.get ? response.headers.get(name) : response.headers?.[name];
  return Array.isArray(value) ? value.join(',') : value;
}
async function openResponse(a, offset, options) {
  let url = resolveUrl(a);
  const headers = {'accept-encoding': 'identity', 'user-agent': 'zeroknows-pinned-public-downloader/1'};
  if (offset) headers.range = `bytes=${offset}-`;
  for (let i = 0; i <= 5; i++) {
    cancelled(options.signal);
    validateDownloadUrl(url, a);
    const response = await (options.request || publicRequest)(url, {headers: {...headers}, signal: options.signal, idleTimeoutMs: options.idleTimeoutMs});
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      response.cancel?.();
      const location = header(response, 'location');
      if (!location || i === 5) fail('Missing location or too many redirects');
      url = validateDownloadUrl(new URL(location, url), a);
      continue;
    }
    try {
      if (response.status !== (offset ? 206 : 200)) fail(`Unexpected HTTP ${response.status}; partial is preserved (no automatic truncation/restart)`);
      if (header(response, 'content-encoding') && header(response, 'content-encoding') !== 'identity') fail('Unexpected content encoding');
      const length = header(response, 'content-length');
      if (length !== undefined && length !== null && (!/^\d+$/.test(String(length)) || Number(length) !== a.bytes - offset)) fail('Unexpected Content-Length');
      if (offset && header(response, 'content-range') !== `bytes ${offset}-${a.bytes - 1}/${a.bytes}`) fail('Unexpected Content-Range');
      return response;
    } catch (e) { response.cancel?.(); throw e; }
  }
  fail('Redirect limit exceeded');
}
async function writeCheckpoint(meta, a, bytes, sha256) {
  const existing = await inspectPath(meta);
  if (existing.stat && (!existing.stat.isFile() || existing.stat.nlink !== 1)) fail('Unsafe partial metadata');
  const temp = `${meta}.${randomUUID()}.tmp`;
  const h = await openRegular(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, {singleLink: true});
  try { await h.writeFile(`${JSON.stringify({...identity(a), completedBytes: bytes, prefixSha256: sha256})}\n`); await h.sync(); }
  finally { await h.close(); }
  try { await inspectPath(meta); await fs.rename(temp, meta); } catch (e) { await fs.unlink(temp).catch(() => {}); throw e; }
}
function diskWriter(root, reserve, getFree) {
  let tail = Promise.resolve();
  return (h, buffer, position, signal) => {
    const job = tail.then(async () => {
      cancelled(signal);
      const available = await getFree(root);
      if (!integer(available) || available < reserve + buffer.length) fail('Disk headroom exhausted; partial preserved');
      let offset = 0;
      while (offset < buffer.length) {
        cancelled(signal);
        const {bytesWritten} = await h.write(buffer, offset, buffer.length - offset, position + offset);
        if (!bytesWritten) fail('Zero-byte disk write');
        offset += bytesWritten;
      }
    });
    tail = job.catch(() => {}); return job;
  };
}
async function downloadArtifact(a, root, options, write) {
  const current = await inspectArtifact(root, a, options.signal, options.existingIndex);
  if (current.state === 'verified') return current;
  if (current.state === 'conflict') fail(current.reason);
  await mkdirSafe(path.dirname(current.final));
  let h = await openRegular(current.part, constants.O_RDWR | (current.state === 'missing' ? constants.O_CREAT | constants.O_EXCL : 0), {singleLink: true});
  let response, complete = false, bytes = 0, hash, lastProgressAt = 0;
  try {
    const prefix = await hashHandle(h, options.signal);
    bytes = prefix.bytes; hash = prefix.hash;
    if (current.state !== 'missing') {
      const meta = await readJsonSafe(current.meta);
      if (!identityMatches(meta, a) || meta.completedBytes !== bytes || meta.prefixSha256 !== prefix.sha256) fail('Partial changed after preflight');
    }
    await writeCheckpoint(current.meta, a, bytes, prefix.sha256);
    if (bytes < a.bytes) {
      response = await openResponse(a, bytes, options);
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        for (let offset = 0; offset < buffer.length; offset += 1024 ** 2) {
          const piece = buffer.subarray(offset, Math.min(buffer.length, offset + 1024 ** 2));
          cancelled(options.signal);
          if (bytes + piece.length > a.bytes) fail('Download exceeds pinned byte length');
          await inspectPath(current.part);
          await write(h, piece, bytes, options.signal);
          bytes += piece.length; hash.update(piece);
          if (Date.now() - lastProgressAt >= 5000) {
            options.onProgress?.({id: a.id, state: `downloading ${bytes}/${a.bytes} bytes`});
            lastProgressAt = Date.now();
          }
        }
      }
    }
    cancelled(options.signal);
    if (bytes !== a.bytes) fail(`Unexpected download length: ${bytes}; expected ${a.bytes}`);
    if (hash.copy().digest('hex') !== a.sha256) fail('Downloaded SHA256 mismatch; not published');
    await h.sync();
    // Re-read from disk, not just from network buffers, before atomic publication.
    const verified = await hashHandle(h, options.signal);
    if (verified.bytes !== a.bytes || verified.sha256 !== a.sha256) fail('On-disk verification failed');
    const st = await h.stat();
    const before = await inspectPath(current.part);
    if (!before.stat || !sameFile(st, before.stat) || before.stat.nlink !== 1) fail('Partial replaced during download');
    cancelled(options.signal);
    await inspectPath(current.final);
    // link is an atomic no-clobber promotion; rename() could overwrite another file.
    await fs.link(current.part, current.final);
    const published = await inspectPath(current.final);
    if (!published.stat?.isFile() || !sameFile(st, published.stat)) fail('Published path changed unexpectedly');
    complete = true;
    await h.close(); h = null;
    await fs.unlink(current.part);
    await fs.unlink(current.meta);
    return {...current, state: 'verified', missingBytes: 0, verifiedBytes: bytes};
  } finally {
    response?.cancel?.();
    if (h) {
      // Fresh hash captures short writes or cancellation precisely. No network byte is trusted.
      if (!complete) {
        try {
          await h.sync();
          const prefix = await hashHandle(h);
          await writeCheckpoint(current.meta, a, prefix.bytes, prefix.sha256);
        } catch { /* A damaged/uncheckpointed partial fails closed on next preflight. */ }
      }
      await h.close();
    }
  }
}
export function pendingRegistry(manifest, plan) {
  const grouped = new Map();
  for (const a of manifest.artifacts) {
    if (!grouped.has(a.modelId)) grouped.set(a.modelId, {id: a.modelId, enabled: false,
      status: manifest.kind === 'conversion-staging' ? 'conversion-required' : 'pending-local-validation', routing: {auto: false, compatibility: {status: 'unverified'}, capabilities: {}},
      runtimeId: null, validatedContextTokens: null, peakMemoryBytes: null, kvCacheBytes: null,
      embeddingSpace: null, files: [], requiredChecks: ['exact runtime architecture/load support',
        'bounded context and KV/peak-memory measurement', 'task-specific smoke tests; no automatic capability claims']});
    const f = plan.files.find(f => f.id === a.id);
    grouped.get(a.modelId).files.push({artifactId: a.id, path: f.final, repository: a.repository,
      revision: a.revision, sha256: a.sha256, bytes: a.bytes, role: a.role, hashVerified: f.state === 'verified'});
    if (a.role === 'embedding') grouped.get(a.modelId).requiredChecks.push('explicit embedding model revision, tokenizer/pooling, dimensions, normalization and index identity; do not reuse another embedding index');
  }
  const models = [];
  for (const model of grouped.values()) {
    if (manifest.kind === 'conversion-staging') model.requiredChecks.unshift('reviewed semantic-preserving conversion or separately validated backend; never execute downloaded code/templates');
    if (model.files.some(f => f.role === 'vision-projector')) {
      models.push({...model, id: `${model.id}-text`, routing: {...model.routing, mode: 'text'},
        files: model.files.filter(f => f.role !== 'vision-projector')});
      models.push({...model, id: `${model.id}-vision`, routing: {...model.routing, mode: 'vision'},
        requiredChecks: [...model.requiredChecks, 'matching projector load plus actual image-input smoke test; full per-process memory/unique port']});
    } else models.push(model);
  }
  return {schemaVersion: 1, kind: 'pending-model-import-not-active-registry', sourceKind: manifest.kind || 'gguf', models};
}
export async function downloadAll(manifest, root, options = {}) {
  manifest = validateManifest(manifest);
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) fail('Concurrency must be 1..4');
  const idleTimeoutMs = options.idleTimeoutMs ?? 60000, totalTimeoutMs = options.totalTimeoutMs ?? 24 * 60 * 60 * 1000;
  if (!integer(idleTimeoutMs) || idleTimeoutMs < 1 || !integer(totalTimeoutMs) || totalTimeoutMs < 1) fail('Invalid timeout');
  options = {...options, existingIndex: await existingIndex(options.existingDir, manifest.artifacts, options.signal)};
  const first = await planDownloads(manifest, root, options);
  if (!first.canDownload) fail(`Preflight blocked: ${first.blockers.join('; ')}`);
  await mkdirSafe(root);
  const lockPath = path.join(path.resolve(root), '.staccs-download.lock');
  const lock = await openRegular(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, {singleLink: true});
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('Total download timeout')), totalTimeoutMs);
  timer.unref?.();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    await lock.writeFile(JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()})); await lock.sync();
    // Recheck after acquiring exclusive lock; all earlier observations could have changed.
    const locked = await planDownloads(manifest, root, {...options, signal});
    const blockers = locked.blockers.filter(b => !b.startsWith('Download lock exists;'));
    if (blockers.length) fail(`Locked preflight blocked: ${blockers.join('; ')}`);
    const write = diskWriter(root, first.reserveBytes, options.freeBytes || freeBytes);
    let next = 0, firstError;
    await Promise.all(Array.from({length: concurrency}, async () => {
      try {
        for (;;) {
          cancelled(signal);
          const index = next++;
          if (index >= manifest.artifacts.length) return;
          const artifact = manifest.artifacts[index];
          options.onProgress?.({id: artifact.id, state: 'starting'});
          await downloadArtifact(artifact, root, {...options, signal, idleTimeoutMs}, write);
          options.onProgress?.({id: artifact.id, state: 'verified'});
        }
      } catch (e) { firstError ||= e; controller.abort(e); }
    }));
    if (firstError) throw firstError;
  } finally {
    clearTimeout(timer);
    const opened = await lock.stat();
    await lock.close();
    const existing = await inspectPath(lockPath);
    if (existing.stat && sameFile(opened, existing.stat)) await fs.unlink(lockPath);
  }
  const result = await planDownloads(manifest, root, options);
  return {...result, mode: 'download', readonly: false, pendingRegistry: pendingRegistry(manifest, result)};
}
function usage() {
  return `Usage (Node 24+, private local NTFS/ext4 directory):\n  node download-models.mjs --manifest staccs-lecore-download-manifest.json --dest D:\\Models\\staccs [--plan]\n  node download-models.mjs --manifest staccs-lecore-download-manifest.json --dest D:\\Models\\staccs --download\nOptions: --existing-dir D:\\Models (optional read-only hash reuse), --reserve-gib 32 (minimum 1), --concurrency 1 (1..4), --idle-timeout-seconds 60, --total-timeout-hours 24\nDefault plan is read-only, offline, and hashes existing files. JSON goes to stdout; progress/errors to stderr.\nNo model loads, runtime registry edits, credentials, package installs or network policy changes. Ctrl+C keeps a verified partial checkpoint.\n`;
}
export async function main(argv = process.argv.slice(2)) {
  const values = {}, flags = new Set(['--plan', '--download', '--conversion-staging', '--help']);
  const names = new Set(['--manifest', '--dest', '--existing-dir', '--reserve-gib', '--concurrency', '--idle-timeout-seconds', '--total-timeout-hours']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((!flags.has(arg) && !names.has(arg)) || arg in values) fail(`Unknown/duplicate argument: ${arg}`);
    values[arg] = flags.has(arg) ? true : argv[++i];
    if (values[arg] === undefined || (typeof values[arg] === 'string' && values[arg].startsWith('--'))) fail(`Missing value: ${arg}`);
  }
  if (values['--help']) { process.stdout.write(usage()); return; }
  if (!values['--manifest'] || !values['--dest'] || (values['--plan'] && values['--download'])) fail(usage());
  const reserveGiB = Number(values['--reserve-gib'] ?? 32);
  if (!Number.isFinite(reserveGiB) || reserveGiB < 1) fail('Reserve must be at least 1 GiB');
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Cancelled by user'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const manifest = validateManifest(await readJsonSafe(values['--manifest']));
    if ((manifest.kind === 'conversion-staging') !== Boolean(values['--conversion-staging'])) fail('Conversion staging requires both a conversion-staging manifest and explicit --conversion-staging flag');
    const options = {existingDir: values['--existing-dir'], reserveBytes: Math.ceil(reserveGiB * GiB), concurrency: Number(values['--concurrency'] ?? 1),
      idleTimeoutMs: Number(values['--idle-timeout-seconds'] ?? 60) * 1000,
      totalTimeoutMs: Number(values['--total-timeout-hours'] ?? 24) * 60 * 60 * 1000, signal: controller.signal,
      onProgress: p => process.stderr.write(`${p.id}: ${p.state}\n`)};
    process.stderr.write('Checking local files and SHA256 matches (large existing weights can take time); no network during preflight.\n');
    const plan = await planDownloads(manifest, values['--dest'], options);
    process.stderr.write(`Missing: ${plan.totalMissingBytes} bytes; reserve: ${plan.reserveBytes}; required free: ${plan.requiredFreeBytes}; available: ${plan.availableBytes}.\n`);
    const result = values['--download'] ? await downloadAll(manifest, values['--dest'], options) : {...plan, pendingRegistry: pendingRegistry(manifest, plan)};
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.canDownload) process.exitCode = 2;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { process.stderr.write(`Download blocked: ${e.message}\n`); process.exitCode = 1; });
}
