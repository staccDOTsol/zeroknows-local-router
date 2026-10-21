# Streaming transport compatibility

## Why comments were insufficient

The pinned official Codex source [`rust-v0.163.0`, `responses.rs`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/codex-api/src/sse/responses.rs#L515-L638) applies its idle timeout around the **parsed** `eventsource().next()` result, not incoming HTTP bytes. SSE comments do not produce events. Its unknown-event branch ignores an unrecognized type as semantic output while continuing its polling loop.

An isolated test against the installed official `codex-cli 0.163.0` confirmed this distinction: with a 450 ms client idle limit, comments every 100 ms still produced the exact `idle timeout waiting for SSE` failure at approximately 459 ms. Parsed control events survived 1,400 ms without a model token and then accepted the real completion. Each case made one loopback request, with no Authorization header, model weights, remote inference or tool calls. This is a client-protocol reproduction, not proof of the user's Windows incident's root cause.

## Wire contract

Responses streams default to `responseHeartbeatMode: "event"`. After `heartbeatMs` of parsed-event silence (15 seconds by default), the gateway sends:

```text
event: local.gateway.keepalive
data: {"type":"local.gateway.keepalive","request_id":"<gateway request id>"}

```

This is a namespaced **gateway extension**, not a fabricated Responses lifecycle event, token, tool call or answer. It has no model `sequence_number`, response ID, usage or output. Forward-compatible clients should ignore the unknown event type. `X-Local-Heartbeat: local.gateway.keepalive` identifies the extension. A separate parsed-event clock ensures upstream comments cannot suppress these events.

Strict clients that reject extensions can set `responseHeartbeatMode: "comment"`; the header then says `comment`. This preserves the old wire behavior but is **not** a solution for Codex's parsed-event timeout. Chat Completions continues to use comments. Compatibility beyond the clients tested here is not assumed.

Heartbeats never reset the gateway's meaningful-upstream-progress idle clock or its absolute request deadline. Queue bounds, header timeout, cancellation and backpressure remain enforced. They do not make an unhealthy or indefinitely loading model healthy.

## Errors and retries

Validation/admission failures before headers commit and all nonstream errors retain their HTTP status. After the delayed first heartbeat commits HTTP 200, an error cannot change that status. Responses then receives `response.failed`, with `response.status: "failed"`, a genuine error message/classification, the known upstream response ID when available, and immediate EOF. The original HTTP-like failure status is preserved in gateway metadata. Unknown upstream error codes are preserved rather than relabeled.

A generic `type: "error"` is insufficient for Codex 0.163.0 except for a narrow provider-specific case. Its failure parser stores `response.failed` until EOF, so promptly closing the stream is important. See the pinned [`responses_error.rs`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/codex-api/src/sse/responses_error.rs).

The gateway does **not** retry an accepted stream or replay partial tool output. That guarantee does not extend to an external client: Codex considers unknown failure codes retryable. For tool-bearing workflows where automatic replay is unsafe, set `stream_max_retries = 0` in that local Codex provider configuration. We do not mislabel timeouts as `invalid_prompt` to manipulate client retries.

## Reproduce

```sh
node --test test-streaming.mjs
CODEX_STREAM_TEST_BIN=/absolute/path/to/codex node --test test-codex-streaming.mjs
```

PowerShell:

```powershell
$env:CODEX_STREAM_TEST_BIN = (Get-Command codex).Source
node --test test-codex-streaming.mjs
```

The optional official-client suite covers the comment-only counterfactual, delayed headers through the actual gateway, upstream comment flooding with a bounded gateway idle failure, and preservation of a generic upstream terminal error. It checks a single request, no Authorization, no synthetic heartbeat answer, and the correct terminal result.

It uses fresh temporary homes, ephemeral sessions, local provider/catalog settings, retries disabled, web search disabled and `project_doc_max_bytes=0` solely to avoid irrelevant project-instruction discovery in the empty fixture. No user Codex home, protected session directory or sandbox-bypass flag is used. Missing `CODEX_STREAM_TEST_BIN` is an explicit skip; a supplied but incompatible/blocked binary fails rather than silently passing. Do not weaken sandbox protections to make this test run.
