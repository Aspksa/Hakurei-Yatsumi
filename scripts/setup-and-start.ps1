param([Parameter(Mandatory=$true)][string]$ProjectRoot)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-Location -LiteralPath $ProjectRoot
$root = (Get-Location).Path
$minPython = [version]'3.10'
$minNode = [version]'20.0'
function Find-Python {
    $candidates = @()
    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($py) {
        try {
            $output = & $py.Source -3 -c 'import sys; print(sys.executable); print("{}.{}.{}".format(*sys.version_info[:3]))' 2>$null
            if ($LASTEXITCODE -eq 0 -and $output.Count -ge 2 -and [version]$output[1] -ge $minPython) { return [string]$output[0] }
        } catch {}
    }
    foreach ($cmd in @('python.exe','python3.exe')) {
        $item = Get-Command $cmd -ErrorAction SilentlyContinue
        if ($item) { $candidates += $item.Source }
    }
    $candidates += @(Get-ChildItem -Path "$env:LOCALAPPDATA\Programs\Python\Python*\python.exe" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
    foreach ($path in ($candidates | Select-Object -Unique)) {
        try {
            $version = & $path -c 'import sys; print("{}.{}.{}".format(*sys.version_info[:3]))' 2>$null
            if ($LASTEXITCODE -eq 0 -and [version]$version -ge $minPython) { return $path }
        } catch {}
    }
    return $null
}
function Find-Node {
    $candidates = @()
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }
    $candidates += @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:APPDATA\npm\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")
    foreach ($path in ($candidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        try {
            $v = (& $path --version 2>$null).TrimStart('v')
            if ($LASTEXITCODE -eq 0 -and [version]$v -ge $minNode) { return $path }
        } catch {}
    }
    return $null
}
function Download-SignedInstaller([string]$url, [string]$file) {
    Write-Host "Downloading official installer: $url"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
    $sig = Get-AuthenticodeSignature -LiteralPath $file
    if ($sig.Status -ne 'Valid') { throw "Installer signature is not valid: $($sig.Status)" }
}
function Install-Missing([string]$id, [string]$url, [string]$extension) {
    Write-Host "Missing or unsupported $id. Attempting installation..."
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($winget) {
        & $winget.Source install --id $id --exact --source winget --accept-source-agreements --accept-package-agreements --silent --disable-interactivity
        if ($LASTEXITCODE -eq 0) { return }
        Write-Warning "winget could not install $id; trying signed official installer."
    }
    $tempFile = Join-Path $env:TEMP ("yatsumi-" + [guid]::NewGuid().ToString('N') + $extension)
    try {
        Download-SignedInstaller $url $tempFile
        if ($extension -eq '.exe') {
            $proc = Start-Process -FilePath $tempFile -ArgumentList '/quiet','InstallAllUsers=0','PrependPath=1','Include_test=0' -Wait -PassThru
        } else {
            $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ('"' + $tempFile + '"'), '/qn', '/norestart') -Wait -PassThru
        }
        if ($proc.ExitCode -notin @(0,3010)) { throw "Installer exited with code $($proc.ExitCode)" }
    } finally { Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue }
}
try {
    Write-Host '=== Hakurei Yatsumi | Windows Setup ==='
    if (-not (Test-Path -LiteralPath (Join-Path $root 'backend\requirements.txt'))) { throw 'Run the BAT from the complete project folder.' }
    $python = Find-Python
    if (-not $python) {
        Install-Missing 'Python.Python.3.12' 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe' '.exe'
        $python = Find-Python
    }
    if (-not $python) { throw 'Python 3.10+ not detected after installation. Restart Windows or install Python from python.org.' }
    Write-Host "Python: $python"
    $node = Find-Node
    if (-not $node) {
        Install-Missing 'OpenJS.NodeJS.LTS' 'https://nodejs.org/dist/v22.16.0/node-v22.16.0-x64.msi' '.msi'
        $node = Find-Node
    }
    if (-not $node) { throw 'Node.js 20+ not detected after installation. Restart Windows or install Node.js from nodejs.org.' }
    Write-Host "Node: $node"
    $nodeDir = Split-Path -Parent $node
    $env:PATH = "$nodeDir;$env:PATH"
    $npm = Join-Path $nodeDir 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npm)) { throw 'npm.cmd missing next to node.exe.' }
    $venvPython = Join-Path $root '.venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $venvPython) {
        & $venvPython -c 'import sys; print(sys.prefix)' 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'Rebuilding broken or moved virtual environment...'
            Remove-Item -LiteralPath (Join-Path $root '.venv') -Recurse -Force
        }
    }
    if (-not (Test-Path -LiteralPath $venvPython)) {
        Write-Host '[1/5] Creating Python environment...'
        & $python -m venv (Join-Path $root '.venv')
        if ($LASTEXITCODE -ne 0) { throw 'Could not create Python environment.' }
    }
    Write-Host '[2/5] Installing Python packages...'
    & $venvPython -m pip install -r (Join-Path $root 'backend\requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'pip install failed.' }
    Write-Host '[3/5] Installing Node packages...'
    Push-Location -LiteralPath (Join-Path $root 'frontend')
    try {
        & $npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
    } finally { Pop-Location }
    $keyFile = Join-Path $root '.yatsumi-api-key'
    if (-not (Test-Path -LiteralPath $keyFile)) {
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        [IO.File]::WriteAllText($keyFile, [Convert]::ToBase64String($bytes), [Text.Encoding]::ASCII)
    }
    $env:YATSUMI_API_KEY = if ($env:YATSUMI_API_KEY) { $env:YATSUMI_API_KEY } else { [IO.File]::ReadAllText($keyFile).Trim() }
    if (-not $env:YATSUMI_API_KEY) { throw 'API key is empty.' }
    $env:PYTHON_API_URL = 'http://127.0.0.1:8000'
    Write-Host '[4/5] Applying SQLite migrations...'
    & $venvPython -m backend.app.db
    if ($LASTEXITCODE -ne 0) { throw 'Database migration failed.' }
    Write-Host '[5/5] Starting services...'
    $runner = Join-Path $root 'scripts\run-service.ps1'
    foreach ($service in @('python','node')) {
        $arguments = @('-NoProfile','-NoExit','-ExecutionPolicy','Bypass','-File',('"' + $runner + '"'),'-ProjectRoot',('"' + $root + '"'),'-Service',$service,'-NodePath',('"' + $node + '"'))
        Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $root
    }
    Start-Sleep -Seconds 3
    Start-Process 'http://127.0.0.1:8000/docs'
    Write-Host 'Started. API docs: http://127.0.0.1:8000/docs'
    Write-Host 'Node gateway: http://127.0.0.1:3000/api'
    Write-Host 'Close both service windows to stop the project.'
    exit 0
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
