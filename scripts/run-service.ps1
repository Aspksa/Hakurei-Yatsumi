param([Parameter(Mandatory=$true)][string]$ProjectRoot,[ValidateSet('python','node')][string]$Service,[string]$NodePath)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $ProjectRoot
$keyFile = Join-Path $ProjectRoot '.yatsumi-api-key'
if (-not $env:YATSUMI_API_KEY) { $env:YATSUMI_API_KEY = [IO.File]::ReadAllText($keyFile).Trim() }
$env:PYTHON_API_URL = 'http://127.0.0.1:8000'
if ($Service -eq 'python') {
    & (Join-Path $ProjectRoot '.venv\Scripts\python.exe') -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
} else {
    $node = if ($NodePath -and (Test-Path -LiteralPath $NodePath)) { $NodePath } else { (Get-Command node.exe -ErrorAction Stop).Source }
    Set-Location -LiteralPath (Join-Path $ProjectRoot 'frontend')
    & $node server.js
}
