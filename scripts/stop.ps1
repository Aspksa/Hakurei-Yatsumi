param([Parameter(Mandatory=$true)][string]$ProjectRoot)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($ProjectRoot)
$state=Join-Path $root 'logs\services.json'
$watchState=Join-Path $root 'logs\watchdog.json'

function Owned($entry){
 if(-not $entry -or -not $entry.pid -or -not $entry.started -or -not $entry.path){return $false}
 try {
  $p=Get-Process -Id ([int]$entry.pid) -ErrorAction Stop
  return ($p.Path -ieq [string]$entry.path -and [Math]::Abs(($p.StartTime.ToUniversalTime()-[datetime]::Parse([string]$entry.started).ToUniversalTime()).TotalSeconds) -lt 3)
 }catch{return $false}
}
if(Test-Path -LiteralPath $watchState){
 try{$watch=Get-Content -LiteralPath $watchState -Raw -Encoding UTF8|ConvertFrom-Json;Remove-Item -LiteralPath $watchState -Force;if(Owned $watch){Stop-Process -Id ([int]$watch.pid) -Force -ErrorAction SilentlyContinue}}catch{Remove-Item -LiteralPath $watchState -Force -ErrorAction SilentlyContinue}
}
if(-not (Test-Path -LiteralPath $state)){Write-Host 'No managed services recorded';exit 0}
$saved=Get-Content -LiteralPath $state -Raw -Encoding UTF8|ConvertFrom-Json
foreach($entry in @($saved.node,$saved.python)){
 if(Owned $entry){Stop-Process -Id ([int]$entry.pid) -Force -ErrorAction Stop;Write-Host "Stopped PID $($entry.pid)"}
}
Remove-Item -LiteralPath $state -Force
Write-Host 'Managed services stopped'
