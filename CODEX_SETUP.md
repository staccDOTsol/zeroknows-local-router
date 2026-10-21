# AUTO in a local Codex model picker

## Why `/v1/models` is not enough

The gateway exposes two different schemas:

- `/v1/models`: OpenAI-compatible IDs for API clients, including AUTO plus file-ready models.
- `/codex/models.json`: Codex-native descriptors (`models[].slug`, `visibility`, `priority`, context, tool and modality metadata). With managed routing enabled, these are now generated from the registry on each request. No Windows controller call or model load is needed. Registered conversational models appear even while unloaded or unavailable; admission still checks their files and capacity before inference. Embedding-only models are not chat-picker entries.

Previously the second route only read an ignored, independently maintained file. A correct AUTO entry in `/v1/models` did not update it. The empty `setup/local-model-catalog.example.json` is an **optional customization template**, not a usable standalone Codex catalog.

`model_catalog_json` names a **local file**, not an HTTP URL; Codex reads it at startup. A selected profile can override that setting. `model_providers.<id>.model_catalog_url` is a separate native-catalog URL. These contracts are documented in the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Export a catalog without changing your profile

From this repository, using your already configured registry:

```powershell
node export-codex-catalog.mjs --registry setup/model-registry.json --output setup/local-model-catalog.generated.json
```

The command validates registry metadata and creates a **new file only**. It never loads weights, downloads anything, contacts a paid provider, writes credentials, edits a Codex profile, or overwrites an existing file. If the output exists, choose another filename and review it before changing the active profile.

To preserve custom labels, instructions, reasoning options and tool metadata from an existing native catalog, add:

```powershell
--template setup/local-model-catalog.json
```

Only recognized customization fields are copied. The registry owns IDs, context limits and input modalities. AUTO is always API-supported, visible, and first by priority; obsolete models and conflicting app-server fields such as `hidden` or `isDefault` are not copied. AUTO's context is the smallest registered conversational context, not an invented large limit. Image input is advertised only if a registered route supports vision. This metadata is not a claim about model quality or current file readiness.

The optional gateway configuration key `codexCatalog` selects an absolute template path; otherwise the gateway uses `setup/local-model-catalog.json` if present. A malformed template is an error, not silently discarded. In legacy non-managed mode, the supplied catalog remains authoritative and is returned unchanged.

## Select the file in the actual local app profile

Merge the following into the **effective local profile used by the app**, preserving unrelated settings. Do not blindly append duplicate TOML keys or replace the whole configuration. Use the absolute path printed by the export command:

```toml
model = "auto"
model_provider = "zeroknows_local"
model_catalog_json = 'C:\absolute\path\zeroknows-local-router\setup\local-model-catalog.generated.json'

[model_providers.zeroknows_local]
name = "ZeroKnows local"
base_url = "http://127.0.0.1:8090/v1"
wire_api = "responses"
requires_openai_auth = false
```

The profile must run on the same computer as the loopback gateway. No API key is needed. Do not add a key or purchase credits to populate a local catalog. This does not convert a cloud-executed conversation into a local one; local catalog paths do not carry over to cloud environments.

After confirming that the app's selected profile points to the intended file, reopen the local app/server so it reads that startup catalog. Existing threads may retain their previous model; check a new local thread. A restart by itself is **not** proof of a fix.

Prefer the file method for a no-auth local provider. An isolated probe with official `codex-cli 0.163.0` found that `model_catalog_url` alone returned an empty `model/list` without fetching the URL. Do not assume URL discovery refreshes without checking the exact client version/provider/auth configuration. In the inspected source, explicit file catalogs take precedence and use a static manager; URL discovery has separate refresh/auth gates. See the pinned [provider selection](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/model-provider/src/provider.rs#L396-L428) and [refresh rules](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/models-manager/src/manager.rs#L548-L678).

## Verify the same server the dropdown uses

These are separate checkpoints, not interchangeable success signals:

1. The selected local gateway's `/codex/models.json` contains `slug: "auto"`, `visibility: "list"`, and the first priority.
2. The app's **effective configuration** identifies the intended local provider, `CODEX_HOME`/profile and absolute `model_catalog_json` path. If available, use that app-server connection's `config/read` with `includeLayers: true` to inspect overrides. Avoid sharing credentials or full config dumps.
3. The **same live app-server connection** backing the dropdown returns AUTO from `model/list`, with `hidden: false` and `isDefault: true`. Check all pages if `nextCursor` is non-null. The [native visibility/default conversion](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/protocol/src/openai_models.rs#L964-L1047) explains those fields.
4. The visible app dropdown actually shows AUTO and a new local request selects it. A fresh command-line server is not evidence about the already-running desktop's profile or UI cache.

If checkpoint 3 passes for the actual live connection but checkpoint 4 fails, the remaining defect is in app-side selection/filtering/state. Rewriting the gateway's catalog again is not a demonstrated solution. This repository does not contain that desktop UI, and its tests cannot prove a Windows dropdown changed.

## Model-free validation

```powershell
node --test test-model-catalog.mjs
# Optional: point at an independently installed official Codex binary.
$env:CODEX_CATALOG_TEST_BIN = (Get-Command codex).Source
node --test test-model-catalog.mjs
```

The optional tests use a fresh temporary home with no login, a non-serving loopback inference URL, and only initialization/model-list RPCs. They verify that the generated catalog gives AUTO `hidden: false` and `isDefault: true`, and that the file overrides an unavailable provider catalog URL. No inference turn is sent. Standard CI skips these optional binary checks unless explicitly enabled.

Verified in the cloud workspace with Node.js 24.19.0 and official Codex CLI 0.163.0. Actual Windows desktop UI, its installed profile, and real-model generation were not exercised by this validation.
