# ZeroKnows Local Router

A local OpenAI-compatible gateway with `model: "auto"`, explicit model selection, bounded demand loading, and concurrent model instances. It is an experimental first release for **Windows with unified CPU/GPU memory**, tested with llama.cpp's Windows Vulkan server. It is not the DeepInfer HIP backend.

Requests stay on loopback. There are no cloud providers, API keys, automatic weight downloads, or background fleet startup.

## What works

- Responses, Chat Completions, and Embeddings endpoints. Existing Responses tool/history and streaming adapters are preserved.
- AUTO uses deterministic task rules, capability/context gates, live availability, full memory admission, and optional comparable measured task evaluations. Decisions explain readiness, quality evidence, operator preference and load cost; smaller weights are not assumed better. Existing registries remain usable; strict verification is opt-in, while new disabled candidates stay blocked. See [routing policy and migration](ROUTING_POLICY.md). Explicit model IDs retain control.
- Each model has dedicated ports; up to two replicas and two slots per replica. Free slots are considered before loading more weights. Queued demand may justify a second replica, subject to admission. Different models can serve requests simultaneously.
- Loading is serialized. Memory admission includes actual currently available physical RAM, weight/projector files, configured KV/cache sizes, runtime allowance, and 16 GiB Windows headroom. UMA memory is one shared pool, never RAM plus VRAM. Discrete GPU VRAM admission is not implemented.
- Requests queue when capacity is unavailable, with bounded queue length, deadlines and cancellation. Only idle AUTO-owned instances, older than the configured idle interval, may be evicted under memory pressure. Manually selected instances are pinned. Busy instances are retained. Targeted unload checks both gateway requests and direct server slots.
- AUTO makes at most two backend attempts for operational failures before output: connection/header timeout, HTTP 429/502/503/504/507, or structured `out_of_memory`, `context_length_exceeded`, or `unsupported_modality` error codes. Explicit choices do not switch silently. Once response output begins, there is no failover or replay. The gateway does not execute client tools.
- Content refusals are returned as model responses. No refusal detection, refusal-shopping, prompt rewriting to evade safeguards, or ranking by willingness to bypass safeguards is implemented.

## Setup

Requires Node.js 24+, PowerShell 7, and an independently installed compatible Windows llama-server. There are no npm dependencies. The tested runtime was llama.cpp b11734 with Vulkan; runtime binaries are not bundled.

1. Copy `setup/gateway-config.example.json` to `setup/gateway-config.json` and `setup/model-registry.example.json` to `setup/model-registry.json`.
2. Replace **every placeholder** in the registry with your actual local files, byte sizes, SHA256 hashes, capabilities, native/configured contexts, and measured KV/cache accounting. Set `serverPath` to your installed llama-server. The example intentionally cannot load a model as supplied.
3. Verify every weight/projector file with `Get-FileHash -Algorithm SHA256`, compare against its trusted source checksum, then record that verified hash in the configured journal. Runtime admission checks sizes and the verification journal; it does not rehash large models for every request. Reverify files if modified.
4. Choose unique loopback ports. For a vision-capable model, include its projector with `role: "projector"` and the `vision` task. Do not advertise unsupported modalities. Embedders use the `embedding` task, verified `embeddingDimensions`, and last-token pooling; alternative pooling requires controller support.
5. Create `logs` and start `node proxy.mjs setup/gateway-config.json`, or run `./start-proxy.ps1`. Startup loads no models. `/health` shows file readiness, instances, queues, loading, free memory, and recent route/lifecycle events.

The registry schema is visible in the example and `readRegistry` validation. `rank` is a per-task ascending operator preference, not a benchmark. Optional strict capability/evaluation metadata and shared-weight text/vision modes are documented in [ROUTING_POLICY.md](ROUTING_POLICY.md). `kvBytesPerToken` is the model's total KV bytes per token across layers; it must include the selected cache types. `weightBytes` must equal all `files[].bytes`. `context` is **per slot** and cannot exceed `nativeContext`. New two-slot processes receive twice that total KV context. Prompt-cache and fixed state are separate allocations. The controller uses FP16 cache defaults; no RoPE extrapolation is added.

For requests, use a local base URL such as `http://127.0.0.1:8090/v1` and `model: "auto"` or an exact registered model ID:

