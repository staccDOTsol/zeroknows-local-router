# One-click local Codex launch. Use this instead of local-auto-startup.pyz: the pyz
# reinstalls its bundled copies of the gateway scripts over this folder's fixes.
# Flow: stop the idle gateway -> start gateway -> discover + validate new downloads
# -> export the live catalog (original + promoted models) -> start Codex.
$ErrorActionPreference='Stop'
$runtime='C:\Users\User\.cache\codex-runtimes\codex-primary-runtime\dependencies'
$env:PATH="$runtime\node\bin;$runtime\python;"+$env:PATH
$package=Get-AppxPackage -Name OpenAI.Codex|Sort-Object Version -Descending|Select-Object -First 1
if(!$package){throw 'OpenAI Codex desktop package not found.'}
$exe=Join-Path $package.InstallLocation 'app\ChatGPT.exe'
& (Join-Path $PSScriptRoot 'launch-local-auto.ps1') -CodexHome (Join-Path $PSScriptRoot 'local-codex-home') -CodexExe $exe -Config (Join-Path $PSScriptRoot 'setup\gateway-config.json') -ModelRoot 'C:\Users\User\Documents\ZeroKnowsModels\gguf' -DiscoveryManifest (Join-Path $PSScriptRoot 'manifests\staccs-lecore-gguf.json') -RestartIdleGateway @args
