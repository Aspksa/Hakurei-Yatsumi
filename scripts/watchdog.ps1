param([Parameter(Mandatory=$true)][string]$ProjectRoot)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($ProjectRoot)
$logs=Join-Path $root 'logs'
$state=Join-Path $logs 'services.json'
$watchState=Join-Path $logs 'watchdog.json'
$script=Join-Path $root 'scripts\setup-and-start.ps1'
$attempts=New-Object 'System.Collections.Generic.List[datetime]'
function Healthy([string]$url) {
 try {
  $key=[IO.File]::ReadAllText((Join-Path $root '.yatsumi-api-key')).Trim()
  $response=Invoke-WebRequest -Uri $url -Headers @{'x-api-key'=$key} -UseBasicParsing -TimeoutSec 3
  return $response.StatusCode -eq 200
 }catch{return $false}
}
while(Test-Path -LiteralPath $watchState) {
 Start-Sleep -Seconds 15
 if(-not (Test-Path -LiteralPath $watchState)){break}
 if(-not (Test-Path -LiteralPath $state)){continue}
 if((Healthy 'http://127.0.0.1:8000/health') -and (Healthy 'http://127.0.0.1:3000/gateway/health')){continue}
 $now=Get-Date
 foreach($date in @($attempts.ToArray())){if(($now-$date).TotalMinutes -gt 5){[void]$attempts.Remove($date)}}
 if($attempts.Count -ge 3){
  "[{0}] Watchdog restart limit reached" -f $now.ToString('o') | Add-Content -LiteralPath (Join-Path $logs 'watchdog.log')
  break
 }
 $attempts.Add($now)
 try {
  & $script -ProjectRoot $root -NoBrowser -Offline -NoWatchdog
  if($LASTEXITCODE -ne 0){throw "Restart failed with code $LASTEXITCODE"}
 }catch{
  "[{0}] Watchdog restart failed" -f $now.ToString('o') | Add-Content -LiteralPath (Join-Path $logs 'watchdog.log')
 }
}
