$ErrorActionPreference='Stop'
foreach($file in (Get-ChildItem $PSScriptRoot -Filter '*.ps1')){
 $tokens=$null;$errors=$null
 [Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors)|Out-Null
 if($errors){throw "PowerShell syntax error: $($file.Name): $errors"}
}
$created=[DateTime]::Parse('2026-10-21T04:21:18.7602480Z').ToUniversalTime()
$record=@{created=$created.ToString('o')}|ConvertTo-Json|ConvertFrom-Json
if($created.Ticks -ne ([DateTime]$record.created).ToUniversalTime().Ticks){throw 'Process ownership timestamp roundtrip failed'}
$source=Get-Content (Join-Path $PSScriptRoot 'instance-control.ps1') -Raw
if($source -notmatch 'CreationDate.ToUniversalTime\(\).Ticks' -or $source -notmatch 'AbandonedMutexException'){throw 'Ownership/abandoned-mutex regression guard missing'}
'PASS: PowerShell syntax, process creation timestamp JSON roundtrip and ownership guard'
