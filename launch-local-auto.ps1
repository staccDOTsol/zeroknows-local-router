param(
 [Parameter(Mandatory=$true)][string]$CodexHome,
 [string]$CodexExe,
 [string]$Config='setup/gateway-config.json',
 [string]$ModelRoot,
 [string]$DiscoveryManifest='manifests/staccs-lecore-gguf.json',
 [switch]$ValidateReadyBatch
)
$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot
$homePath=(Resolve-Path -LiteralPath $CodexHome).Path
$configPath=(Resolve-Path -LiteralPath $Config).Path
if(!(Test-Path -LiteralPath (Join-Path $homePath 'config.toml') -PathType Leaf)){throw 'The explicit CodexHome must already contain the local provider config.toml.'}
# Discover only the executable of an actual visible Codex main window, never
# an updater, helper, background renderer or an arbitrary PATH executable.
$processes=@(Get-CimInstance Win32_Process)
if(!$CodexExe){
 $visibleIds=@(Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.ProcessName -eq 'Codex' -and $_.MainWindowHandle -ne 0} | Select-Object -ExpandProperty Id)
 $candidates=@($processes | Where-Object {$_.ProcessId -in $visibleIds -and $_.ExecutablePath -and $_.CommandLine -notmatch '(?:--type=|--update|--install|app-server)'} | Select-Object -ExpandProperty ExecutablePath -Unique)
 if($candidates.Count -ne 1){throw 'Could not identify exactly one visible Codex desktop executable. Rerun this command with -CodexExe followed by the actual installed desktop executable path; no configuration changed.'}
 $CodexExe=$candidates[0]
}
$exePath=(Resolve-Path -LiteralPath $CodexExe).Path
# Never force-kill an app, or let a single-instance app silently reuse an old home.
$running=@($processes | Where-Object { $_.ExecutablePath -eq $exePath -or $_.Name -match '^Codex(?:\.exe)?$' })
if($running.Count){
 function Quote-PS([string]$value){return "'"+$value.Replace("'","''")+"'"}
 $relaunch='& '+(Quote-PS $PSCommandPath)+' -CodexHome '+(Quote-PS $homePath)+' -CodexExe '+(Quote-PS $exePath)+' -Config '+(Quote-PS $configPath)
 if($ModelRoot){$relaunch+=' -ModelRoot '+(Quote-PS $ModelRoot)+' -DiscoveryManifest '+(Quote-PS $DiscoveryManifest)}
 if($ValidateReadyBatch){$relaunch+=' -ValidateReadyBatch'}
 Write-Output "After closing Codex normally, rerun this exact command: $relaunch"
 throw 'Close Codex normally (finish or cancel active work first), including its tray window. A running single-instance GUI can ignore the new CODEX_HOME; nothing was changed or killed.'
}
$settings=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json
if(!$settings.registry){throw 'Managed gateway config.registry is required.'}
$registryPath=if([IO.Path]::IsPathRooted($settings.registry)){$settings.registry}else{Join-Path $PSScriptRoot $settings.registry}
if(Get-NetTCPConnection -LocalPort $settings.port -State Listen -ErrorAction SilentlyContinue){throw 'Gateway port is already occupied. Finish active requests and close the existing gateway normally, then rerun. No listener was killed or reused; an older gateway may have stale startup/catalog code.'}
$node=(Get-Command node -ErrorAction Stop).Source
$gateway="http://127.0.0.1:$($settings.port)"
if($ModelRoot){
 $discovery=[pscustomobject]@{manifest=(Resolve-Path -LiteralPath $DiscoveryManifest).Path;modelRoot=(Resolve-Path -LiteralPath $ModelRoot).Path;context=4096;portStart=8300}
 $settings|Add-Member -Force -NotePropertyName startupDiscovery -NotePropertyValue $discovery
}
if($ValidateReadyBatch -and !$settings.startupDiscovery){throw '-ValidateReadyBatch requires -ModelRoot or an existing startupDiscovery configuration. No gateway or app was launched.'}
& $node (Join-Path $PSScriptRoot 'prepare-local-auto.mjs') --registry $registryPath --home $homePath --gateway "$gateway/v1" --apply
if($LASTEXITCODE -ne 0){throw 'Local AUTO preparation failed; Codex was not launched.'}
# A derived config makes discovery mode explicit without replacing user config.
# Restore/hash-only is the default; validation loads require the batch switch.
$launchConfig=$configPath
if($settings.startupDiscovery){
 $budget=if($ValidateReadyBatch){10}else{0}
 $settings.startupDiscovery|Add-Member -Force -NotePropertyName maxCandidatesPerRun -NotePropertyValue $budget
 New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'logs') -Force|Out-Null
 $launchConfig=Join-Path $PSScriptRoot ('logs/local-auto-launch.'+[guid]::NewGuid().ToString('N')+'.json')
 [IO.File]::WriteAllText($launchConfig,($settings|ConvertTo-Json -Depth 50),[Text.UTF8Encoding]::new($false))
 if($ValidateReadyBatch){Write-Output 'Explicit validation batch enabled: at most 10 ready candidates, serialized with memory/admission guards. New cold requests may wait behind a validation load; this is not model-quality or tool-use certification.'}
 else{Write-Output 'Startup discovery will restore/hash only; no new candidate validation loads.'}
}
& (Join-Path $PSScriptRoot 'start-proxy.ps1') -Config $launchConfig
$deadline=(Get-Date).AddSeconds(30)
$health=$null
while((Get-Date) -lt $deadline){
 try{$health=Invoke-RestMethod "$gateway/health" -TimeoutSec 3;if($health.status -eq 'ok' -and $health.router.version -ge 2){break}}catch{}
 Start-Sleep -Milliseconds 500
}
if(!$health -or $health.router.version -lt 2){throw 'Expected managed gateway v2 was not confirmed. Codex was not launched; inspect logs/proxy-err.log. Do not blindly start a duplicate gateway.'}
$catalog=Invoke-RestMethod "$gateway/codex/models.json" -TimeoutSec 3
if(!($catalog.models|Where-Object {$_.slug -eq 'auto' -and $_.visibility -eq 'list'})){throw 'Gateway native catalog lacks visible AUTO. Codex was not launched.'}
$previousHome=$env:CODEX_HOME
try{
 $env:CODEX_HOME=$homePath
 Start-Process -FilePath $exePath -WorkingDirectory $PSScriptRoot | Out-Null
}finally{$env:CODEX_HOME=$previousHome}
Write-Output 'Started Codex with the explicitly selected local home. Open a NEW LOCAL thread and verify AUTO in the actual dropdown, then send a small request. Launch/config success is not proof of GUI visibility or inference. No models were downloaded or eagerly loaded by this launcher.'
