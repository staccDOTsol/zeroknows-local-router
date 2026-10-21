# Relaunch AUTO using models already on disk

The launcher does **not** wait for a download batch, download weights, load all
models, change the default `~/.codex` home, or terminate any process. Existing
model metadata and recorded SHA256 verification remain required. A file being
present is not proof of runtime compatibility or model quality.

Use the known dedicated local home (for the lab, `local-codex-home`), not a
provider-less default home. First close Codex normally after finishing active
work. Close an old gateway normally too: an occupied port is deliberately not
reused because it may still be running old code. Then run from this repository:

```powershell
.\launch-local-auto.ps1 `
  -CodexHome 'C:\Users\User\Documents\Codex\2026-10-19\task-2\local-codex-home' `
  -CodexExe 'C:\the\actual\installed\Codex.exe' `
  -Config 'setup/gateway-config.json'
```

You may omit `-CodexExe` while the actual Codex desktop window is visible.
The launcher will identify its unique visible main-window executable, print
one exact relaunch command, and stop before changing anything. Close the app
normally, then paste that command. If there is no uniquely identifiable visible
window, supply the actual executable path explicitly.

`CodexExe` is the actual locally installed desktop executable, not a guessed
path or a shortcut that drops environment variables. Select the existing
no-auth local provider config in this dedicated home. The launcher supports
its base `config.toml`; a separately selected named profile/GUI override must
be inspected and repaired explicitly using `repair-codex-auto.mjs` instead.
It does not copy credentials or generate a new provider configuration.

Before launching, the helper:

1. Checks each already registered conversational model for exact file sizes,
   its recorded verification journal and existing AUTO compatibility policy.
   Incomplete and disabled models are reported separately, not waited on.
2. Creates an immutable private ready-model registry snapshot beside that
   home's config; never replaces the source registry. This snapshot is for
   catalog generation only. The gateway keeps the full configured registry.
3. Uses the existing backed-up repair to set `model="auto"` and a local native
   catalog in exactly this home. Repeating the same preparation is a no-op.
4. Starts the gateway, verifies managed health version 2 and a visible native
   AUTO descriptor, then starts Codex with this `CODEX_HOME` only. The calling
   shell's previous environment is restored.

For a read-only inventory/preview:

```powershell
node prepare-local-auto.mjs --registry setup/model-registry.json --home 'C:\exact\local-codex-home'
```

Preview also validates the selected local provider. For preparation only,
close the app and add `--apply`. If an apply fails after snapshot creation,
the immutable snapshot may remain; the original routing registry is untouched.
Config backups may contain private settings: never upload them.

## What counts as success

A generated catalog is **not** proof that the visible app used it. Open a **new
local thread**, select AUTO in its actual model dropdown, and send a small
request. Confirm the gateway route event names a usable local model and the
response completes. An existing thread may retain its old selection. A running
single-instance GUI can ignore a new home; the launcher refuses that condition
rather than pretending a second launch refreshed it.

If AUTO is still absent, inspect the **same live app-server connection** backing
that dropdown (`config/read` layers and paginated `model/list`); do not keep
rewriting config or test an unrelated CLI server. See `CODEX_SETUP.md`.

Background startup discovery, when explicitly enabled in the gateway, can add
newly validated routes behind AUTO without a new individual picker entry.
Native file catalogs are read at app startup; individual additions require an
explicit catalog export from the validated runtime overlay and app restart.
This launcher intentionally catalogs only the original operator registry;
AUTO itself can still use newly promoted routes. Admission still checks files,
capabilities, context and free memory for every route. No UI or generation
success is inferred from gateway health alone.

## Validation

`node --test test-local-auto-launcher.mjs` covers preview/no-write behavior,
ready-vs-incomplete filtering, missing verification, disabled routing, invalid
provider rejection, source preservation, immutable snapshots, repeat no-op,
and launcher safety ordering. PowerShell launch, Windows single-instance GUI
behavior and real-model inference require the Windows lab and are **not**
validated by these model-free tests.

## Explicit staging/validation batch

Default launch never starts new candidate validation loads: an enabled discovery
configuration is copied to a private derived launch config with
`maxCandidatesPerRun: 0` (restore/hash only). To validate already downloaded
files, add `-ValidateReadyBatch`. If discovery is not configured yet, also pass
`-ModelRoot 'C:\actual\gguf-folder'`; the pinned manifest defaults to
`manifests/staccs-lecore-gguf.json` and can be explicitly selected with
`-DiscoveryManifest`. No missing file is downloaded or waited on.

The explicit batch sets `maxCandidatesPerRun: 10` in a new
`logs/local-auto-launch.<unique-id>.json`; the user's gateway config is unchanged.
Validation is serial, uses admission/memory guards, and stops for unsafe cleanup.
A cold request arriving after a validation load begins may wait behind it; a
load is not force-killed to preempt it. This mode is appropriate when staging
the batch, not when immediate interactive cold-start latency is the priority.
General-text smoke success does not establish tool use or quality.
