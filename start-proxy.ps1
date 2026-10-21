param([string]$Config='setup/gateway-config.json')
$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot
$node=(Get-Command node -ErrorAction Stop).Source
$settings=Get-Content $Config -Raw|ConvertFrom-Json
if(Get-NetTCPConnection -LocalPort $settings.port -State Listen -ErrorAction SilentlyContinue){throw 'Configured gateway port is occupied'}
New-Item -ItemType Directory -Path logs -Force|Out-Null
$arguments=@('proxy.mjs',('"'+(Resolve-Path -LiteralPath $Config).Path+'"'))
$proc=Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput logs/proxy-out.log -RedirectStandardError logs/proxy-err.log
$proc.Id|Set-Content logs/proxy.pid
Write-Output "Gateway PID $($proc.Id). Check http://127.0.0.1:$($settings.port)/health before sending requests."
