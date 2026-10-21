// Prepare only an explicitly selected local home; never discover or rewrite defaults.
import {readFileSync, statSync, existsSync, writeFileSync, lstatSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readRegistry} from './model-router.mjs';
import {compatibilityReasons} from './routing-policy.mjs';
import {repair} from './repair-codex-auto.mjs';
const root = dirname(fileURLToPath(import.meta.url));
export function readyModels(registry, base = root) {
  const available = [], excluded = [];
  for (const model of registry.models) {
    const reasons = compatibilityReasons(model, registry, {automatic: true});
    if (!model.tasks.some(task => ['general', 'coding', 'reasoning', 'vision'].includes(task))) reasons.push('not_a_chat_model');
    for (const file of model.files) {
      try {
        const stat = statSync(resolve(base, file.path));
        if (!stat.isFile() || stat.size !== file.bytes) reasons.push('file_missing_or_incomplete');
        // Same readiness contract as instance-control.ps1. This is recorded
        // verification, not a new hash or a claim of successful inference.
        if (!readFileSync(resolve(base, file.verificationJournal), 'utf8').toLowerCase().includes(file.sha256.toLowerCase())) reasons.push('verification_record_missing');
      } catch { reasons.push('file_or_verification_record_missing'); }
    }
    if (reasons.length) excluded.push({id: model.id, reasons: [...new Set(reasons)]});
    else available.push(model);
  }
  return {available, excluded};
}
export function prepareLocalAuto({registry: registryPath, home, gateway = 'http://127.0.0.1:8090/v1', apply = false, base = root}) {
  if (!registryPath || !home) throw new Error('Explicit --registry and --home are required; no default home is inferred.');
  const config = join(resolve(home), 'config.toml');
  const registry = readRegistry(resolve(registryPath));
  const {available, excluded} = readyModels(registry, base);
  if (!available.length) throw new Error('No recorded-verified, AUTO-compatible conversational model is available. No config changed.');
  const bytes = Buffer.from(JSON.stringify({...registry, models: available}, null, 2) + '\n');
  const snapshot = join(resolve(home), `auto-ready-registry.${createHash('sha256').update(bytes).digest('hex').slice(0,24)}.json`);
  // Repair validates provider/config before any catalog write. A private immutable
  // snapshot is metadata only and never replaces the routing source registry.
  if (existsSync(snapshot)) {
    if (!lstatSync(snapshot).isFile() || lstatSync(snapshot).isSymbolicLink() || !readFileSync(snapshot).equals(bytes)) throw new Error('Snapshot collision; existing file not overwritten.');
  }
  // Validate the selected provider and TOML before materializing any snapshot.
  repair({registry:resolve(registryPath), config, 'gateway-url':gateway});
  if (apply && !existsSync(snapshot)) writeFileSync(snapshot, bytes, {flag:'wx', mode:0o600});
  if (!apply) return {status:'preview-only', config, available:available.map(m=>m.id), excluded, snapshot, note:'No files changed. Apply validates exact home/provider before launch.'};
  const result = repair({registry:snapshot, config, 'gateway-url':gateway, apply:true});
  return {...result, available:available.map(m=>m.id), excluded, snapshot, note:'Recorded file readiness only; actual dropdown and first local response still need verification.'};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let i=2;i<process.argv.length;i++) {
      const key=process.argv[i];
      if(key==='--apply') { if(options.apply) throw new Error('Duplicate option'); options.apply=true; }
      else if(['--registry','--home','--gateway'].includes(key) && process.argv[i+1] && !process.argv[i+1].startsWith('--') && !options[key.slice(2)]) options[key.slice(2)]=process.argv[++i];
      else throw new Error('Usage: node prepare-local-auto.mjs --registry <registry> --home <exact-home> [--gateway <loopback/v1>] [--apply]');
    }
    console.log(JSON.stringify(prepareLocalAuto(options),null,2));
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
