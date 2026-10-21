param([ValidateSet('Status','Load','Unload','Reload')][string]$Action='Status',[string]$Model,[int]$Port=8090)
$ErrorActionPreference='Stop'
if($Action -eq 'Status'){(Invoke-RestMethod "http://127.0.0.1:$Port/health").router|ConvertTo-Json -Depth 12;return}
if(!$Model){throw 'Specify an exact -Model id'}
$body=@{action=$Action.ToLowerInvariant();model=$Model}|ConvertTo-Json -Compress
Invoke-RestMethod "http://127.0.0.1:$Port/admin/models" -Method Post -Headers @{'X-Local-Control'='1'} -ContentType application/json -Body $body -TimeoutSec 660|ConvertTo-Json -Depth 8
