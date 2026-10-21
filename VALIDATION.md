# Release validation

Validated on 2026-10-21 with Windows, Node.js 24.19.0, PowerShell 7 and an existing llama.cpp b11734 Vulkan runtime. No model weights or runtime binaries are included in this repository.

## Completed

- **21/21 router tests passed**: classification, capabilities/context, explicit override, independent models, busy protection, serialized cold loading, slot preference, bounded replicas, capacity queues, idle-only eviction, cancellation, unload races, queue bounds, operational retry, refusal pass-through, partial-output protection, lifecycle control, structured OOM, policy rejection, header timeout and embedding-space identity pinning.
- **14/14 existing concurrency checks passed**, including parallel streams, per-request tool identity, backpressure, replay, bounded queues, cancellation, deadlines, memory headroom and SSE limits.
- Tool-history recovery suite passed: malformed/missing result handling, valid history preservation, no source mutation, output defaults and non-retryable parse errors.
- PowerShell syntax and process creation timestamp JSON round-trip checks passed.
- Live local AUTO request: `/v1/embeddings`, routed to the verified local Qwen3 Embedding 0.6B model, HTTP 200, one **1,024-dimensional** vector.
- Corrected cold demand load plus the same short embedding request completed in **5.864 seconds**. This is a single smoke-test observation, not a throughput benchmark.
- Targeted unload succeeded before and after the cold-load check. Final gateway status: **zero model instances, zero queued requests, no load in progress**.
- The local desktop companion picker showed all seven verified file sets as ready offline and agreed with the gateway's unloaded state.

The first live smoke test exposed two Windows lifecycle bugs, both fixed before release: date-string conversion during process ownership verification, and child-process pipe inheritance delaying readiness-helper completion. The clean cold-load/unload check above ran after those fixes.

## Not established

- Real concurrent large-model inference, real replica throughput, image-generation quality, and long-context stress behavior were not tested. Those control flows are covered with mocks, not model-quality claims.
- An older optional tool-adapter test requires a loaded chat model. It failed with an unavailable upstream after chat models had been intentionally unloaded; no model was reloaded for it. That model-dependent script is not part of this public model-free suite. Tool routing/history mechanics are exercised by the included mocks.
- Memory admission depends on correctly configured model/cache accounting and shared-memory hardware. It is not a guarantee for arbitrary models, runtime versions or discrete GPUs.
- Context screening uses a conservative byte-based estimate, not exact tokenization. No broad quality, optimal-routing, or universal device compatibility claims are made.
