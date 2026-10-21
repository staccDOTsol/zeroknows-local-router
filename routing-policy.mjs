import {createHash} from 'node:crypto';

export const TASKS = ['general', 'reasoning', 'coding', 'vision', 'embedding'];
const CAPABILITIES = ['text', 'vision', 'embedding', 'tools', 'json'];
export const GiB = 1024 ** 3;
// Reserve kept free when loading another model (Windows + desktop on shared UMA memory).
export const HEADROOM_BYTES = 6 * GiB;
// An already-loaded model has its memory reserved; only refuse new work below this floor.
export const SERVE_FLOOR_BYTES = 1 * GiB;
// Measured llama.cpp Vulkan compute + recurrent + host buffers stay under 1.5 GiB per instance.
export const RUNTIME_OVERHEAD_BYTES = 3 * GiB;
const text = value => typeof value === 'string' && value.trim().length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// An evaluation is specific to these exact model/projector bytes, not an alias.
export function modelFingerprint(model) {
  return createHash('sha256').update((model.files || []).map(file =>
    `${file.role}:${file.bytes}:${file.sha256.toLowerCase()}`).sort().join('\n')).digest('hex');
}

export function validateRoutingPolicy(registry) {
  const policy = registry.routingPolicy;
  if (policy !== undefined) {
    if (!object(policy) || ![1, 2].includes(policy.version)) throw Error('routingPolicy.version must be 1 or 2');
    if (policy.version === 2 && !text(registry.runtimeId)) throw Error('Strict routing requires an operator-verified runtimeId');
    if (policy.qualitySuites !== undefined && !object(policy.qualitySuites)) throw Error('Invalid quality suites');
    for (const [task, suite] of Object.entries(policy.qualitySuites || {})) {
      if (!TASKS.includes(task) || !object(suite) || !text(suite.suite) || !text(suite.version) ||
          !text(suite.metric) || !positive(suite.minSamples) ||
          (suite.maxAgeDays !== undefined && !positive(suite.maxAgeDays)) ||
          (suite.requireEvaluation !== undefined && typeof suite.requireEvaluation !== 'boolean')) throw Error('Invalid task evaluation suite');
    }
  }
  for (const model of registry.models) {
    const routing = model.routing;
    if (model.rank !== undefined && (!object(model.rank) || Object.entries(model.rank).some(([task, rank]) =>
      !TASKS.includes(task) || !Number.isFinite(rank)))) throw Error('Invalid operator task preference');
    if (routing === undefined) continue; // Existing operator-configured registries stay usable.
    if (!object(routing) || typeof routing.auto !== 'boolean' || !object(routing.compatibility) ||
        !['verified', 'unverified', 'unsupported'].includes(routing.compatibility.status)) throw Error('Invalid routing compatibility metadata');
    const compatibility = routing.compatibility;
    if (compatibility.status === 'verified' && (!text(compatibility.runtimeId) || !text(compatibility.evidence) ||
        !text(registry.runtimeId) || compatibility.runtimeId !== registry.runtimeId)) throw Error('Verified compatibility must name matching runtimeId and evidence');
    if (!object(routing.capabilities) || Object.entries(routing.capabilities).some(([key, value]) =>
      !CAPABILITIES.includes(key) || typeof value !== 'boolean')) throw Error('Invalid explicit routing capabilities');
    if (routing.mode !== undefined && !['text', 'vision'].includes(routing.mode)) throw Error('Invalid routing mode');
    if (routing.mode === 'text' && (routing.capabilities.vision || model.tasks.includes('vision') || model.files.some(file => file.role === 'projector'))) throw Error('Text-only mode cannot declare vision or a projector');
    if (routing.mode === 'vision' && routing.compatibility.status === 'verified' &&
        (!routing.capabilities.vision || !model.tasks.includes('vision') || !model.files.some(file => file.role === 'projector'))) throw Error('Verified vision mode requires vision capability and projector');
    if (routing.evaluations !== undefined && !Array.isArray(routing.evaluations)) throw Error('Invalid evaluations');
    for (const evaluation of routing.evaluations || []) validateEvaluation(evaluation);
    if (routing.coldLoad !== undefined) {
      const load = routing.coldLoad;
      if (!object(load) || !positive(load.milliseconds) || !positive(load.samples) || !text(load.evidence) ||
          !text(load.runtimeId) || !text(load.environmentId) || !text(load.recordedAt) || !Number.isFinite(Date.parse(load.recordedAt)) ||
          !/^[a-f0-9]{64}$/.test(load.modelFingerprint || '')) throw Error('Invalid measured cold-load metadata');
    }
  }
}

