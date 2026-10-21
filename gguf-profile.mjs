// Metadata-derived *admission estimate*, not proof of runtime/model capabilities.
// Only ordinary scalar GQA/MHA layouts are accepted. Unknown layouts fail closed.
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';

const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_STRING_BYTES = 1024 * 1024;
const MAX_ITEMS = 1024 * 1024;
const widths = new Map([[0,1],[1,1],[2,2],[3,2],[4,4],[5,4],[6,4],[7,1],[10,8],[11,8],[12,8]]);
const integer = (n, name, max = 10485760) => {
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw Error(`Unsupported GGUF ${name}`);
  return n;
};

export function profileFromMetadata(metadata, {context = 4096} = {}) {
  integer(context, 'requested context', 10485760);
  if (context < 512) throw Error('GGUF context must be at least 512');
  const architecture = metadata['general.architecture'];
  // muse-glimmer: scalar GQA with sliding-window layers; charging every layer at full
  // context over-estimates KV, which is the safe direction for admission.
  if (!['llama', 'qwen2', 'qwen3', 'gemma3', 'deci', 'qwen35', 'muse-glimmer'].includes(architecture)) {
    throw Error(`Unsupported GGUF attention architecture: ${architecture}`);
  }
  const get = suffix => metadata[`${architecture}.${suffix}`];
  if (architecture === 'deci' || architecture === 'qwen35') return profileLayered(architecture, get, context);
  // Hybrid/recurrent and per-layer array layouts need their own accounting.
  if (Object.keys(metadata).some(key => /(?:^|\.)(?:ssm|recurrent)(?:\.|$)/.test(key))) throw Error('Unsupported GGUF recurrent accounting');
  const nativeContext = integer(get('context_length'), 'native context');
  const layers = integer(get('block_count'), 'layer count', 1024);
  const heads = integer(get('attention.head_count'), 'attention heads', 65536);
  const kvHeads = integer(get('attention.head_count_kv') ?? heads, 'KV heads', heads);
  const embedding = integer(get('embedding_length'), 'embedding length', 1048576);
  const fallback = embedding / heads;
  const keyLength = integer(get('attention.key_length') ?? fallback, 'key length', 65536);
  const valueLength = integer(get('attention.value_length') ?? fallback, 'value length', 65536);
  // Gemma 3 uses a head dimension independent of hidden_size / heads.
  if (architecture === 'gemma3' && (get('attention.key_length') === undefined || get('attention.value_length') === undefined)) {
    throw Error('Gemma 3 requires explicit key and value lengths');
  }
  const kvBytesPerToken = integer(layers * kvHeads * (keyLength + valueLength) * 2, 'FP16 KV bytes', Number.MAX_SAFE_INTEGER);
  if (nativeContext < 512) throw Error('Unsupported GGUF native context');
  return {architecture, nativeContext, context: Math.min(context, nativeContext), kvBytesPerToken,
    fixedCacheMiB: 0, promptCacheGiB: 1};
}

// Layer-varying layouts. Only layers that keep a per-token KV cache are charged per
// token; every unknown or inconsistent field fails closed.
function profileLayered(architecture, get, context) {
  const nativeContext = integer(get('context_length'), 'native context');
  const layers = integer(get('block_count'), 'layer count', 1024);
  const keyLength = integer(get('attention.key_length'), 'key length', 65536);
  const valueLength = integer(get('attention.value_length'), 'value length', 65536);
  const perLayer = (name, values) => {
    if (!Array.isArray(values) || values.length !== layers || values.some(v => !Number.isSafeInteger(v) || v < 0 || v > 65536)) throw Error(`Unsupported GGUF per-layer ${name}`);
    return values;
  };
  let kvHeadLayers, fixedCacheMiB = 0;
  if (architecture === 'deci') {
    // Nemotron/DeciLM: per-layer KV head counts; layers with 0 KV heads have no attention cache.
    const kv = get('attention.head_count_kv');
    kvHeadLayers = Array.isArray(kv) ? perLayer('KV heads', kv) : Array(layers).fill(integer(kv, 'KV heads', 65536));
  } else {
    // Qwen3.5 hybrid: only full-attention layers keep KV; recurrent layers hold fixed state.
    const kvHeads = integer(get('attention.head_count_kv'), 'KV heads', 65536);
    const flags = get('attention.recurrent_layers');
    let recurrent;
    if (Array.isArray(flags)) {
      if (flags.length !== layers || flags.some(v => typeof v !== 'boolean')) throw Error('Unsupported GGUF recurrent layer flags');
      recurrent = flags;
    } else {
      const interval = integer(get('full_attention_interval'), 'full attention interval', 1024);
      recurrent = Array.from({length: layers}, (_, i) => (i + 1) % interval !== 0);
    }
    kvHeadLayers = recurrent.map(isRecurrent => isRecurrent ? 0 : kvHeads);
    const inner = integer(get('ssm.inner_size'), 'SSM inner size', 1048576);
    const state = integer(get('ssm.state_size'), 'SSM state size', 65536);
    const groups = integer(get('ssm.group_count'), 'SSM group count', 65536);
    const kernel = integer(get('ssm.conv_kernel'), 'SSM conv kernel', 64);
    const stateBytes = recurrent.filter(Boolean).length * (inner * state + (kernel - 1) * (inner + 2 * groups * state)) * 4;
    // Two slots of FP32 recurrent state, doubled again as margin, plus 256 MiB.
    fixedCacheMiB = Math.ceil(stateBytes * 4 / 1024 ** 2) + 256;
  }
  const kvHeadSum = kvHeadLayers.reduce((sum, heads) => sum + heads, 0);
  if (!kvHeadSum) throw Error('GGUF layout has no attention KV layers');
  const kvBytesPerToken = integer(kvHeadSum * (keyLength + valueLength) * 2, 'FP16 KV bytes', Number.MAX_SAFE_INTEGER);
  if (nativeContext < 512) throw Error('Unsupported GGUF native context');
  return {architecture, nativeContext, context: Math.min(context, nativeContext), kvBytesPerToken, fixedCacheMiB, promptCacheGiB: 1};
}

