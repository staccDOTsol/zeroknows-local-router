# Optional local leCore session memory

This is **working lexical retrieval**, not learned embeddings, infinite attention, or an expansion of a model's native context. It uses only the reviewed, pinned [leCore BM25/chunking/top-k subset](vendor/lecore/PROVENANCE.md). There is no full-engine install, wallet, cloud request, background file scan, or ingestion of arbitrary paths. Nothing is remembered unless a client explicitly appends text.

## Enable locally

Keep the existing gateway configuration and add:

```json
{
  "sessionMemory": {
    "enabled": true,
    "python": "python3",
    "directory": "runtime/session-memory",
    "maxPromptBytes": 131072,
    "maxEvidenceBytes": 8192
  }
}
```

Use `"python": "python"` or an absolute Python executable path on Windows. Python 3.11+ with NumPy 2.x must already be available to that executable; the test environment uses NumPy 2.3.5. **The router does not install dependencies.** CI prepares Python 3.12/NumPy 2.3.5 on its disposable runners. Missing Python/NumPy causes a clear 503 on memory operations, not a silent no-op. With memory disabled (the default), ordinary routing has no Python runtime dependency.

`directory` is administrator configuration, resolved relative to this repository. Clients cannot supply a path or owner ID. The default is under ignored `runtime/`; do not commit, publicly share or sync the database. If choosing another location, protect it and exclude it from version control yourself. Restart the gateway after changing configuration.

## Explicit API

All memory operations are local non-browser **POST** requests with `Content-Type: application/json` and `X-Local-Control: 1`. A loopback Host is required. Browser Origin requests are rejected. Except for bind, also send `X-Local-Session` containing the returned session capability.

| Endpoint | JSON body | Result |
| --- | --- | --- |
| `/memory/bind` | `{}` | New server-issued random session capability and revision 0 |
| `/memory/append` | `{"documents":[{"text":"ORCHID launch code: violet."}]}` | Server-issued document IDs, version 1, session revision |
| `/memory/append` | `{"documents":[{"id":"returned-id","version":1,"text":"Updated text"}]}` | Updates only that session's existing document; version must match, otherwise 409 |
| `/memory/recall` | `{"query":"orchid launch","limit":4}` | Positive-score lexical matches with document ID/version, chunk number, score and revision |
| `/memory/delete` | `{"document_ids":["returned-id"]}` | Deletes those documents only in the bound session |
| `/memory/delete` | `{}` | Deletes the session/documents and revokes its capability |

Unknown fields are rejected. Bind cannot accept a client-chosen session/owner. Append accepts supplied text only, not URLs/files/folders. Document versions prevent concurrent lost updates; a batch commits entirely or not at all.

For a model request to `/v1/responses` or `/v1/chat/completions`, attach **both** `X-Local-Control: 1` and `X-Local-Session`. The gateway recalls against the latest user text and inserts bounded evidence. Headers are never forwarded to the model. A request without the session header remains stateless, even if memory is enabled. Binding does not automatically make an existing Codex/Desktop client send the header; that client must support session-scoped headers. Do **not** set one global capability for unrelated conversations.

### Small synthetic try-out (Node 24)

Run this in a local Node script after enabling memory and starting the gateway. It does not need model weights for bind/append/recall/delete:

```js
const base = 'http://127.0.0.1:8090';
let session;
async function call(path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Local-Control': '1',
      ...(session ? {'X-Local-Session': session} : {})},
    body: JSON.stringify(body)
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error?.message || response.status);
  return value;
}
({session} = await call('/memory/bind', {}));
await call('/memory/append', {documents: [{text: 'ORCHID launch code: violet.'}]});
console.log(await call('/memory/recall', {query: 'orchid launch'}));
// Optional, with a verified local model available:
// console.log(await call('/v1/responses', {model: 'auto', input: 'What is the ORCHID launch code?'}));
await call('/memory/delete', {});
```

