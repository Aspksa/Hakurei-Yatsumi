param([Parameter(Mandatory=$true)][string]$ProjectRoot)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($ProjectRoot)
$state=Join-Path $root 'logs\services.json'
$watchState=Join-Path $root 'logs\watchdog.json'

function Owned([object]$entry) {
 if(-not $entry -or -not $entry.pid -or -not $entry.path){return $false}
 try {
  $p=Get-Process -Id ([int]$entry.pid) -ErrorAction Stop
  $start=$p.StartTime.ToUniversalTime()
  $matchesStart=if($entry.startTicks){$start.Ticks -eq [long]$entry.startTicks}
   else{[Math]::Abs(($start-[datetimeoffset]::Parse([string]$entry.started).UtcDateTime).TotalSeconds) -lt 3}
  return ($p.Path -ieq [string]$entry.path -and $matchesStart)
 }catch{return $false}
}
$logs=Join-Path $root 'logs'
if(-not (Test-Path -LiteralPath $logs)){Write-Host 'No managed services recorded';exit 0}
try{$lock=[IO.File]::Open((Join-Path $logs 'launcher.lock'),'OpenOrCreate','ReadWrite','None')}
catch [IO.IOException]{Write-Host 'Another launch or stop operation is running.';exit 1}
try{
 if(Test-Path -LiteralPath $watchState){
  try{
   $watch=Get-Content -LiteralPath $watchState -Raw -Encoding UTF8|ConvertFrom-Json
   if(Owned $watch){Stop-Process -Id ([int]$watch.pid) -Force -ErrorAction SilentlyContinue}
  }catch{Write-Host 'Watchdog state could not be read.'}
  finally{Remove-Item -LiteralPath $watchState -Force -ErrorAction SilentlyContinue}
 }
 if(-not (Test-Path -LiteralPath $state)){Write-Host 'No managed services recorded';exit 0}
 $saved=Get-Content -LiteralPath $state -Raw -Encoding UTF8|ConvertFrom-Json
 foreach($entry in @($saved.node,$saved.python)){
  if(Owned $entry){
   & taskkill.exe /PID ([int]$entry.pid) /T /F
   if($LASTEXITCODE -ne 0 -and (Owned $entry)){throw "Could not stop PID $($entry.pid)"}
  }
 }
 Remove-Item -LiteralPath $state -Force
 Write-Host 'Managed services stopped'
 exit 0
}finally{
 $lock.Dispose()
}