export function validateEvaluation(evaluation) {
  if (!object(evaluation) || evaluation.kind !== 'measured' || !TASKS.includes(evaluation.task) ||
      !['suite', 'suiteVersion', 'metric', 'runtimeId', 'evidence', 'harnessVersion'].every(key => text(evaluation[key])) ||
      !/^[a-f0-9]{64}$/.test(evaluation.modelFingerprint || '') ||
      !Number.isFinite(evaluation.score) || evaluation.score < 0 || evaluation.score > 1 ||
      !positive(evaluation.samples) || !positive(evaluation.contextTokens) ||
      !text(evaluation.recordedAt) || !Number.isFinite(Date.parse(evaluation.recordedAt))) {
    throw Error('Invalid measured evaluation: provenance, normalized higher-is-better score, samples and context are required');
  }
}

export function evaluationFor(model, info, registry, now) {
  const suite = registry.routingPolicy?.qualitySuites?.[info.task];
  if (!suite) return null;
  return (model.routing?.evaluations || []).filter(evaluation => {
    const age = now - Date.parse(evaluation.recordedAt);
    return evaluation.kind === 'measured' && evaluation.task === info.task &&
      evaluation.suite === suite.suite && evaluation.suiteVersion === suite.version && evaluation.metric === suite.metric &&
      evaluation.runtimeId === registry.runtimeId && evaluation.modelFingerprint === modelFingerprint(model) &&
      evaluation.samples >= suite.minSamples && evaluation.contextTokens >= info.tokens && age >= 0 &&
      (suite.maxAgeDays === undefined || age <= suite.maxAgeDays * 86400000);
  }).sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || compareText(a.evidence, b.evidence))[0] || null;
}

export function compatibilityReasons(model, registry, {automatic = false, requirements = []} = {}) {
  const routing = model.routing, strict = registry.routingPolicy?.version === 2;
  if (!routing && !strict) return []; // Legacy declarations are not relabeled as verified.
  const reasons = [];
  if (routing?.compatibility?.status === 'unsupported') reasons.push('runtime_compatibility_unsupported');
  else if (routing?.compatibility?.status !== 'verified' || !registry.runtimeId ||
      routing.compatibility.runtimeId !== registry.runtimeId || !routing.compatibility.evidence) reasons.push('runtime_compatibility_unverified');
  if (automatic && routing?.auto !== true) reasons.push('automatic_routing_disabled');
  for (const capability of requirements) if (routing?.capabilities?.[capability] !== true) reasons.push(`capability_${capability}_unverified`);
  return reasons;
}

export function eligibility(model, info, registry, {automatic = false, now = Date.now()} = {}) {
  const reasons = compatibilityReasons(model, registry, {automatic, requirements: info.requirements});
  if (!model.tasks.includes(info.task)) reasons.push('task_not_supported');
  if (model.context < info.tokens) reasons.push('context_exceeded');
  if (automatic && registry.routingPolicy?.qualitySuites?.[info.task]?.requireEvaluation && !evaluationFor(model, info, registry, now)) reasons.push('task_evaluation_unverified');
  return reasons;
}

// Parallel slots share one unified KV pool, so slot count costs no extra KV memory.
// Default: as many slots as the pool holds 32K-token working windows (the context window keeps prompts near that size),
// so resident conversations never crowd each other out; a registry "parallel" value overrides it.
export function parallelSlots(model) {
  if (Number.isInteger(model.parallel) && model.parallel >= 1 && model.parallel <= 1024) return model.parallel;
  return Math.max(1, Math.min(1024, Math.floor(model.context / 32768)));
}

