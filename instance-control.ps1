param(
 [ValidateSet('Status','Start','Stop','Pin','Plan')][string]$Action='Status',
 [string]$Registry=(Join-Path $PSScriptRoot 'setup/model-registry.json'),
 [string]$Model,
 [ValidateRange(0,1)][int]$Replica=0,
 [ValidateRange(1,1024)][int]$Slots=1,
 [switch]$Automatic
)
$ErrorActionPreference='Stop'
$mutex=$null;$owned=$false
function Resolve-LocalPath([string]$Path){if([IO.Path]::IsPathRooted($Path)){return $Path};return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $Path))}
function Read-Record($Definition,[int]$Index){
 $key="$($Definition.id)-$Index";$path=Join-Path $stateDir "$key.json"
 if(!(Test-Path -LiteralPath $path)){return $null}
 $record=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json
 $process=Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$record.pid)"
 if(!$process -or $process.ExecutablePath -ne $serverPath -or $process.CreationDate.ToUniversalTime().Ticks -ne ([DateTime]$record.created).ToUniversalTime().Ticks -or $process.CommandLine -notmatch ('--alias\s+'+[regex]::Escape($Definition.id)+'(?:\s|$)')){return $null}
 $ready=$false
 try{$health=Invoke-RestMethod "http://127.0.0.1:$($record.port)/health" -TimeoutSec 1;if($health.status -eq 'ok'){$props=Invoke-RestMethod "http://127.0.0.1:$($record.port)/props" -TimeoutSec 1;$ready=$props.model_alias -eq $Definition.id -and [int]$props.default_generation_settings.n_ctx -eq [int]$Definition.context}}catch{}
 $record|Add-Member -Force -NotePropertyName ready -NotePropertyValue $ready
 return $record
}
function Model-Ready($Definition){
 foreach($file in $Definition.files){$path=Resolve-LocalPath $file.path;if(!(Test-Path -LiteralPath $path) -or (Get-Item -LiteralPath $path).Length -ne [long]$file.bytes){return $false}}
 # Files must have a recorded full SHA256 verification. Never download automatically.
 foreach($file in $Definition.files){$journal=Resolve-LocalPath $file.verificationJournal;if(!(Test-Path -LiteralPath $journal) -or !(Select-String -LiteralPath $journal -Pattern $file.sha256 -SimpleMatch -Quiet)){return $false}}
 return $true
}
function Inventory {
 $instances=@(foreach($definition in $registryData.models){for($i=0;$i -lt $definition.ports.Count;$i++){$r=Read-Record $definition $i;if($r){$r}}})
 $models=@(foreach($definition in $registryData.models){[pscustomobject]@{id=$definition.id;ready=(Model-Ready $definition)}})
 [pscustomobject]@{instances=$instances;models=$models;freeBytes=([long](Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory*1KB)}
}
try{
 $registryData=Get-Content -LiteralPath $Registry -Raw|ConvertFrom-Json
 $serverPath=Resolve-LocalPath $registryData.serverPath
 $stateDir=Join-Path $PSScriptRoot 'logs/instances'
 if($Action -eq 'Status'){Inventory|ConvertTo-Json -Depth 12 -Compress;return}
 $definition=$registryData.models|Where-Object id -eq $Model
 if(!$definition -or $Replica -ge $definition.ports.Count){throw 'Unknown model or replica'}
 $mutex=[Threading.Mutex]::new($false,'Local\ZeroKnowsModelAdmission')
 try{$owned=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owned=$true}
 if(!$owned){throw 'Another model lifecycle operation is in progress'}
 New-Item -ItemType Directory -Path $stateDir -Force|Out-Null
 $record=Read-Record $definition $Replica
 if($Action -eq 'Pin'){
  if(!$record){throw 'Cannot pin an absent process'}
  $record.automatic=$false
  $record|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $stateDir "$($record.key).json")
  $record|ConvertTo-Json -Compress;return
 }
 if($Action -eq 'Stop'){
  if(!$record){@{stopped=$false;reason='No owned process'}|ConvertTo-Json -Compress;return}
  # Direct API users are protected as well as requests passing through the router.
  if(!$record.ready){throw 'Instance is still loading or unhealthy; inspect it before stopping'}
  try{$slotsState=@(Invoke-RestMethod "http://127.0.0.1:$($record.port)/slots" -TimeoutSec 3)}catch{throw 'Cannot verify direct server slots are idle; refusing unload'}
  if($slotsState|Where-Object is_processing){throw 'Direct server generation is active; refusing unload'}
  Stop-Process -Id $record.pid -ErrorAction Stop
  Wait-Process -Id $record.pid -Timeout 30 -ErrorAction SilentlyContinue
  if(Get-Process -Id $record.pid -ErrorAction SilentlyContinue){throw 'Process has not exited; outcome uncertain'}
  Remove-Item -LiteralPath (Join-Path $stateDir "$($record.key).json")
  @{stopped=$true;model=$Model;pid=$record.pid}|ConvertTo-Json -Compress;return
 }
 if($record){if(!$record.ready){throw 'An owned instance is still loading or unhealthy; inspect logs before retrying'};$record|ConvertTo-Json -Compress;return}
 if(!(Model-Ready $definition)){throw 'Model files are missing or have no SHA256 verification record'}
 if(!(Test-Path -LiteralPath $serverPath)){throw 'Configured llama-server executable is missing'}
 if($definition.context -le 0 -or $definition.context -gt $definition.nativeContext){throw 'Configured context exceeds native context'}
 $port=[int]$definition.ports[$Replica]
 if(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue){throw "Port $port is occupied by an unowned listener; it will not be stopped"}
 $memory=Get-CimInstance Win32_OperatingSystem
 $available=[long]$memory.FreePhysicalMemory*1KB
 $weightBytes=[long](($definition.files|Measure-Object bytes -Sum).Sum)
 # One unified KV pool of the configured context is shared by all parallel slots.
 $required=$weightBytes+[long]$definition.kvBytesPerToken*[long]$definition.context+[long]$definition.fixedCacheMiB*1MB+([long]$definition.promptCacheGiB+3+6)*1GB
 if($available -lt $required){@{error=("Insufficient memory for $Model with $Slots slots: need {0:N2} GiB free including 6 GiB headroom, available {1:N2} GiB" -f ($required/1GB),($available/1GB));status=507}|ConvertTo-Json -Compress;return}
 # This local configuration is UMA. Never add GPU and system RAM budgets together.
 if($registryData.memoryMode -ne 'uma'){throw 'Automatic GPU admission requires an explicitly configured UMA memory budget; discrete VRAM admission is not implemented'}
 $main=$definition.files|Where-Object role -eq 'model'|Select-Object -First 1
 $projector=$definition.files|Where-Object role -eq 'projector'|Select-Object -First 1
 $argsList=@('-m',('"'+(Resolve-LocalPath $main.path)+'"'),'--alias',$Model,'--host','127.0.0.1','--port',"$port",'-ngl','99','-c',"$([long]$definition.context)",'-np',"$Slots",'--kv-unified','--no-cache-idle-slots','--cache-ram',"$([int]$definition.promptCacheGiB*1024)",'--offline','--no-webui','--slots','--no-context-shift','--cors-origins','localhost','-lv','4')
 if($projector){$argsList+=@('--mmproj',('"'+(Resolve-LocalPath $projector.path)+'"'))}
 if($definition.tasks -contains 'embedding'){$argsList+=@('--embedding','--pooling','last','-b','512','-ub','512')}
 if($Model -eq 'nemotron-super-vl-q4'){$argsList+=@('-b','256','-ub','128','--spec-type','none','--ctx-checkpoints','16','--checkpoint-min-step','1024')}
 # Generation slots get one token per server step, and a step waits for its whole prompt
 # batch. Small steps keep parallel generations moving while other slots read long prompts.
 elseif($definition.tasks -notcontains 'embedding'){$argsList+=@('-b','256','-ub','256')}
 if($Action -eq 'Plan'){@{model=$Model;replica=$Replica;slots=$Slots;sharedContext=$definition.context;kvUnified=$true;port=$port;requiredBytes=$required;availableBytes=$available;arguments=$argsList}|ConvertTo-Json -Compress;return}
 $key="$Model-$Replica"
 # N-gram speculative decoding drafts tokens from text already in the context (measured:
 # +86% on code rewrites, +22% freeform for dense models, neutral for MoE). A model that
 # cannot start with it is retried once without it; "spec": false in the registry opts out.
 $useSpec=($Model -ne 'nemotron-super-vl-q4') -and ($definition.tasks -notcontains 'embedding') -and ($definition.spec -ne $false)
 foreach($attempt in 0,1){
  $withSpec=$useSpec -and $attempt -eq 0
  if($attempt -eq 1 -and !$useSpec){break}
  $launchArgs=if($withSpec){$argsList+@('--spec-type','ngram-mod')}else{$argsList}
  $proc=Start-Process -FilePath $serverPath -ArgumentList $launchArgs -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $stateDir "$key-out.log") -RedirectStandardError (Join-Path $stateDir "$key-err.log")
  $identity=Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)"
  $record=[pscustomobject]@{key=$key;model=$Model;replica=$Replica;pid=$proc.Id;created=$identity.CreationDate.ToUniversalTime().ToString('o');port=$port;slots=$Slots;context=$definition.context;automatic=[bool]$Automatic;ready=$false;spec=$withSpec}
  $record|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $stateDir "$key.json")
  $deadline=(Get-Date).AddMinutes(30);$exited=$false
  do{
   if(!(Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)){$exited=$true;break}
   $current=Read-Record $definition $Replica
   if($current.ready){$current|ConvertTo-Json -Compress;return}
   Start-Sleep -Milliseconds 1000
  }while((Get-Date) -lt $deadline)
  if(!$exited){throw 'Readiness timed out; process retained for inspection. No duplicate will be started.'}
  if(!$withSpec){break}
 }
 throw "Model process exited while loading; see logs/instances/$key-err.log"
}catch{@{error=$_.Exception.Message;status=503}|ConvertTo-Json -Compress}
finally{if($owned){$mutex.ReleaseMutex()};if($mutex){$mutex.Dispose()}}
