param(
 [Parameter(Mandatory=$true)][string]$CodexHome,
 [string]$CodexExe,
 [string]$Config='setup/gateway-config.json',
 [string]$ModelRoot,
 [string]$DiscoveryManifest='manifests/staccs-lecore-gguf.json',
 [switch]$ValidateReadyBatch,
 # Validation of newly downloaded models now runs by default at launch; -NoValidation restores hash-only startup.
 [switch]$NoValidation,
 # 'native' sizes discovered models at their GGUF native context (capped at 131072) so Codex-sized prompts fit.
 [string]$DiscoveryContext='native',
 [int]$DiscoveryWaitMinutes=45,
 # Stop an already-running gateway from this folder, but only when it reports no active, queued or loading work.
 [switch]$RestartIdleGateway,
 # Keep idle AUTO-loaded models instead of unloading them before validation.
 [switch]$KeepLoadedModels
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
$listener=Get-NetTCPConnection -LocalPort $settings.port -State Listen -ErrorAction SilentlyContinue|Select-Object -First 1
if($listener -and $RestartIdleGateway){
 $owner=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
 if(!$owner -or $owner.CommandLine -notmatch 'proxy\.mjs'){throw "Port $($settings.port) is held by something other than this gateway; nothing was stopped."}
 $current=Invoke-RestMethod "http://127.0.0.1:$($settings.port)/health" -TimeoutSec 10
 if($current.router.loading -or $current.router.queued -or @($current.router.instances|Where-Object {$_.active -gt 0}).Count){throw 'The running gateway is busy (active, queued or loading work). Let it finish, then rerun; nothing was stopped.'}
 Stop-Process -Id $owner.ProcessId
 Wait-Process -Id $owner.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
 Write-Output "Stopped idle gateway PID $($owner.ProcessId)."
}
# Codex is closed and no gateway is running, so idle AUTO-loaded models only block
# validation memory. Unload them; pinned (manually loaded) instances are kept.
if(!$KeepLoadedModels -and !(Get-NetTCPConnection -LocalPort $settings.port -State Listen -ErrorAction SilentlyContinue)){
 $overlay=Join-Path $PSScriptRoot 'logs/startup-model-registry.json'
 $controlRegistry=if(Test-Path -LiteralPath $overlay){$overlay}else{$registryPath}
 $control=Join-Path $PSScriptRoot 'instance-control.ps1'
 $inventory=(& $control -Registry $controlRegistry -Action Status)|ConvertFrom-Json
 foreach($instance in @($inventory.instances|Where-Object {$_.automatic})){
  $result=(& $control -Registry $controlRegistry -Action Stop -Model $instance.model -Replica $instance.replica)|ConvertFrom-Json
  if($result.error){Write-Output "Kept $($instance.key): $($result.error)"}else{Write-Output "Unloaded idle $($instance.key) to free memory for validation."}
 }
}
if(Get-NetTCPConnection -LocalPort $settings.port -State Listen -ErrorAction SilentlyContinue){throw 'Gateway port is already occupied. Finish active requests and close the existing gateway normally, then rerun. No listener was killed or reused; an older gateway may have stale startup/catalog code.'}
$node=(Get-Command node -ErrorAction Stop).Source
$gateway="http://127.0.0.1:$($settings.port)"
if($ModelRoot){
 $discovery=[pscustomobject]@{manifest=(Resolve-Path -LiteralPath $DiscoveryManifest).Path;modelRoot=(Resolve-Path -LiteralPath $ModelRoot).Path;context=4096;portStart=8300}
 $settings|Add-Member -Force -NotePropertyName startupDiscovery -NotePropertyValue $discovery
}
if($settings.startupDiscovery){
 $contextValue=if($DiscoveryContext -eq 'native'){'native'}else{[int]$DiscoveryContext}
 $settings.startupDiscovery|Add-Member -Force -NotePropertyName context -NotePropertyValue $contextValue
}
if($ValidateReadyBatch -and !$settings.startupDiscovery){throw '-ValidateReadyBatch requires -ModelRoot or an existing startupDiscovery configuration. No gateway or app was launched.'}
& $node (Join-Path $PSScriptRoot 'prepare-local-auto.mjs') --registry $registryPath --home $homePath --gateway "$gateway/v1" --apply
if($LASTEXITCODE -ne 0){throw 'Local AUTO preparation failed; Codex was not launched.'}
# A derived config makes discovery mode explicit without replacing user config.
# Restore/hash-only is the default; validation loads require the batch switch.
$launchConfig=$configPath
if($settings.startupDiscovery){
 $budget=if($NoValidation){0}else{1000}
 $settings.startupDiscovery|Add-Member -Force -NotePropertyName maxCandidatesPerRun -NotePropertyValue $budget
 New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'logs') -Force|Out-Null
 $launchConfig=Join-Path $PSScriptRoot ('logs/local-auto-launch.'+[guid]::NewGuid().ToString('N')+'.json')
 [IO.File]::WriteAllText($launchConfig,($settings|ConvertTo-Json -Depth 50),[Text.UTF8Encoding]::new($false))
 if(!$NoValidation){Write-Output 'Validation batch enabled: every ready candidate, serialized with memory/admission guards. New cold requests may wait behind a validation load; this is not model-quality or tool-use certification.'}
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
# Pre-launch hook: let discovery hash and validate new downloads, then export the
# gateway's live catalog (original + promoted models) as the catalog Codex loads.
if($settings.startupDiscovery){
 $waitUntil=(Get-Date).AddMinutes($DiscoveryWaitMinutes);$lastLine=''
 do{
  try{$state=(Invoke-RestMethod "$gateway/health" -TimeoutSec 10).router.startup_discovery}catch{$state=$null}
  $line=if($state){'Discovery '+$state.state+': '+((@($state.models)|ForEach-Object {$_.id+'='+$_.state}) -join ', ')}else{'Discovery starting'}
  if($line -ne $lastLine){Write-Output $line;$lastLine=$line}
  if($state -and $state.state -in 'complete','paused','failed'){break}
  Start-Sleep -Seconds 5
 }while((Get-Date) -lt $waitUntil)
 if(!$state -or $state.state -notin 'complete','paused','failed'){Write-Output "Discovery still running after $DiscoveryWaitMinutes minutes; launching with the models promoted so far."}
}
$liveCatalogText=(Invoke-WebRequest "$gateway/codex/models.json" -UseBasicParsing -TimeoutSec 10).Content
$liveCatalog=$liveCatalogText|ConvertFrom-Json
if(!($liveCatalog.models|Where-Object {$_.slug -eq 'auto'})){throw 'Live catalog lacks AUTO. Codex was not launched.'}
$liveCatalogPath=Join-Path $homePath 'auto-catalog.live.json'
$tmpCatalog="$liveCatalogPath.tmp"
[IO.File]::WriteAllText($tmpCatalog,$liveCatalogText,[Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $tmpCatalog -Destination $liveCatalogPath -Force
$tomlPath=Join-Path $homePath 'config.toml'
$toml=[IO.File]::ReadAllText($tomlPath)
$catalogLine='model_catalog_json = "'+$liveCatalogPath.Replace('\','\\')+'"'
if($toml -notmatch '(?m)^model_catalog_json\s*=.*$'){throw 'config.toml has no model_catalog_json line to update. Codex was not launched.'}
$updated=[regex]::Replace($toml,'(?m)^model_catalog_json\s*=.*$',[Text.RegularExpressions.MatchEvaluator]{param($m)$catalogLine})
if($updated -ne $toml){
 Copy-Item -LiteralPath $tomlPath -Destination (Join-Path $PSScriptRoot ('logs/config.toml.before-live-catalog.'+(Get-Date -Format 'yyyyMMdd-HHmmss'))) -Force
 [IO.File]::WriteAllText($tomlPath,$updated,[Text.UTF8Encoding]::new($false))
}
Write-Output ('Dropdown catalog: '+(($liveCatalog.models|ForEach-Object {$_.slug}) -join ', '))
$previousHome=$env:CODEX_HOME
try{
 $env:CODEX_HOME=$homePath
 Start-Process -FilePath $exePath -WorkingDirectory $PSScriptRoot | Out-Null
}finally{$env:CODEX_HOME=$previousHome}
Write-Output 'Started Codex with the explicitly selected local home. Open a NEW LOCAL thread and verify AUTO in the actual dropdown, then send a small request. Launch/config success is not proof of GUI visibility or inference. No models were downloaded or eagerly loaded by this launcher.'