```powershell
$body = @{ model='auto'; input='Explain this Python function'; max_output_tokens=256 } | ConvertTo-Json
Invoke-WebRequest http://127.0.0.1:8090/v1/responses -Method Post -ContentType application/json -Body $body
./model-control.ps1 -Action Status
./model-control.ps1 -Action Load -Model local-text
./model-control.ps1 -Action Unload -Model local-text
```

Response headers expose `x-local-model`, `x-local-instance`, `x-local-route`, `x-local-attempts`, and operational failover reasons. `/v1/models` lists ready local files plus AUTO; a listed model may still be unloaded. `/admin/models` accepts load/unload/reload only with a non-browser local POST and `X-Local-Control: 1`. It is a local trust boundary, not multi-user authentication. Do not expose the port to the network or an untrusted reverse proxy.

Embedding responses add `embedding_identity` (derived from verified weight checksums) and `dimensions`, and expose `x-local-embedding-identity`. Vector dimensions are checked before delivery. Set registry `embeddingModel` to pin AUTO to one embedding backend; AUTO does not fail over between vector spaces. Clients can send an expected `embedding_identity` to reject a changed backend. If the identity changes, re-embed/reindex the corpus or use a separate index even when dimensions match. Text input and float output are currently supported. The initial local deployment retains Qwen3 Embedding 0.6B; no leCore embedding quality claim is made.

**Optional persistent session memory is now available.** The reviewed leCore BM25/chunking/top-k subset is pinned to commit `45dfab5608d7bfc96df987a1b42b3dbe6ce2fb8b`. Explicit local bind/append/recall/delete operations store original documents and versions in transactional SQLite, isolated by server-issued session capabilities. Memory is disabled by default; it requires existing Python/NumPy and an explicitly attached session header. Retrieved text remains bounded, untrusted evidence—not learned embeddings, infinite attention, or a replacement for full tool/history replay. See [SESSION_MEMORY.md](SESSION_MEMORY.md) for configuration, the synthetic try-out and limits. No installer or private-file scan is included.

Image input must use PNG/JPEG/WebP data URLs (maximum four). Remote image URLs, files, audio and video are rejected. Context screening conservatively counts UTF-8 bytes plus framing, output and image allowance; it can reject a request that a tokenizer would fit. It never silently truncates history or applies unsupported context extrapolation. Model/runtime context errors remain authoritative.

## Validation

Run `node run-tests.mjs` with Node 24, Python 3.11+ and NumPy 2.x available (CI uses Python 3.12/NumPy 2.3.5). Tests create temporary loopback mock servers and synthetic session stores; they load no models. Catalog and retrieval tests cover persistence, session isolation, deletion, concurrent writes, prompt budgets after tool expansion and cancellation uncertainty. They cover classification, capability/context rejection, explicit routing, independent concurrency, serialized loading, two-slot preference, bounded replication, memory admission, pinned/busy protection, idle eviction, cancellation, unload races, queue bounds, operational failover, refusal pass-through and no retries after partial output. Legacy streaming, backpressure and tool-history recovery tests are included. Windows adds PowerShell parsing and process ownership timestamp checks.

On the development Windows machine, AUTO completed a real local embedding request and returned a 1,024-dimensional vector. Cold-load/unload validation is recorded in `VALIDATION.md`. Full concurrent large-model generation, image quality, replica throughput, and long-context stress tests have **not** been performed for this release. Memory figures are conservative estimates, not guarantees for all runtime/model combinations. No model is loaded by CI.

## Operational limits

- Windows UMA admission only. Do not enable it on a discrete-only GPU by relabeling memory mode.
- A started load may finish after its initiating client cancels; it stays tracked and can later be unloaded or evicted. A readiness timeout retains the process for inspection and blocks duplicate loading on its port.
- Controller ownership checks match PID, creation timestamp, executable path and alias. It never adopts or kills unknown listeners. Existing externally started instances must be managed by their original owner.
- Keep direct backend usage exceptional: `/slots` is checked before unload, but independent clients can still race a direct request against shutdown. Route ordinary traffic through the gateway.
- The native llama server may write request text to its own logs at its configured verbosity. Gateway logs contain routing metadata, not prompt bodies. Treat all local logs as private; they are ignored by Git.
- In managed routing mode, `/codex/models.json` generates a Codex-native catalog from the registry, including visible AUTO. It does not need a hand-maintained catalog. For the desktop picker, export and select a local catalog using [CODEX_SETUP.md](CODEX_SETUP.md); `/v1/models` alone is not the picker catalog. No installer changes app profiles or restarts the desktop automatically.

