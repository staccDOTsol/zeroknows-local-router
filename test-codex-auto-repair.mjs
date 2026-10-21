import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {repair, rollback, inspectCandidates, parseArgs} from './repair-codex-auto.mjs';

const provider = '[model_providers.local]\nname = "Local"\nbase_url = "http://127.0.0.1:8090/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n';
const original = '# preserved\nmodel = "old" # edited key comment\nmodel_provider = "local"\n' + provider + '\n[unrelated]\nvalue = "keep this"\n';
function fixture(t, content = original) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-repair-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const config = join(dir, 'config.toml'), registry = join(dir, 'registry.json');
  writeFileSync(config, content);
  const model = {id: 'local-code', context: 8192, nativeContext: 8192, tasks: ['general', 'coding'], ports: [19001], kvBytesPerToken: 1, weightBytes: 1, fixedCacheMiB: 0, promptCacheGiB: 0,
    files: [{path: 'never-loaded.gguf', bytes: 1, sha256: 'a'.repeat(64), role: 'model', verificationJournal: 'never-read.log'}]};
  writeFileSync(registry, JSON.stringify({memoryMode: 'uma', serverPath: 'never-started.exe', idleEvictMs: 60000, models: [model]}));
  return {dir, config, registry};
}

test('preview writes nothing; apply backs up exactly, and repeat is a no-op', t => {
  const f = fixture(t), names = readdirSync(f.dir);
  const preview = repair(f);
  assert.equal(preview.status, 'preview-only');
  assert.deepEqual(readdirSync(f.dir), names);
  assert.equal(readFileSync(f.config, 'utf8'), original);
  const result = repair({...f, apply: true});
  assert.equal(result.status, 'selected-config-repaired');
  assert.equal(readFileSync(result.backup, 'utf8'), original);
  const config = readFileSync(f.config, 'utf8');
  assert.match(config, /model = "auto"/);
  assert.ok(config.endsWith(provider + '\n[unrelated]\nvalue = "keep this"\n'));
  assert.equal(JSON.parse(readFileSync(result.catalog)).models[0].slug, 'auto');
  const files = readdirSync(f.dir);
  assert.equal(repair({...f, apply: true}).status, 'already-configured');
  assert.deepEqual(readdirSync(f.dir), files);
  assert.equal(readFileSync(f.config, 'utf8'), config);
});

test('rollback is exact, repeat-safe and refuses subsequent user edits', t => {
  const f = fixture(t), result = repair({...f, apply: true});
  const repaired = readFileSync(f.config);
  assert.equal(rollback({rollback: result.receipt}).status, 'rollback-preview-only');
  assert.deepEqual(readFileSync(f.config), repaired);
  writeFileSync(f.config, Buffer.concat([repaired, Buffer.from('# later user edit\n')]));
  assert.throws(() => rollback({rollback: result.receipt, apply: true}), /later edits/);
  writeFileSync(f.config, repaired);
  assert.equal(rollback({rollback: result.receipt, apply: true}).status, 'restored');
  assert.equal(readFileSync(f.config, 'utf8'), original);
  assert.equal(rollback({rollback: result.receipt, apply: true}).status, 'already-restored');
});

test('modern explicit profile inherits provider while base and other profile bytes stay untouched', t => {
  const f = fixture(t), base = f.config, selected = join(f.dir, 'local.config.toml'), other = join(f.dir, 'other.config.toml');
  writeFileSync(selected, '# selected\nmodel = "old"\n');
  writeFileSync(other, 'model = "other"\n');
  const result = repair({...f, config: selected, apply: true});
  assert.equal(result.baseConfig, base);
  assert.equal(readFileSync(base, 'utf8'), original);
  assert.equal(readFileSync(other, 'utf8'), 'model = "other"\n');
  assert.match(readFileSync(selected, 'utf8'), /model = "auto"/);
});

test('legacy selector is explicit and only selected profile changes', t => {
  const source = 'profile = "local"\nmodel_provider = "local"\n' + provider + '\n[profiles.local]\nmodel = "old"\n\n[profiles.other]\nmodel = "keep"\n';
  const f = fixture(t, source);
  assert.throws(() => repair(f), /Legacy profile/);
  assert.throws(() => repair({...f, 'legacy-profile': 'other'}), /different profile/);
  const result = repair({...f, 'legacy-profile': 'local', apply: true});
  assert.ok(readFileSync(f.config, 'utf8').endsWith('[profiles.other]\nmodel = "keep"\n'));
  assert.equal(readFileSync(result.backup, 'utf8'), source);
});

