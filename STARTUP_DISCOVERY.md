# Staged startup discovery (opt-in)

Existing registered ready models are immediately available on gateway launch. Discovery
runs in the background **after the HTTP listener is ready**, not before current AUTO
requests. Nothing downloads, scans unrelated folders, edits the original registry,
kills existing generations, or stops download workers.

Add to your existing `setup/gateway-config.json` (keep all other settings):

```json
"startupDiscovery": {
  "manifest": "manifests/staccs-lecore-gguf.json",
  "modelRoot": "C:/Users/User/Documents/ZeroKnowsModels/gguf",
  "context": 4096,
  "portStart": 8300,
  "maxCandidatesPerRun": 0
}
```

Paths are relative to the router source directory unless absolute. Only exact pinned
`modelRoot/staccs/repository/revision/file.gguf` destinations are inspected; `.part`
and conversion staging are never used. Existing model IDs always win, including
operator-disabled entries. Manifest `enabled:false` denotes pending validation and
is **not** authorization to bypass a disabled existing registry model. This opt-in
configuration authorizes validation of new pinned generation artifacts.

Each complete file is SHA256 checked asynchronously. A bounded GGUF reader derives
conservative full-layer FP16 KV accounting for supported scalar llama/Qwen2/Qwen3/
Gemma3 metadata; unknown, heterogeneous, recurrent and unsupported layouts remain
pending with a reason. Gemma requires explicit key/value dimensions. Native context
is a metadata declaration; startup context is at most 4096 (2048 also configurable).
The controller additionally includes its existing runtime allowance plus 16 GiB
physical-memory headroom. This is admission accounting, not a measured peak-memory
or throughput claim.

By default startup only restores previously validated profiles and discovers candidates:
**no new model is smoke-loaded**. Use the launcher’s `-ValidateReadyBatch` for up to
10 new candidates sequentially, or set `maxCandidatesPerRun` to a bounded 1..10.
An initial 5-second idle grace precedes discovery (`idleGraceMs`, 0..60000). A busy admission queue or
insufficient memory defers it; existing instances are never evicted for validation.
Validation uses one slot, the existing controller's serialized ownership/memory
checks, a 16-token real chat generation (30-second generation timeout; existing
10-minute load deadline), then a safe targeted unload. Only success promotes
**general text**, not coding/reasoning quality, tools, JSON, embeddings or vision.
A validation load already in progress cannot safely be preempted. Existing warm
instances can serve, but a new cold-load request waits behind that single load
(up to the controller’s ten-minute deadline). Validation checks demand before each
next candidate and reports `paused` rather than claiming a batch finished.
Later requests demand-load the promoted model normally. All other completed files
remain visible as pending rather than being eagerly loaded. Runtime failure halts
further startup loads; a timed-out/unhealthy process remains tracked for inspection.

`/health.router.startup_discovery` and `logs/startup-discovery.json` report each stage,
reason and promotion. `logs/startup-model-registry.json` is an internal runtime overlay,
not a replacement for `setup/model-registry.json`. Successful smoke profiles are
restored on subsequent relaunches **after rehashing** and matching runtime identity
and computed memory/context fields, without another smoke load; an explicit validation batch can advance other models. If no runtimeId exists, discovery uses the configured server binary's
SHA256. Changing the binary requires revalidation; the configured server binary SHA256 is also checked even when an operator runtimeId exists. Existing operator trust is
not relabeled as fresh validation.

Deleting the overlay safely drops cached promotions; disabling startupDiscovery
returns to source-registry-only routing. Never copy this private machine-specific
logs directory into a public release.

## Verification limits

Model-free tests cover parsing, pinned integrity, preservation, sequential validation,
memory/busy deferral, failure isolation, smoke response validation, and relaunch restore.
The Windows process path, b11734 model compatibility, real generation and actual
memory headroom for new candidates still require validation on the Windows machine.
No such live result is claimed by this cloud implementation.