See [NOTICE.md](NOTICE.md) for provenance and licensing. No runtime, model, chat log, credential, or machine-specific configuration is included.

## Stream liveness and deadlines

Responses streams use delayed, parsed SSE control events (`event: local.gateway.keepalive`, JSON `type` and `request_id`; `heartbeatMs` defaults to 15000) during queueing, cold loads, header waits and output. These namespaced events are gateway transport metadata, not model text, tool calls or response lifecycle events; they carry no model sequence number and do not relax admission limits. Codex 0.163.0 times out parsed SSE events, so comments alone do **not** keep that client alive. Clients should ignore the unknown control event. For clients that reject extensions, `responseHeartbeatMode: "comment"` restores comment-only behavior, but cannot prevent Codex's parsed-event idle timeout; Chat Completions retains comment heartbeats. `streamIdleMs` defaults to 120000 and bounds lack of meaningful upstream progress; ping-only streams cannot extend it. The absolute request deadline and `routeHeaderTimeoutMs` remain in force. Disconnects release waiting request state, while an already-started model load remains tracked.

Early/non-streaming failures retain HTTP status codes. Once a delayed heartbeat commits HTTP 200 headers, later Responses failures use `response.failed` with the real error and immediate EOF (plus the original status in gateway metadata), not a successful result; routing metadata may then be a `: local-route` comment. Clients must honor terminal errors and must not replay tool side effects blindly. The gateway never resubmits accepted/partial streams, but a client can independently retry: Codex treats unknown failure codes as retryable. Use the local provider's `stream_max_retries = 0` for tool-bearing workflows where replay is unsafe; the gateway cannot guarantee external-client idempotency. Synthetic slow-queue, loading, cancellation, concurrent-stream and backpressure tests pass; this does not prove the cause of a specific desktop timeout or a live model's throughput. See [streaming protocol and actual-client verification](STREAMING_PROTOCOL.md).

## Relaunch AUTO and staged completed-model discovery

See [exact local-home launcher](LOCAL_AUTO_LAUNCH.md) for a launch path that preserves the existing registry and current ready models. Optional [startup discovery](STARTUP_DISCOVERY.md) restores previously validated pinned GGUFs in the background. Default startup performs no new smoke loads; an explicit ready batch validates completed candidates serially with memory headroom, then enables general text only. Windows installation and real candidate validation remain pending for this implementation.

## Fast local mode (indexed context, parallel slots, speculative decoding)

These are opt-in through `setup/gateway-config.json` and the launcher, and are tuned for one integrated GPU with large unified memory.

- **Indexed context window instead of compaction** (`contextWindow` + `sessionMemory`): Codex sends full history; per conversation (`prompt_cache_key`) the gateway forwards the setup items and first task, a lecore recall block, and the recent tail within `budgetTokens`. The cut point moves only in large steps, so the forwarded prefix stays byte-identical between rebases and llama.cpp's prompt cache keeps hitting. Older turns are indexed (BM25 + normalized query, RRF) instead of discarded. With it enabled the exported catalog advertises 1M-token windows so Codex never compacts.
- **Conversation affinity**: later turns of a conversation return to the instance holding its cached prefix; new conversations go to the least busy loaded model.
- **Unified KV parallel slots**: one shared KV pool per instance (`--kv-unified --no-cache-idle-slots`), one slot per 32K tokens of pool, so concurrent conversations keep their caches without extra memory.
- **Speculative decoding**: `--spec-type ngram-mod` for chat models (measured +86% on code rewrites, +22% freeform for dense models, neutral on MoE); a model that fails to start with it is retried without it.
- **Discovery** validates new GGUFs at native context with text, tool-call and (with a pinned projector) image smoke tests; tool requests only route to tool-verified models.
- **Launcher**: close Codex, then run `Start Local Codex.cmd` (or `start-local-codex.ps1`). It restarts an idle gateway, unloads idle AUTO-loaded models, validates new downloads, exports the live catalog, and starts Codex.
