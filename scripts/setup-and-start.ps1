param(
 [Parameter(Mandatory=$true)][string]$ProjectRoot,
 [switch]$NoBrowser,
 [switch]$Offline,
 [switch]$Diagnostics,
 [switch]$NoWatchdog
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root=[IO.Path]::GetFullPath($ProjectRoot)
$logs=Join-Path $root 'logs'
$state=Join-Path $logs 'services.json'
$startup=Join-Path $logs 'startup.log'
$api=$null
$gateway=$null
function Log([string]$s) {
 $line="[$(Get-Date -Format o)] $s"
 Write-Host $line
 [IO.File]::AppendAllText($startup,$line+[Environment]::NewLine,[Text.Encoding]::UTF8)
}
function Rotate([string]$path) {
 if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 2097152) {
  $archive="$path.old"
  Move-Item -LiteralPath $path -Destination $archive -Force
 }
}
function Run([string]$label,[scriptblock]$work) {
 & $work
 $exit=$LASTEXITCODE
 if ($null -eq $exit -or $exit -ne 0) { throw "$label failed (exit $exit)" }
}
function Retry([string]$label,[scriptblock]$work) {
 for($i=1;$i -le 2;$i++) {
  try { Log "$label attempt $i"; Run $label $work; return }
  catch { Log $_.Exception.Message; if($i -eq 2){throw}; Start-Sleep -Seconds 2 }
 }
}
function Find-Python {
 $paths=New-Object 'System.Collections.Generic.List[string]'
 $py=Get-Command py.exe -ErrorAction SilentlyContinue
 if($py) { try { $v=@(& $py.Source -3 -c 'import sys; print(sys.executable)' 2>$null); if($LASTEXITCODE -eq 0 -and $v.Count){$paths.Add([string]$v[0])} }catch{} }
 foreach($name in @('python.exe','python3.exe')) { $c=Get-Command $name -ErrorAction SilentlyContinue; if($c){$paths.Add($c.Source)} }
 foreach($base in @($env:LOCALAPPDATA,$env:ProgramFiles,${env:ProgramFiles(x86)})) {
  if(-not $base){continue}
  foreach($pattern in @('Programs\Python\Python*\python.exe','Python*\python.exe')) {
   foreach($p in @(Get-ChildItem -Path (Join-Path $base $pattern) -ErrorAction SilentlyContinue)){$paths.Add($p.FullName)}
  }
 }
 foreach($p in @($paths|Select-Object -Unique)) {
  try {
   if(-not (Test-Path -LiteralPath $p)){continue}
   $v=@(& $p -c 'import sys; print("{}.{}.{}".format(*sys.version_info[:3]))' 2>$null)
   if($LASTEXITCODE -eq 0 -and $v.Count -and [version]$v[0] -ge [version]'3.10'){return $p}
  }catch{}
 }
 return $null
}
function Find-Node {
 $paths=New-Object 'System.Collections.Generic.List[string]'
 $c=Get-Command node.exe -ErrorAction SilentlyContinue
 if($c){$paths.Add($c.Source)}
 foreach($base in @($env:ProgramFiles,${env:ProgramFiles(x86)},$env:LOCALAPPDATA)) {
  if($base){$paths.Add((Join-Path $base 'nodejs\node.exe'));$paths.Add((Join-Path $base 'Programs\nodejs\node.exe'))}
 }
 foreach($p in @($paths|Select-Object -Unique)) {
  try {
   if(-not (Test-Path -LiteralPath $p)){continue}
   $v=@(& $p --version 2>$null)
   if($LASTEXITCODE -eq 0 -and $v.Count -and [version]([string]$v[0]).TrimStart('v') -ge [version]'20.0'){return $p}
  }catch{}
 }
 return $null
}
function Install-Dependency([string]$id,[string]$url,[string]$ext) {
 if($Offline){throw "Offline mode: $id missing. Install manually and retry."}
 $winget=Get-Command winget.exe -ErrorAction SilentlyContinue
 if($winget) {
  try {
   & $winget.Source install --id $id --exact --source winget --scope user --accept-source-agreements --accept-package-agreements --silent --disable-interactivity 2>&1 | ForEach-Object {Log ([string]$_)}
   if($LASTEXITCODE -eq 0){return}
   Log "winget exit code: $LASTEXITCODE"
  }catch{Log "winget: $($_.Exception.Message)"}
 }
 if(-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64'){throw 'Fallback installers require x64 Windows'}
 $file=Join-Path $env:TEMP ("yatsumi-"+[guid]::NewGuid().ToString('N')+$ext)
 try {
  [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
  if((Get-AuthenticodeSignature -LiteralPath $file).Status -ne 'Valid'){throw 'Installer signature invalid'}
  if($ext -eq '.exe'){$p=Start-Process -FilePath $file -ArgumentList @('/quiet','InstallAllUsers=0','PrependPath=1','Include_test=0') -Wait -PassThru}
  else{$p=Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i',('"'+$file+'"'),'/qn','/norestart') -Wait -PassThru}
  if($p.ExitCode -notin @(0,3010)){throw "Installer failed: $($p.ExitCode)"}
 }finally{Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue}
}
function Health([string]$url) {
 try {
  $r=Invoke-WebRequest -Uri $url -Headers @{'x-api-key'=$env:YATSUMI_API_KEY} -TimeoutSec 2 -UseBasicParsing
  return ($r.StatusCode -eq 200)
 }catch{return $false}
}
function Owned([object]$entry) {
 if(-not $entry -or -not $entry.pid -or -not $entry.started -or -not $entry.path){return $false}
 try {
  $p=Get-Process -Id ([int]$entry.pid) -ErrorAction Stop
  return ($p.Path -ieq [string]$entry.path -and [Math]::Abs(($p.StartTime.ToUniversalTime()-[datetime]::Parse([string]$entry.started).ToUniversalTime()).TotalSeconds) -lt 3)
 }catch{return $false}
}
function Stop-Owned([object]$entry) {
 if(Owned $entry){Stop-Process -Id ([int]$entry.pid) -Force -ErrorAction SilentlyContinue}
}
function Launch([string]$exe,[string]$arguments,[string]$directory,[string]$name) {
 Rotate (Join-Path $logs "$name.stdout.log")
 Rotate (Join-Path $logs "$name.stderr.log")
 $p=Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $directory -RedirectStandardOutput (Join-Path $logs "$name.stdout.log") -RedirectStandardError (Join-Path $logs "$name.stderr.log") -PassThru
 return @{pid=$p.Id;path=$exe;started=$p.StartTime.ToUniversalTime().ToString('o')}
}
function Wait-Health([string]$url,[object]$entry) {
 for($i=0;$i -lt 40;$i++) {
  if(Health $url){return}
  if(-not (Owned $entry)){throw "Service exited before ready: $url"}
  Start-Sleep -Seconds 1
 }
 throw "Service not healthy after 40 seconds: $url"
}
function Report([string]$errorText) {
 $report=Join-Path $logs 'diagnostics.txt'
 $lines=@("Hakurei Yatsumi v3 diagnostics","Time: $(Get-Date -Format o)","Windows: $([Environment]::OSVersion.VersionString)","PowerShell: $($PSVersionTable.PSVersion)","Architecture: $env:PROCESSOR_ARCHITECTURE","Root: $root","Error: $errorText","Ports: 8000, 3000","See startup.log and *.stderr.log")
 [IO.File]::WriteAllLines($report,$lines,[Text.Encoding]::UTF8)
}
try {
 [IO.Directory]::CreateDirectory($logs)|Out-Null
 Rotate $startup
 Log '=== Hakurei Yatsumi BAT v3 ==='
 if(-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core' -and [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){throw 'Windows required'}
 if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){throw 'Windows required'}
 Set-Location -LiteralPath $root
 foreach($f in @('backend\requirements.txt','frontend\package.json','scripts\watchdog.ps1','backend\app\db.py')) {
  if(-not (Test-Path -LiteralPath (Join-Path $root $f))){throw "Missing project file: $f"}
 }
 $probe=Join-Path $logs ('.write-'+[guid]::NewGuid().ToString('N'))
 [IO.File]::WriteAllText($probe,'ok');Remove-Item -LiteralPath $probe
 $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))
 if($drive.DriveType -eq [IO.DriveType]::Fixed -and $drive.AvailableFreeSpace -lt 536870912){throw 'At least 512 MB free disk space required'}
 if($drive.DriveType -eq [IO.DriveType]::Network){Log 'WARNING: network drive; latency and permissions may affect installation'}
 if($env:YATSUMI_OFFLINE -eq '1'){$Offline=$true}
 Log "Windows=$([Environment]::OSVersion.VersionString); architecture=$env:PROCESSOR_ARCHITECTURE; offline=$Offline"
 $keyFile=Join-Path $root '.yatsumi-api-key'
 if(-not (Test-Path -LiteralPath $keyFile)){
  $bytes=New-Object byte[] 32;$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
  try{$rng.GetBytes($bytes)}finally{$rng.Dispose()}
  [IO.File]::WriteAllText($keyFile,[Convert]::ToBase64String($bytes),[Text.Encoding]::ASCII)
 }
 if(-not $env:YATSUMI_API_KEY){$env:YATSUMI_API_KEY=[IO.File]::ReadAllText($keyFile).Trim()}
 if(-not $env:YATSUMI_API_KEY){throw 'API key is empty'}
 $env:PYTHON_API_URL='http://127.0.0.1:8000'
 if(Test-Path -LiteralPath $state) {
  try {
   $saved=Get-Content -LiteralPath $state -Raw -Encoding UTF8 | ConvertFrom-Json
   if((Owned $saved.python) -and (Owned $saved.node) -and (Health 'http://127.0.0.1:8000/health') -and (Health 'http://127.0.0.1:3000/api/health')){
    Log 'Already running; no duplicate services started'
    if(-not $NoBrowser){Start-Process 'http://127.0.0.1:3000/'}
    exit 0
   }
   Stop-Owned $saved.node;Stop-Owned $saved.python
   Log 'Stopped stale/partially started owned processes'
  }catch{Log "Stale state: $($_.Exception.Message)"}
  Remove-Item -LiteralPath $state -Force -ErrorAction SilentlyContinue
 }
 foreach($port in @(8000,3000)) {
  $client=New-Object Net.Sockets.TcpClient
  try {
   $async=$client.BeginConnect('127.0.0.1',$port,$null,$null)
   if($async.AsyncWaitHandle.WaitOne(500)){
    try{$client.EndConnect($async);throw "Port $port already in use by another process"}
    catch [Net.Sockets.SocketException]{}
   }
  }finally{$client.Close()}
 }
 if($Diagnostics){Log 'Preflight completed';Report 'Preflight only';exit 0}
 $python=Find-Python
 if(-not $python){Install-Dependency 'Python.Python.3.12' 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe' '.exe';$python=Find-Python}
 if(-not $python){throw 'Python >=3.10 missing after installation. Reopen terminal or install manually.'}
 $node=Find-Node
 if(-not $node){Install-Dependency 'OpenJS.NodeJS.LTS' 'https://nodejs.org/dist/v22.16.0/node-v22.16.0-x64.msi' '.msi';$node=Find-Node}
 if(-not $node){throw 'Node.js >=20 missing after installation. Reopen terminal or install manually.'}
 $nodeDir=Split-Path -Parent $node;$env:PATH="$nodeDir;$env:PATH"
 $npm=Join-Path $nodeDir 'npm.cmd'
 if(-not (Test-Path -LiteralPath $npm)){throw "npm.cmd missing: $npm"}
 Log "Python=$python; Node=$node; npm=$npm"
 $venv=Join-Path $root '.venv';$venvPython=Join-Path $venv 'Scripts\python.exe'
 $rebuild=-not (Test-Path -LiteralPath $venvPython)
 if(-not $rebuild){
  try{$v=@(& $venvPython -c 'import sys; print(sys.prefix)' 2>$null);$rebuild=($LASTEXITCODE -ne 0 -or $v.Count -eq 0 -or -not ([IO.Path]::GetFullPath($v[0]).TrimEnd('\') -ieq $venv.TrimEnd('\')))}catch{$rebuild=$true}
 }
 if($rebuild){
  if(Test-Path -LiteralPath $venv){Log 'Rebuilding invalid virtual environment';Remove-Item -LiteralPath $venv -Recurse -Force}
  Run 'venv creation' {& $python -m venv $venv}
 }
 if($Offline){
  Run 'offline Python dependency check' {& $venvPython -c 'import fastapi, uvicorn, httpx, pytest'}
  if(-not (Test-Path -LiteralPath (Join-Path $root 'frontend\node_modules\express'))){throw 'Offline: node_modules/express missing. Run online once.'}
 }else{
  Retry 'pip install' {& $venvPython -m pip install -r (Join-Path $root 'backend\requirements.txt') 2>&1 | ForEach-Object {Log ([string]$_)}}
  Push-Location -LiteralPath (Join-Path $root 'frontend')
  try{Retry 'npm install' {& $npm install --no-audit --no-fund 2>&1 | ForEach-Object {Log ([string]$_)}}}finally{Pop-Location}
 }
 Log 'Checking SQLite and creating online backup before migration'
 Run 'SQLite preflight' {& $venvPython -m backend.app.db --preflight}
 Log 'Applying SQLite migrations'
 Run 'SQLite migration' {& $venvPython -m backend.app.db}
 $api=Launch $venvPython '-m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000' $root 'python'
 Wait-Health 'http://127.0.0.1:8000/health' $api
 $gateway=Launch $node 'server.js' (Join-Path $root 'frontend') 'node'
 Wait-Health 'http://127.0.0.1:3000/api/health' $gateway
 @{python=$api;node=$gateway}|ConvertTo-Json -Depth 3|Set-Content -LiteralPath $state -Encoding UTF8
 if(-not $NoWatchdog) {
  $watchState=Join-Path $logs 'watchdog.json'
  $alive=$false
  if(Test-Path -LiteralPath $watchState){
   try{$previous=Get-Content -LiteralPath $watchState -Raw|ConvertFrom-Json;$alive=Owned $previous}catch{}
  }
  if(-not $alive){
   $watchScript=Join-Path $root 'scripts\watchdog.ps1'
   $powershell=Join-Path $PSHOME 'powershell.exe'
   $watch=Start-Process -FilePath $powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$watchScript+'"'),'-ProjectRoot',('"'+$root+'"')) -WorkingDirectory $root -WindowStyle Hidden -PassThru
   @{pid=$watch.Id;path=$powershell;started=$watch.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $watchState -Encoding UTF8
  }
 }
 Log 'SUCCESS: API and Node gateway healthy'
 if(-not $NoBrowser){Start-Process 'http://127.0.0.1:3000/'}
 exit 0
}catch{
 $message=$_.Exception.Message
 try{Log "ERROR: $message";Report $message}catch{Write-Host "ERROR: $message" -ForegroundColor Red}
 if($gateway){Stop-Owned $gateway}
 if($api){Stop-Owned $api}
 Remove-Item -LiteralPath $state -Force -ErrorAction SilentlyContinue
 exit 1
}
