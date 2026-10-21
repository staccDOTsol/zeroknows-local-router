# ZeroKnows Local Router

A local OpenAI-compatible gateway with `model: "auto"`, explicit model selection, bounded demand loading, and concurrent model instances. It is an experimental first release for **Windows with unified CPU/GPU memory**, tested with llama.cpp's Windows Vulkan server. It is not the DeepInfer HIP backend.

Requests stay on loopback. There are no cloud providers, API keys, automatic weight downloads, or background fleet startup.

## What works

- Responses, Chat Completions, and Embeddings endpoints. Existing Responses tool/history and streaming adapters are preserved.
- AUTO uses deterministic task rules for coding, reasoning, general text, embeddings, and image input. It filters by configured capabilities/context and ranks compatible local models. This is a transparent heuristic, not a measured "best answer" predictor. Explicit model IDs retain control.
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

The registry schema is visible in the example and `readRegistry` validation. `rank` is a per-task ascending preference. `kvBytesPerToken` is the model's total KV bytes per token across layers; it must include the selected cache types. `weightBytes` must equal all `files[].bytes`. `context` is **per slot** and cannot exceed `nativeContext`. New two-slot processes receive twice that total KV context. Prompt-cache and fixed state are separate allocations. The controller uses FP16 cache defaults; no RoPE extrapolation is added.

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

This release has no persistent session-memory or retrieval layer. It forwards the supplied conversation and enforces finite context limits. Future memory integration must be explicit and tested; this router does not provide infinite attention or silently discard conversation history.

Image input must use PNG/JPEG/WebP data URLs (maximum four). Remote image URLs, files, audio and video are rejected. Context screening conservatively counts UTF-8 bytes plus framing, output and image allowance; it can reject a request that a tokenizer would fit. It never silently truncates history or applies unsupported context extrapolation. Model/runtime context errors remain authoritative.

## Validation

Run `node run-tests.mjs`. Tests create temporary loopback mock servers; they load no models. They cover classification, capability/context rejection, explicit routing, independent concurrency, serialized loading, two-slot preference, bounded replication, memory admission, pinned/busy protection, idle eviction, cancellation, unload races, queue bounds, operational failover, refusal pass-through and no retries after partial output. Legacy streaming, backpressure and tool-history recovery tests are included. Windows adds PowerShell parsing and process ownership timestamp checks.

On the development Windows machine, AUTO completed a real local embedding request and returned a 1,024-dimensional vector. Cold-load/unload validation is recorded in `VALIDATION.md`. Full concurrent large-model generation, image quality, replica throughput, and long-context stress tests have **not** been performed for this release. Memory figures are conservative estimates, not guarantees for all runtime/model combinations. No model is loaded by CI.

## Operational limits

- Windows UMA admission only. Do not enable it on a discrete-only GPU by relabeling memory mode.
- A started load may finish after its initiating client cancels; it stays tracked and can later be unloaded or evicted. A readiness timeout retains the process for inspection and blocks duplicate loading on its port.
- Controller ownership checks match PID, creation timestamp, executable path and alias. It never adopts or kills unknown listeners. Existing externally started instances must be managed by their original owner.
- Keep direct backend usage exceptional: `/slots` is checked before unload, but independent clients can still race a direct request against shutdown. Route ordinary traffic through the gateway.
- The native llama server may write request text to its own logs at its configured verbosity. Gateway logs contain routing metadata, not prompt bodies. Treat all local logs as private; they are ignored by Git.
- Desktop-specific profile/catalog integration from the local lab is not distributed; generic clients select the API model by request. `/codex/models.json` is optional and requires your own `setup/local-model-catalog.json`.

See [NOTICE.md](NOTICE.md) for provenance and licensing. No runtime, model, chat log, credential, or machine-specific configuration is included.
