# Evidence-aware AUTO routing

AUTO selects **one** compatible local backend per attempt. It does not run a panel of models, synthesize their answers, detect refusals, or retry tool side effects. Existing refusal pass-through, pre-output-only operational failover, bounded queues, two replicas/two slots, serialized loading and idle-only eviction are unchanged. Embedding AUTO remains pinned to one vector space.

## Compatibility and migration

Existing registries without `routingPolicy` remain **version 1**. Their operator-supplied tasks/context/ranks continue working. Health and route events label these models `legacy_operator_configured`, not runtime-verified. Existing deployments are not silently disabled or rewritten.

New/downloaded candidates are different: put them outside the active registry until validated, or attach this explicit disabled metadata:

```json
{
  "routing": {
    "auto": false,
    "compatibility": {"status": "unverified"},
    "capabilities": {}
  }
}
```

Any model with `routing` metadata is gated, **even in a version-1 registry**. `unverified`/`unsupported` models cannot route or be loaded through `ModelPool.manual`. A Hugging Face card, a successful checksum, and a supported architecture name are not a local runtime smoke test. The standalone Windows controller is an operator maintenance tool; these policy gates live in the gateway, not a security sandbox around direct controller invocation.

To migrate deliberately:

1. Keep the current registry backup. Verify the exact model/projector bytes, installed runtime/backend and actual local loading/short inference. Record the evidence path. Validate text, image, tools, JSON and embeddings **separately**; leave untested capabilities absent/false.
2. Add a descriptive registry `runtimeId` for that exact tested runtime/backend and, if using cold-load timings, `environmentId` for the tested hardware/configuration. These are operator assertions, not automatic binary inspection. Changing the runtime requires revalidation.
3. Add model metadata like the example below **only for tests actually performed**. `auto: true` is a separate, explicit enablement step.
4. Enable `"routingPolicy": {"version": 2}`. Models with missing verification then fail closed. Test explicit and AUTO requests before switching ordinary traffic. Reverting to version 1 does not override an explicitly disabled candidate.

```json
{
  "runtimeId": "YOUR-TESTED-RUNTIME-BUILD-BACKEND",
  "routingPolicy": {"version": 2},
  "models": [{
    "id": "your-verified-model",
    "routing": {
      "auto": true,
      "compatibility": {
        "status": "verified",
        "runtimeId": "YOUR-TESTED-RUNTIME-BUILD-BACKEND",
        "evidence": "logs/YOUR-ACTUAL-SMOKE-TEST-RECORD.json"
      },
      "capabilities": {"text": true, "tools": false, "json": false}
    }
  }]
}
```

This snippet omits the existing required file/hash/weight/KV/context/port fields; it is **not** a usable registry or claimed test result. Strict routing requires matching runtime ID and evidence, the task in `tasks`, sufficient context, and every requested capability. Tool definitions **or tool history** require `tools`; JSON-object/schema output requires `json`; actual images require `text` plus `vision`; embeddings require `embedding`. Explicit model IDs bypass AUTO preferences and optional evaluation requirements, not capability/context/memory checks.

## Deterministic selection

Each admission pass refreshes availability and computes a lexicographic score. Earlier criteria win; incomparable units are not added together:

1. Ready free slot with 16 GiB headroom; then a feasible cold load; then busy/headroom-constrained instances; then a cold load needing memory; finally unavailable files/replicas. Existing free slots remain preferred to another copy of weights.
2. A matching measured task evaluation, then its higher-is-better normalized score. Missing/stale/incomparable evidence is `unverified`, **not a zero benchmark score**. Evidence-backed candidates take priority within the same availability tier.
3. Lower operator `rank[task]` (default 99). This is a declared preference, not measured quality.
4. For cold text requests, text-only mode before vision mode when otherwise equivalent. Warm compatible vision can serve text without loading a duplicate.
5. Matching measured cold-load milliseconds (unknown last), then full cold allocation, context slack and model ID as stable tie-breaks. Weight size is only a resource-cost tie-break—**smaller is not assumed smarter**.