export async function readGGUFProfile(path, options = {}) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw Error('GGUF input must be a regular file');
    let position = 0;
    const advance = bytes => {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || position + bytes > Math.min(before.size, MAX_METADATA_BYTES)) throw Error('GGUF metadata exceeds bounds or is truncated');
      const start = position; position += bytes; return start;
    };
    async function read(bytes) {
      const start = advance(bytes), buffer = Buffer.alloc(bytes);
      let offset = 0;
      while (offset < bytes) {
        const {bytesRead} = await handle.read(buffer, offset, bytes - offset, start + offset);
        if (!bytesRead) throw Error('Truncated GGUF metadata');
        offset += bytesRead;
      }
      return buffer;
    }
    const u32 = async () => (await read(4)).readUInt32LE();
    const u64 = async () => {
      const value = (await read(8)).readBigUInt64LE();
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Unsafe GGUF integer');
      return Number(value);
    };
    async function string(keep) {
      const length = await u64();
      if (length > MAX_STRING_BYTES) throw Error('GGUF string exceeds bounds');
      if (!keep) { advance(length); return undefined; }
      return (await read(length)).toString('utf8');
    }
    async function value(type, keep = false) {
      if (type === 8) return string(keep);
      if (type === 9) {
        const itemType = await u32(), count = await u64();
        if (count > MAX_ITEMS || itemType === 9 || (!widths.has(itemType) && itemType !== 8)) throw Error('Unsupported GGUF array');
        if (itemType === 8) { for (let i = 0; i < count; i++) await string(false); return keep ? [] : undefined; }
        // Per-layer layout arrays (deci head counts, qwen35 recurrent flags) are kept as
        // real arrays; they are only accepted by architectures with explicit array accounting.
        if (keep && count <= 4096) { const items = []; for (let i = 0; i < count; i++) items.push(await value(itemType, true)); return items; }
        advance(count * widths.get(itemType));
        return keep ? [] : undefined;
      }
      if (!widths.has(type)) throw Error(`Unknown GGUF metadata type ${type}`);
      const width = widths.get(type);
      if (!keep) { advance(width); return undefined; }
      const b = await read(width);
      switch (type) {
        case 0: return b.readUInt8(); case 1: return b.readInt8();
        case 2: return b.readUInt16LE(); case 3: return b.readInt16LE();
        case 4: return b.readUInt32LE(); case 5: return b.readInt32LE();
        case 6: return b.readFloatLE(); case 7: return b.readUInt8() !== 0;
        case 10: { const n = b.readBigUInt64LE(); return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : NaN; }
        case 11: { const n = b.readBigInt64LE(); return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : NaN; }
        case 12: return b.readDoubleLE();
      }
    }
    if ((await read(4)).toString('ascii') !== 'GGUF') throw Error('Invalid GGUF magic');
    if (![2,3].includes(await u32())) throw Error('Unsupported GGUF version');
    const tensorCount = await u64(), count = await u64();
    if (!tensorCount || tensorCount > MAX_ITEMS || count > 65536) throw Error('GGUF header count exceeds bounds');
    const metadata = Object.create(null), keys = new Set();
    for (let i = 0; i < count; i++) {
      const key = await string(true);
      if (keys.has(key)) throw Error('Duplicate GGUF metadata key');
      keys.add(key);
      const keep = key === 'general.architecture' || /\.(?:context_length|block_count|embedding_length|full_attention_interval|attention\.(?:head_count|head_count_kv|key_length|value_length))$/.test(key)
        || /(?:^|\.)(?:ssm|recurrent)(?:\.|$)/.test(key);
      const parsed = await value(await u32(), keep);
      if (keep) metadata[key] = parsed;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('GGUF changed during metadata read');
    return profileFromMetadata(metadata, options);
  } finally { await handle.close(); }
}
