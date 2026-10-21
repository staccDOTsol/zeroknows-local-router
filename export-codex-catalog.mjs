import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRegistry} from './model-router.mjs';
import {buildCodexCatalog, readCatalogTemplate} from './model-catalog.mjs';

export function exportCatalog({registry, output, template}) {
  if (!registry || !output) throw new Error('--registry and --output are required');
  const catalog = buildCodexCatalog(readRegistry(resolve(registry)).models,
    template ? readCatalogTemplate(resolve(template)) : undefined);
  // Never silently overwrite a catalog or an unrelated existing file. Choose
  // a new output path, review it, then explicitly select it in the app profile.
  writeFileSync(resolve(output), JSON.stringify(catalog, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  return {path: resolve(output), models: catalog.models.map(model => model.slug)};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      if (!['--registry', '--output', '--template'].includes(key) || !args[index + 1] || options[key.slice(2)]) {
        throw new Error('Usage: node export-codex-catalog.mjs --registry <registry.json> --output <new-catalog.json> [--template <existing-catalog.json>]');
      }
      options[key.slice(2)] = args[index + 1];
    }
    console.log(JSON.stringify(exportCatalog(options), null, 2));
    console.log('Set model_catalog_json to this absolute file path in the effective local app profile. This command does not change profiles or restart the app.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
