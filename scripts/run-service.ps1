param([Parameter(Mandatory=$true)][string]$ProjectRoot,[Parameter(Mandatory=$true)][ValidateSet('python','node')][string]$Service,[string]$NodePath)
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $ProjectRoot
$logDir=Join-Path $ProjectRoot 'logs'
[IO.Directory]::CreateDirectory($logDir)|Out-Null
$keyFile=Join-Path $ProjectRoot '.yatsumi-api-key'
if (-not $env:YATSUMI_API_KEY) {
 if (-not (Test-Path -LiteralPath $keyFile)) { throw 'Missing API key file' }
 $env:YATSUMI_API_KEY=[IO.File]::ReadAllText($keyFile).Trim()
}
$env:PYTHON_API_URL='http://127.0.0.1:8000'
$log=Join-Path $logDir "$Service.log"
try {
 "[$(Get-Date -Format o)] Starting $Service" | Out-File -LiteralPath $log -Append -Encoding utf8
 if ($Service -eq 'python') {
  $exe=Join-Path $ProjectRoot '.venv\Scripts\python.exe'
  & $exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 *>&1 | Out-File -LiteralPath $log -Append -Encoding utf8
 } else {
  $exe=if ($NodePath -and (Test-Path -LiteralPath $NodePath)) { $NodePath } else { (Get-Command node.exe -ErrorAction Stop).Source }
  Set-Location -LiteralPath (Join-Path $ProjectRoot 'frontend')
  & $exe server.js *>&1 | Out-File -LiteralPath $log -Append -Encoding utf8
 }
 if ($LASTEXITCODE -ne 0) { throw "$Service exited with code $LASTEXITCODE" }
} catch {
 "[$(Get-Date -Format o)] ERROR: $($_.Exception.Message)" | Out-File -LiteralPath $log -Append -Encoding utf8
 Write-Host "Service failed. See $log" -ForegroundColor Red
 exit 1
}