test('multiline strings, quoted keys, comments, arrays, BOM and CRLF survive', t => {
  const source = '\ufeff# header\r\n"model" = "old"\r\nmodel_provider = "local"\r\nnotes = """\r\nmodel = "not a key"\r\n[profiles.fake]\r\n"""\r\nliteral = \'\'\'\r\nmodel_catalog_json = "fake"\r\n\'\'\'\r\nitems = [\r\n"a", # comment\r\n"b"\r\n]\r\n' + provider.replaceAll('\n', '\r\n');
  const f = fixture(t, source);
  repair({...f, apply: true});
  const after = readFileSync(f.config, 'utf8');
  assert.ok(after.startsWith('\ufeff'));
  assert.ok(after.includes('notes = """\r\nmodel = "not a key"\r\n[profiles.fake]\r\n"""'));
  assert.ok(after.includes('"model" = "auto"\r\n'));
  assert.ok(!after.replaceAll('\r\n', '').includes('\n'));
});

test('pre-existing context overrides are capped, never raised', t => {
  const f = fixture(t, 'model_context_window = 131072\nmodel_auto_compact_token_limit = 100000\n' + original);
  repair({...f, apply: true});
  assert.match(readFileSync(f.config, 'utf8'), /model_context_window = 8192/);
  assert.match(readFileSync(f.config, 'utf8'), /model_auto_compact_token_limit = 6553/);
  const small = fixture(t, 'model_context_window = 4096\nmodel_auto_compact_token_limit = 100000\n' + original);
  repair({...small, apply: true});
  assert.match(readFileSync(small.config, 'utf8'), /model_context_window = 4096/);
  assert.match(readFileSync(small.config, 'utf8'), /model_auto_compact_token_limit = 3276/);
});

test('malformed TOML, remote or authenticated provider and invalid registry fail closed', t => {
  for (const source of [original + 'invalid = [', original.replace('127.0.0.1', 'example.com'), original.replace('requires_openai_auth = false', 'requires_openai_auth = true'), original.replace('requires_openai_auth = false', 'requires_openai_auth = false\nenv_key = "SECRET_DO_NOT_PRINT"'), 'model = "duplicate"\n' + original]) {
    const f = fixture(t, source), names = readdirSync(f.dir);
    assert.throws(() => repair({...f, apply: true}), error => !error.message.includes('SECRET_DO_NOT_PRINT'));
    assert.equal(readFileSync(f.config, 'utf8'), source);
    assert.deepEqual(readdirSync(f.dir), names);
  }
  const f = fixture(t);
  writeFileSync(f.registry, '{"secret":"SECRET_DO_NOT_PRINT"');
  assert.throws(() => repair({...f, apply: true}), /validation failed/);
  assert.equal(readFileSync(f.config, 'utf8'), original);
});

test('content-addressed catalog cannot overwrite collisions', t => {
  const f = fixture(t), plan = repair(f);
  writeFileSync(plan.catalog, 'do not overwrite');
  assert.throws(() => repair({...f, apply: true}), /collision/);
  assert.equal(readFileSync(plan.catalog, 'utf8'), 'do not overwrite');
  assert.equal(readFileSync(f.config, 'utf8'), original);
});

test('symlink config is rejected (where symlinks are supported)', t => {
  const f = fixture(t), target = join(f.dir, 'linked.config.toml');
  try {symlinkSync(f.config, target);} catch (e) {if (e.code === 'EPERM') return t.skip('Host does not permit symlink creation'); throw e;}
  assert.throws(() => repair({...f, config: target, apply: true}), /linked/);
});

test('inspect only returns config filenames and CLI requires explicit target', t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'work.config.toml'), 'secret = "never read"');
  writeFileSync(join(f.dir, 'auth.json'), 'never read');
  assert.deepEqual(inspectCandidates(f.dir).candidates.map(x => x.split(/[\\/]/).pop()), ['config.toml', 'work.config.toml']);
  assert.throws(() => repair({registry: f.registry, apply: true}), /exact --config/);
  assert.throws(() => parseArgs(['--apply', '--apply']), /duplicate/);
});

test('atomic writer rejects changed-source hash without a backup or mutation', t => {
  const f = fixture(t), backup = join(f.dir, 'backup');
  const executable = process.env.LOCAL_ROUTER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(executable, ['codex-config-edit.py'], {input: JSON.stringify({action: 'replace', config: f.config, backup, expectedHash: '0'.repeat(64), candidate: Buffer.from('model = "auto"').toString('base64')}), encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /changed since inspection/);
  assert.equal(readFileSync(f.config, 'utf8'), original);
  assert.equal(readdirSync(f.dir).includes('backup'), false);
});


test('Unicode paths survive non-UTF-8 Python pipe locale', t => {
  const f = fixture(t);
  const unicodeDir = join(f.dir, 'Jos\u00e9');
  mkdirSync(unicodeDir);
  const path = join(unicodeDir, 'config.toml');
  writeFileSync(path, original);
  const previous = process.env.PYTHONIOENCODING;
  process.env.PYTHONIOENCODING = 'cp1252';
  try {
    const result = repair({...f, config: path, apply: true});
    assert.equal(result.status, 'selected-config-repaired');
    assert.match(readFileSync(path, 'utf8'), /model = "auto"/);
  } finally {
    if (previous === undefined) delete process.env.PYTHONIOENCODING;
    else process.env.PYTHONIOENCODING = previous;
  }
});