`ModelPool.explain(body, endpoint)` refreshes status and returns the score components and hard-gate rejections without loading anything. Successful route events in `/health` include the selected score, alternatives and rejection reasons. Prompt text is not included. The keyword task classifier remains a transparent heuristic, not a learned quality predictor or a refusal detector.

## Context and memory

Request estimates include serialized UTF-8 input/history/instructions, tool definitions and JSON schemas, framing, requested output and the existing per-image allowance. They overestimate many tokenizer inputs; no history is silently trimmed. The image allowance is a conservative configured heuristic, not a guarantee for arbitrary image encoders. Actual runtime errors remain authoritative.

Scores expose `requestKvBytes`, `requestWorkingSetBytes`, `allocatedKvBytes`, and `coldRequiredBytes`. **Admission still reserves the full configured context per slot**, because the Windows controller allocates that context up front. It would be unsafe to admit using only the smaller request estimate. Every process includes its full weights/projector, configured KV/cache, 8 GiB runtime allowance and 16 GiB shared UMA headroom. Ready instances are already resident; they are not charged their weights again, but the headroom gate remains. No discrete-VRAM arithmetic or dynamic context resizing was introduced.

## One shared GGUF, text and vision modes

Use separate IDs and unique ports, e.g. `muse-glimmer-text` and `muse-glimmer-vision`. Both definitions may reference the **same GGUF path/hash** on disk. The text definition has `routing.mode: "text"`, no projector, and no vision task/capability. The vision definition has `routing.mode: "vision"`, the same model file plus its matching projector, and separately verified `text`/`vision` capabilities. `weightBytes` is each definition's own sum of files.

Download the shared weight file once. Separate runtime processes do **not** imply shared RAM: each admission still counts its complete weight and cache allocation. A warm verified vision process may serve a text request; an image cannot go to text mode. New MuseGlimmer definitions remain disabled/unverified until actual local smoke tests. No MuseGlimmer performance or compatibility result is claimed by these policy tests.

## Recording real evaluations (optional)

No model benchmark was executed for this change. All scored tests in `test-routing-policy.mjs` are labeled synthetic policy fixtures. Start from `setup/evaluation-record.template.json`, which deliberately fails validation until real observations replace the null/placeholders. Never turn card claims into measured scores.

Put completed records in `model.routing.evaluations`. Records require `kind: "measured"`, task, suite/version/metric, normalized score in `[0,1]` (higher is better), positive sample count, tested context ceiling, time, exact runtime ID, harness version, evidence and `modelFingerprint`. Compute that fingerprint from the validated model definition using the exported `modelFingerprint` in `routing-policy.mjs`; it hashes sorted model/projector roles, byte sizes and SHA256 values. Adding a projector or changing a file invalidates previous evidence.

Opt into a comparable task suite at registry level:

```json
{
  "routingPolicy": {
    "version": 2,
    "qualitySuites": {
      "coding": {
        "suite": "YOUR-LOCAL-CODING-SUITE",
        "version": "YOUR-SUITE-VERSION",
        "metric": "pass_rate",
        "minSamples": 20,
        "maxAgeDays": 30,
        "requireEvaluation": false
      }
    }
  }
}
```

Only records matching the task, suite/version/metric, current runtime and exact bytes are compared. The sample minimum, request context ceiling, optional age limit and no-future-time check must pass. If multiple records match, the newest wins (evidence string breaks timestamp ties). Different suites are not mixed. Unknown quality is allowed only under explicit compatibility/enablement and ordinary operator preferences; set `requireEvaluation: true` to exclude unmeasured AUTO candidates for that task. Explicit selection still permits intentional testing. Do not treat a small benchmark or one sample as universal quality proof.

Optional `routing.coldLoad` uses `milliseconds`, `samples`, `recordedAt`, `evidence`, `runtimeId`, `environmentId`, and `modelFingerprint`. Only matching runtime, hardware label and bytes affect the cost tie-break. This is a latency observation, never a quality score. Re-record after hardware/runtime changes; no latency was measured here.

Run `node --test test-routing-policy.mjs test-model-router.mjs` for model-free policy checks, or `node run-tests.mjs` for the aggregate suite. These tests do not download/load models or operate Windows.