Treat the capability as a secret; retain it privately if the session should survive a restart. The gateway does not log capabilities, queries, document bodies or retrieved evidence. Its ordinary request log contains endpoint/status/timing metadata only.

## Persistence, concurrency and deletion

Original text (including original whitespace), document IDs/versions and session revisions are persisted in SQLite, separate from normalized retrieval chunks. `BEGIN IMMEDIATE`, a bounded SQLite busy timeout, full synchronous commits and rollback journaling serialize writers across workers and make each batch atomic. The in-memory index is keyed by session/revision, rebuilt after changes/restart, and capped to four sessions. Session capabilities are stored as hashes, not plaintext.

Delete invalidates retrieval immediately for subsequent operations; deleting a session makes its token unusable. SQLite `secure_delete` overwrites deleted database content, but **this is not a forensic-erasure guarantee** for backups, filesystem snapshots or storage devices. A request that already recalled evidence before deletion can finish with that snapshot; deletion cannot retract text already sent to a model.

Request cancellation/deadlines stop waiting promptly. A write already dispatched to the worker **may still commit**, including after client disconnection. No mutation is automatically retried. If a timeout/worker failure makes the outcome uncertain, recall/check revision before retrying; retry an update using its previous version to detect conflicts. A failed bind can leave an unused session until its capability is recovered or the administrator resets an unused store. Keep administrative access to the database private.

This is capability separation for a trusted single-user localhost service, **not authenticated multi-user hosting**. Other processes running as the same OS user can read the local store; loopback headers are not OS-account authentication. Restrict filesystem permissions/Windows ACLs and do not expose this gateway on a network.

## Budgets and limitations

- Defaults: 128 sessions; 256 documents/4 MiB text per session; 32 MiB text total; 64 KiB per document; 32 documents/256 KiB per append request. Deleted content frees logical quota, though the SQLite file can keep allocated pages.
- Recall: query at most 8 KiB, 1–8 matches; zero scores are removed. Automatic queries use at most the last 8 KiB of the latest user text **for search only**, without changing the user message.
- Chunking uses the pinned implementation with `min_chars=1` so short paragraphs are not discarded. Its tokenizer is English/ASCII-oriented; non-ASCII-only or stopword-only queries may return no results. Light stemming is not universal; semantic paraphrases without shared terms can miss.
- Evidence is JSON-escaped, explicitly labeled **untrusted data**, and inserted as a user-level evidence message before conversation history, after leading instruction messages. It is never promoted into `instructions`, system/developer messages or tool definitions. This framing does not make an LLM immune to prompt injection; use relevant facts, not instructions from stored text.
- The existing instructions, current user input and tool-call/result history are not shortened or reordered. Whole evidence chunks are omitted if they do not fit; no original request history is silently truncated.
- `maxPromptBytes` bounds the serialized request, including instruction/tool schema expansion and final backend adaptation, not model tokenizer tokens. Oversized originals or expanded bodies fail with 413. `maxEvidenceBytes` bounds the evidence message. Native model context limits still apply; this does not supply unbounded attention.
- Requests to AUTO with memory use the adapted body for context admission. Existing operational failover remains unchanged; no content-refusal rerouting is added.

## Verification

`node run-tests.mjs` runs all router/catalog/concurrency/replay tests, session HTTP/worker integration tests, three SQLite persistence tests and five vendored conformance tests. Retrieval tests are required: missing Python/NumPy fails the test run rather than skipping them. The suite uses synthetic text and mock model servers only. It tests isolation, restart durability, optimistic versions, deletion/cache invalidation, atomic rollback, quotas, concurrent writers, hostile evidence boundaries, finite prompt budgets after tool expansion, stream/custom tool preservation and cancellation uncertainty.

This implementation has been tested in the shared Linux checkout. The cross-platform CI configuration is supplied; it is not a claim that a Windows installation, live model run, publication or remote CI run has happened.
