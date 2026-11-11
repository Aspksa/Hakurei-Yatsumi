param([Parameter(Mandatory=$true)][string]$ProjectRoot)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root=[IO.Path]::GetFullPath($ProjectRoot)
$logDir=Join-Path $root 'logs'
[IO.Directory]::CreateDirectory($logDir)|Out-Null
$logFile=Join-Path $logDir 'startup.log'
function Log([string]$msg) {
 $line="[$(Get-Date -Format o)] $msg"
 Write-Host $line
 [IO.File]::AppendAllText($logFile,$line+[Environment]::NewLine,[Text.Encoding]::UTF8)
}
function Find-Python {
 $candidates=New-Object 'System.Collections.Generic.List[string]'
 $py=Get-Command py.exe -ErrorAction SilentlyContinue
 if ($py) {
  try {
   $v=@(& $py.Source -3 -c 'import sys; print(sys.executable)' 2>$null)
   if ($LASTEXITCODE -eq 0 -and $v.Count) { $candidates.Add([string]$v[0]) }
  } catch {}
 }
 foreach ($cmd in @('python.exe','python3.exe')) {
  $found=Get-Command $cmd -ErrorAction SilentlyContinue
  if ($found) { $candidates.Add($found.Source) }
 }
 foreach ($base in @($env:LOCALAPPDATA,$env:ProgramFiles,${env:ProgramFiles(x86)})) {
  if (-not $base) { continue }
  foreach ($file in @(Get-ChildItem -Path (Join-Path $base 'Programs\Python\Python*\python.exe') -ErrorAction SilentlyContinue)) { $candidates.Add($file.FullName) }
 }
 foreach ($path in @($candidates|Select-Object -Unique)) {
  if (-not (Test-Path -LiteralPath $path)) { continue }
  try {
   $v=@(& $path -c 'import sys; print("{}.{}.{}".format(*sys.version_info[:3]))' 2>$null)
   if ($LASTEXITCODE -eq 0 -and $v.Count -and [version]$v[0] -ge [version]'3.10') { return $path }
  } catch {}
 }
 return $null
}
function Find-Node {
 $candidates=New-Object 'System.Collections.Generic.List[string]'
 $found=Get-Command node.exe -ErrorAction SilentlyContinue
 if ($found) { $candidates.Add($found.Source) }
 foreach ($base in @($env:ProgramFiles,${env:ProgramFiles(x86)})) { if ($base) { $candidates.Add((Join-Path $base 'nodejs\node.exe')) } }
 if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')) }
 foreach ($path in @($candidates|Select-Object -Unique)) {
  if (-not (Test-Path -LiteralPath $path)) { continue }
  try {
   $v=@(& $path --version 2>$null)
   if ($LASTEXITCODE -eq 0 -and $v.Count -and [version]([string]$v[0]).TrimStart('v') -ge [version]'20.0') { return $path }
  } catch {}
 }
 return $null
}
function Install-Dependency([string]$id,[string]$url,[string]$ext) {
 Log "Installing $id"
 $winget=Get-Command winget.exe -ErrorAction SilentlyContinue
 if ($winget) {
  try {
   & $winget.Source install --id $id --exact --source winget --scope user --accept-source-agreements --accept-package-agreements --silent --disable-interactivity 2>&1 | ForEach-Object { Log ([string]$_) }
   if ($LASTEXITCODE -eq 0) { return }
   Log "winget failed: $LASTEXITCODE"
  } catch { Log "winget error: $($_.Exception.Message)" }
 }
 if (-not [Environment]::Is64BitOperatingSystem) { throw 'Fallback installers require Windows x64' }
 $file=Join-Path $env:TEMP ("yatsumi-"+[guid]::NewGuid().ToString('N')+$ext)
 try {
  [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
  Log "Downloading official installer: $url"
  Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
  $sig=Get-AuthenticodeSignature -LiteralPath $file
  if ($sig.Status -ne 'Valid') { throw "Invalid installer signature: $($sig.Status)" }
  if ($ext -eq '.exe') {
   $p=Start-Process -FilePath $file -ArgumentList @('/quiet','InstallAllUsers=0','PrependPath=1','Include_test=0') -Wait -PassThru
  } else {
   $p=Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i',('"'+$file+'"'),'/qn','/norestart') -Wait -PassThru
  }
  if ($p.ExitCode -notin @(0,3010)) { throw "Installer exit code: $($p.ExitCode)" }
 } finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
}
function Retry([string]$name,[scriptblock]$action) {
 for ($attempt=1;$attempt -le 2;$attempt++) {
  Log "$name (attempt $attempt/2)"
  try {
   & $action
   if ($LASTEXITCODE -eq 0) { return }
   Log "$name exit code: $LASTEXITCODE"
  } catch { Log "$name error: $($_.Exception.Message)" }
  if ($attempt -lt 2) { Start-Sleep -Seconds 2 }
 }
 throw "$name failed twice"
}
function Test-Http([string]$url) {
 try {
  $headers=@{}
  if ($env:YATSUMI_API_KEY) { $headers['x-api-key']=$env:YATSUMI_API_KEY }
  $r=Invoke-WebRequest -Uri $url -Headers $headers -UseBasicParsing -TimeoutSec 2
  return ($r.StatusCode -eq 200)
 } catch { return $false }
}
function Launch([string]$service,[string]$node) {
 $runner=Join-Path $root 'scripts\run-service.ps1'
 $escapedRoot=$root.Replace("'","''")
 $escapedRunner=$runner.Replace("'","''")
 $escapedNode=$node.Replace("'","''")
 $command="& '$escapedRunner' -ProjectRoot '$escapedRoot' -Service '$service' -NodePath '$escapedNode'"
 $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
 $powershell=Join-Path $PSHOME 'powershell.exe'
 $p=Start-Process -FilePath $powershell -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',$encoded) -WorkingDirectory $root -PassThru
 Log "$service PID=$($p.Id)"
 return $p
}
try {
 Log '=== Hakurei Yatsumi Windows setup ==='
 Log "Root: $root"
 Log "Windows: $([Environment]::OSVersion.VersionString); PowerShell: $($PSVersionTable.PSVersion)"
 Set-Location -LiteralPath $root
 foreach ($relative in @('backend\requirements.txt','frontend\package.json','scripts\run-service.ps1')) {
  if (-not (Test-Path -LiteralPath (Join-Path $root $relative))) { throw "Missing file: $relative" }
 }
 foreach ($port in @(8000,3000)) {
  $client=New-Object Net.Sockets.TcpClient
  try {
   $ar=$client.BeginConnect('127.0.0.1',$port,$null,$null)
   if ($ar.AsyncWaitHandle.WaitOne(500)) {
    try { $client.EndConnect($ar); throw "Port $port is already in use" }
    catch [Net.Sockets.SocketException] {}
   }
  } finally { $client.Close() }
 }
 $python=Find-Python
 if (-not $python) {
  Install-Dependency 'Python.Python.3.12' 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe' '.exe'
  $python=Find-Python
 }
 if (-not $python) { throw 'Python >=3.10 not detected. Restart Windows or install Python manually.' }
 Log "Python: $python"
 $node=Find-Node
 if (-not $node) {
  Install-Dependency 'OpenJS.NodeJS.LTS' 'https://nodejs.org/dist/v22.16.0/node-v22.16.0-x64.msi' '.msi'
  $node=Find-Node
 }
 if (-not $node) { throw 'Node >=20 not detected. Restart Windows or install Node manually.' }
 Log "Node: $node"
 $nodeDir=Split-Path -Parent $node
 $env:PATH="$nodeDir;$env:PATH"
 $npm=Join-Path $nodeDir 'npm.cmd'
 if (-not (Test-Path -LiteralPath $npm)) { throw 'npm.cmd missing next to node.exe' }
 $venv=Join-Path $root '.venv'
 $venvPython=Join-Path $venv 'Scripts\python.exe'
 $rebuild=-not (Test-Path -LiteralPath $venvPython)
 if (-not $rebuild) {
  try {
   $actual=@(& $venvPython -c 'import sys; print(sys.prefix)' 2>$null)
   $rebuild=$LASTEXITCODE -ne 0 -or $actual.Count -eq 0 -or -not ([IO.Path]::GetFullPath($actual[0]).TrimEnd('\') -ieq $venv.TrimEnd('\'))
  } catch { $rebuild=$true }
 }
 if ($rebuild) {
  if (Test-Path -LiteralPath $venv) { Log 'Recreating invalid/moved virtual environment'; Remove-Item -LiteralPath $venv -Recurse -Force }
  & $python -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw 'Python venv creation failed' }
 }
 Retry 'pip install' { & $venvPython -m pip install -r (Join-Path $root 'backend\requirements.txt') 2>&1 | ForEach-Object { Log ([string]$_) } }
 Push-Location -LiteralPath (Join-Path $root 'frontend')
 try { Retry 'npm install' { & $npm install --no-audit --no-fund 2>&1 | ForEach-Object { Log ([string]$_) } } }
 finally { Pop-Location }
 $keyFile=Join-Path $root '.yatsumi-api-key'
 if (-not (Test-Path -LiteralPath $keyFile)) {
  $bytes=New-Object byte[] 32
  $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  [IO.File]::WriteAllText($keyFile,[Convert]::ToBase64String($bytes),[Text.Encoding]::ASCII)
  Log 'Created local API key'
 }
 if (-not $env:YATSUMI_API_KEY) { $env:YATSUMI_API_KEY=[IO.File]::ReadAllText($keyFile).Trim() }
 if (-not $env:YATSUMI_API_KEY) { throw 'API key is empty' }
 $env:PYTHON_API_URL='http://127.0.0.1:8000'
 Log 'Applying SQLite migrations'
 & $venvPython -m backend.app.db 2>&1 | ForEach-Object { Log ([string]$_) }
 if ($LASTEXITCODE -ne 0) { throw 'SQLite migration failed' }
 $api=Launch 'python' $node
 $ready=$false
 for ($i=0;$i -lt 30;$i++) {
  if (Test-Http 'http://127.0.0.1:8000/health') { $ready=$true; break }
  if ($api.HasExited) { break }
  Start-Sleep -Seconds 1
 }
 if (-not $ready) { throw 'Python API not healthy after 30 seconds. See logs/python.log' }
 Log 'Python API healthy'
 $gateway=Launch 'node' $node
 $ready=$false
 for ($i=0;$i -lt 30;$i++) {
  if (Test-Http 'http://127.0.0.1:3000/api/health') { $ready=$true; break }
  if ($gateway.HasExited) { break }
  Start-Sleep -Seconds 1
 }
 if (-not $ready) { throw 'Node gateway not healthy after 30 seconds. See logs/node.log' }
 Log 'Node gateway healthy'
 Log 'SUCCESS: http://127.0.0.1:8000/docs'
 Start-Process 'http://127.0.0.1:8000/docs'
 exit 0
} catch {
 Log "ERROR: $($_.Exception.Message)"
 if ($gateway -and -not $gateway.HasExited) { Stop-Process -Id $gateway.Id -Force -ErrorAction SilentlyContinue }
 if ($api -and -not $api.HasExited) { Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue }
 Write-Host "See $logFile" -ForegroundColor Red
 exit 1
}