export function memoryEstimate(model, info, slots = 1) {
  // The controller reserves full configured KV context. Never admit on the
  // smaller request estimate while that allocation policy remains unchanged.
  const fixed = model.weightBytes + (model.fixedCacheMiB || 0) * 1024 ** 2 + (model.promptCacheGiB ?? 1) * GiB + RUNTIME_OVERHEAD_BYTES;
  return {
    requestKvBytes: model.kvBytesPerToken * info.tokens,
    requestWorkingSetBytes: fixed + model.kvBytesPerToken * info.tokens,
    allocatedKvBytes: model.kvBytesPerToken * model.context, // unified pool shared by all slots
    coldRequiredBytes: fixed + model.kvBytesPerToken * model.context + HEADROOM_BYTES,
    headroomBytes: HEADROOM_BYTES,
  };
}

export function scoreCandidates(pool, candidates, info) {
  const rows = candidates.map(model => {
    const instances = pool.usable(model).filter(instance => (instance.context ?? model.context) >= info.tokens);
    const available = instances.find(instance => pool.active(instance) < instance.slots);
    const filesReady = pool.inventory.find(item => item.id === model.id)?.ready === true;
    const requestedSlots = parallelSlots(model);
    const plannedSlots = requestedSlots;
    const memory = memoryEstimate(model, info, available?.slots || plannedSlots);
    const canLoad = filesReady && pool.instances.filter(instance => instance.model === model.id).length < model.ports.length;
    const loadFits = canLoad && memory.coldRequiredBytes <= pool.freeBytes;
    const ready = !!available && pool.freeBytes >= SERVE_FLOOR_BYTES;
    const tier = ready ? 0 : loadFits ? 1 : instances.length ? 2 : canLoad ? 3 : 4;
    const evaluation = evaluationFor(model, info, pool.registry, pool.now());
    const cold = model.routing?.coldLoad;
    const coldLoadMs = cold && cold.runtimeId === pool.registry.runtimeId && cold.environmentId === pool.registry.environmentId &&
      cold.modelFingerprint === modelFingerprint(model) && Date.parse(cold.recordedAt) <= pool.now() ? cold.milliseconds : null;
    return {model, explanation: {
      id: model.id, tier, availability: ['ready_slot', 'cold_load_fits', 'busy_or_headroom', 'cold_load_needs_memory', 'files_or_replicas_unavailable'][tier],
      quality: evaluation ? {status: 'measured', score: evaluation.score, suite: evaluation.suite, version: evaluation.suiteVersion, metric: evaluation.metric, samples: evaluation.samples, evidence: evaluation.evidence} : {status: 'unverified'},
      operatorPreference: model.rank?.[info.task] ?? 99, coldLoadMs,
      allocationSlots: available?.slots || plannedSlots,
      mode: model.routing?.mode || (model.tasks.includes('vision') ? 'vision' : 'text'),
      active: instances.reduce((sum, instance) => sum + pool.active(instance), 0),
      slots: instances.reduce((sum, instance) => sum + instance.slots, 0),
      queued: pool.pending.get(model.id) || 0, contextSlack: model.context - info.tokens,
      compatibility: model.routing?.compatibility?.status || 'legacy_operator_configured', ...memory,
    }};
  });
  // Lexicographic score, not arbitrary mixed units. Smaller weights are only an
  // operational cost tie-break, NEVER evidence of higher answer quality.
  // Among already-loaded models with a free slot, the least busy one wins, so parallel
  // requests spread across every resident model instead of piling onto the top-ranked one.
  rows.sort(({explanation: a}, {explanation: b}) => a.tier - b.tier ||
    (a.tier === 0 && b.tier === 0 ? a.active - b.active : 0) ||
    Number(b.quality.status === 'measured') - Number(a.quality.status === 'measured') ||
    (b.quality.score ?? 0) - (a.quality.score ?? 0) || a.operatorPreference - b.operatorPreference ||
    (a.tier === 0 || info.images ? 0 : Number(a.mode === 'vision') - Number(b.mode === 'vision')) ||
    (a.tier === 0 ? 0 : (a.coldLoadMs ?? Infinity) - (b.coldLoadMs ?? Infinity)) ||
    a.coldRequiredBytes - b.coldRequiredBytes || a.contextSlack - b.contextSlack || compareText(a.id, b.id));
  return rows;
}
