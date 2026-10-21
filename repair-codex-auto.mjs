#!/usr/bin/env node
// Offline, deliberately narrow repair. No HTTP, auth, model loads, or app restart.
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readRegistry} from './model-router.mjs';
import {buildCodexCatalog, readCatalogTemplate} from './model-catalog.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const usage = `Offline AUTO repair (Node 24+, Python 3.11+; no installation or credits).

Inspect likely filenames only:
  node repair-codex-auto.mjs --inspect [--codex-home <directory>]
Preview a verified, explicitly selected local configuration:
  node repair-codex-auto.mjs --registry <registry.json> --config <exact-config.toml>
Apply that repair with an atomic backup:
  node repair-codex-auto.mjs --registry <registry.json> --config <exact-config.toml> --apply
Undo only if the repaired config has not subsequently changed:
  node repair-codex-auto.mjs --rollback <receipt.json> --apply

Optional: --base-config <config.toml> (profile inheritance), --legacy-profile <name>
(old clients only), --template <catalog.json>, --gateway-url <http-loopback-url/v1>,
--python <python-executable>. No --apply means no config/catalog/backup writes.
Close the local app normally before applying. No process is stopped by this tool.
A new CLI process, saved config, or successful repair is NOT proof of dropdown visibility.`;

export function parseArgs(args) {
  const result = {};
  const flags = new Set(['apply', 'inspect', 'help']);
  const values = new Set(['registry', 'config', 'base-config', 'legacy-profile', 'template', 'gateway-url', 'python', 'codex-home', 'rollback']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || Object.hasOwn(result, key)) throw new Error('Unknown or duplicate option. Use --help.');
    if (flags.has(key)) result[key] = true;
    else if (values.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) result[key] = args[++i];
    else throw new Error('Unknown option or missing value. Use --help.');
  }
  return result;
}

export function inspectCandidates(home = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  const directory = resolve(home);
  const candidates = existsSync(directory) ? readdirSync(directory)
    .filter(name => name === 'config.toml' || /^[A-Za-z0-9_-]+\.config\.toml$/.test(name))
    .sort().map(name => join(directory, name)) : [];
  return {directory, candidates, note: 'Filenames only. The live app may use a different home/profile or overrides. Select its exact file explicitly; no active profile was inferred.'};
}

function regularFile(path) {
  const selected = resolve(path);
  const stat = lstatSync(selected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Inputs must be regular, non-linked files.');
  const canonical = realpathSync(selected);
  const same = process.platform === 'win32' ? canonical.toLowerCase() === selected.toLowerCase() : canonical === selected;
  if (!same) throw new Error('Symlink/reparse-path inputs are not supported; select the real file explicitly.');
  return selected;
}

function python(options, request) {
  const executable = options.python || process.env.LOCAL_ROUTER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(executable, [join(root, 'codex-config-edit.py')], {
    input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  let parsed;
  try {parsed = JSON.parse(result.stdout || '{}');} catch {throw new Error('Config helper failed; raw configuration and stderr were not printed.');}
  if (parsed.error) throw new Error(parsed.error);
  if (result.error || result.status !== 0) throw new Error('Python 3.11+ is required; set --python to an existing interpreter. Nothing installed.');
  return parsed;
}

function checkedJSON(path) {
  try {return JSON.parse(readFileSync(path, 'utf8'));} catch {throw new Error('Invalid local JSON input; its contents were not printed.');}
}

function replace(options, {config, bytes, expectedHash, backup}) {
  return python(options, {action: 'replace', config, candidate: bytes.toString('base64'), expectedHash, backup});
}

export function repair(options) {
  if (!options.registry || !options.config) throw new Error('--registry and the exact --config are required. Use --inspect to list candidate filenames without changing anything.');
  const config = regularFile(options.config);
  if (basename(config) !== 'config.toml' && !/^[A-Za-z0-9_-]+\.config\.toml$/.test(basename(config))) {
    throw new Error('Select config.toml or a named <profile>.config.toml file, not an arbitrary TOML file.');
  }
  let baseConfig = options['base-config'] && regularFile(options['base-config']);
  if (!baseConfig && basename(config) !== 'config.toml' && existsSync(join(dirname(config), 'config.toml'))) {
    baseConfig = regularFile(join(dirname(config), 'config.toml'));
  }
  if (baseConfig === config) throw new Error('--base-config must be different from the selected profile file.');
  if (options['legacy-profile'] && basename(config) !== 'config.toml') throw new Error('--legacy-profile only supports an explicitly selected legacy config.toml.');
  const before = readFileSync(config);
  const baseBefore = baseConfig ? readFileSync(baseConfig) : null;
  const request = {config, baseConfig, legacyProfile: options['legacy-profile'], gateway: options['gateway-url'] || 'http://127.0.0.1:8090/v1'};
  const selected = python(options, request);
  const registryPath = regularFile(options.registry);
  let catalog;
  // Only an explicitly selected template is used. Do not silently read a catalog
  // from another profile or follow a stale/remote model_catalog_json reference.
  try {
    catalog = buildCodexCatalog(readRegistry(registryPath).models,
      options.template ? readCatalogTemplate(regularFile(options.template)) : undefined);
  } catch {throw new Error('Registry/template validation failed. Check the local schema; no config changed and no contents printed.');}
  const catalogBytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n');
  const catalogPath = join(dirname(config), `auto-catalog.${hash(catalogBytes).slice(0, 24)}.json`);
  if (existsSync(catalogPath) && (!regularFile(catalogPath) || !readFileSync(catalogPath).equals(catalogBytes))) {
    throw new Error('Content-addressed catalog collision; existing file was not overwritten.');
  }
  const proposed = python(options, {...request, catalog: catalogPath, context: catalog.models[0].context_window});
  const candidate = Buffer.from(proposed.candidate, 'base64');
  const changed = !candidate.equals(before);
  const result = {
    status: options.apply ? (changed ? 'prepared' : 'already-configured') : 'preview-only',
    config, baseConfig: baseConfig || null, selectedLegacyProfile: options['legacy-profile'] || null,
    provider: selected.provider, gateway: selected.gateway, catalog: catalogPath,
    models: catalog.models.map(model => model.slug), changedKeys: changed ? Object.keys(proposed.edits) : [],
    configWillChange: changed, catalogWillBeCreated: !existsSync(catalogPath),
    verification: 'Registry and selected TOML files verified. Live app binding, higher-priority overrides, gateway readiness, and dropdown visibility NOT verified.',
  };
  if (!options.apply) return result;
  if (!readFileSync(config).equals(before) || (baseConfig && !readFileSync(baseConfig).equals(baseBefore))) {
    throw new Error('Selected/base config changed during inspection; nothing overwritten. Run preview again.');
  }
  if (!existsSync(catalogPath)) writeFileSync(catalogPath, catalogBytes, {flag: 'wx', mode: 0o600});
  if (!changed) return result;
  const suffix = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID();
  const backup = config + '.auto-backup.' + suffix;
  const receipt = config + '.auto-repair.' + suffix + '.json';
  const data = {format: 'local-auto-repair-v1', config, backup, catalog: catalogPath,
    beforeHash: hash(before), afterHash: hash(candidate)};
  // Record recovery facts before the atomic change; a failed change leaves a
  // harmless receipt, not an uncertain automatic retry or forced rollback.
  writeFileSync(receipt, JSON.stringify(data, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  try {
    replace(options, {config, bytes: candidate, expectedHash: data.beforeHash, backup});
  } catch (error) {
    throw new Error(`${error.message} Private recovery receipt: ${receipt}. Inspect it and the selected file before retrying.`);
  }
  if (hash(readFileSync(config)) !== data.afterHash || hash(readFileSync(backup)) !== data.beforeHash) {
    throw new Error(`Post-write verification failed. Do not retry blindly; inspect the private receipt: ${receipt}`);
  }
  return {...result, status: 'selected-config-repaired', backup, receipt,
    next: 'Reopen the local app normally, create a new LOCAL thread and check AUTO in its actual dropdown. If absent, stop rewriting: inspect the live app-server/model-list and UI filtering.'};
}

export function rollback(options) {
  const receipt = regularFile(options.rollback);
  const data = checkedJSON(receipt);
  if (data.format !== 'local-auto-repair-v1' || !/^[a-f0-9]{64}$/.test(data.beforeHash) || !/^[a-f0-9]{64}$/.test(data.afterHash)) throw new Error('Invalid repair receipt.');
  const config = regularFile(data.config), backup = regularFile(data.backup);
  if (dirname(config) !== dirname(backup) || !backup.startsWith(config + '.auto-backup.')) throw new Error('Receipt backup is not a sibling of its config.');
  const bytes = readFileSync(backup);
  if (hash(bytes) !== data.beforeHash) throw new Error('Backup has changed; refusing rollback.');
  const current = hash(readFileSync(config));
  if (current === data.beforeHash) return {status: 'already-restored', config};
  if (current !== data.afterHash) throw new Error('Config has later edits; refusing to overwrite them. Restore selected keys manually from the private backup.');
  if (!options.apply) return {status: 'rollback-preview-only', config, backup};
  const undoBackup = config + '.auto-backup.rollback-' + randomUUID();
  replace(options, {config, bytes, expectedHash: data.afterHash, backup: undoBackup});
  if (hash(readFileSync(config)) !== data.beforeHash) throw new Error('Rollback verification failed; inspect files before retrying.');
  return {status: 'restored', config, backup: undoBackup, note: 'Catalog files retained; no app/process stopped.'};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(usage);
    else if (options.inspect) {
      if (options.apply) throw new Error('--inspect cannot be combined with --apply.');
      console.log(JSON.stringify(inspectCandidates(options['codex-home']), null, 2));
    } else console.log(JSON.stringify(options.rollback ? rollback(options) : repair(options), null, 2));
  } catch (error) {
    console.error(error.code ? `Local file operation failed (${error.code}); inspect paths/permissions. No credentials printed.` : error.message);
    process.exitCode = 1;
  }
}
