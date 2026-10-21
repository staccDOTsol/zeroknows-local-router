import {readFileSync} from 'node:fs';

// Codex's native catalog is not the OpenAI-compatible /v1/models response.
// Keep routing identity, context and modalities owned by the same registry.
const conversationalTasks = new Set(['general', 'coding', 'reasoning', 'vision']);
const baseInstructions = 'You are a helpful coding assistant. Follow the user\'s instructions, use available tools when needed, and clearly distinguish verified results from assumptions.';

function validateTemplate(value) {
  if (!value || !Array.isArray(value.models)) throw new Error('Codex catalog must contain a models array');
  const slugs = new Set();
  for (const model of value.models) {
    if (!model || typeof model.slug !== 'string' || !model.slug || slugs.has(model.slug)) {
      throw new Error('Codex catalog has an invalid or duplicate model slug');
    }
    slugs.add(model.slug);
  }
  return value;
}

export function readCatalogTemplate(path, {optional = false} = {}) {
  try {
    return validateTemplate(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return {models: []};
    throw error;
  }
}

// Copy only native catalog customization fields, not app-server Model response
// fields such as hidden/isDefault/id/model that could contradict the catalog.
const templateFields = [
  'display_name', 'description', 'default_reasoning_level', 'supported_reasoning_levels',
  'shell_type', 'base_instructions', 'model_messages', 'support_verbosity', 'default_verbosity',
  'apply_patch_tool_type', 'truncation_policy', 'experimental_supported_tools',
];
function decorations(template) {
  return Object.fromEntries(templateFields.filter(key => Object.hasOwn(template, key))
    .map(key => [key, structuredClone(template[key])]));
}

function descriptor({id, context, tasks}, priority, template = {}) {
  const automatic = id === 'auto';
  return {
    display_name: automatic ? 'AUTO (local)' : id,
    description: automatic
      ? 'Route each request to a compatible registered local model.'
      : `Local model: ${id}`,
    default_reasoning_level: 'none',
    supported_reasoning_levels: [{effort: 'none', description: 'Use the local backend default.'}],
    shell_type: 'shell_command',
    availability_nux: null,
    upgrade: null,
    base_instructions: baseInstructions,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    truncation_policy: {mode: 'bytes', limit: 10000},
    experimental_supported_tools: [],
    ...decorations(template),
    // A stale template may decorate a model, but cannot remove AUTO, misroute
    // a request, overstate context, or claim unsupported input modalities.
    slug: id,
    visibility: automatic ? 'list' : (template.visibility ?? 'list'),
    supported_in_api: true,
    priority,
    context_window: context,
    max_context_window: context,
    auto_compact_token_limit: Math.floor(context * 0.8),
    input_modalities: tasks.includes('vision') ? ['text', 'image'] : ['text'],
    supports_image_detail_original: false,
  };
}

export function buildCodexCatalog(models, template = {models: []}) {
  if (!Array.isArray(models)) throw new Error('Model array required');
  validateTemplate(template);
  const chatModels = models.filter(model => model.tasks?.some(task => conversationalTasks.has(task)));
  if (!chatModels.length) throw new Error('A conversational local model is required for the Codex catalog');
  const ids = new Set();
  for (const model of chatModels) {
    if (typeof model.id !== 'string' || !model.id || model.id === 'auto' || ids.has(model.id)) {
      throw new Error('Invalid, reserved or duplicate local model id');
    }
    if (!Number.isSafeInteger(model.context) || model.context < 512) throw new Error('Invalid model context');
    ids.add(model.id);
  }
  const templates = new Map(template.models.map(model => [model.slug, model]));
  const automatic = {
    id: 'auto',
    // Conservative across all possible conversational routes, not the largest
    // model's limit (which would let the client overfill a smaller route).
    context: Math.min(...chatModels.map(model => model.context)),
    tasks: [...new Set(chatModels.flatMap(model => model.tasks))],
  };
  return {models: [
    descriptor(automatic, -1, templates.get('auto')),
    ...chatModels.map((model, index) => descriptor(model, index, templates.get(model.id))),
  ]};
}
