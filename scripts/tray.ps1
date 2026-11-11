param([Parameter(Mandatory=$true)][string]$ProjectRoot)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($ProjectRoot)
$state = Join-Path $root 'logs\tray.json'
$stopScript = Join-Path $root 'scripts\stop.ps1'
$powershell = Join-Path $PSHOME 'powershell.exe'
$rootArgument = Join-Path $root '.'
$url = 'http://127.0.0.1:3000/'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$context = New-Object System.Windows.Forms.ApplicationContext
$icon = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$timer = New-Object System.Windows.Forms.Timer
$openItem = $menu.Items.Add('Открыть чат Яцуми')
$stopItem = $menu.Items.Add('Завершить работу Яцуми')
$script:stopProcess = $null

function Open-Chat {
    if ($script:stopProcess) { return }
    try { Start-Process $url }
    catch {
        $icon.ShowBalloonTip(5000, 'Яцуми', "Откройте $url в браузере.", 'Warning')
    }
}

$openItem.add_Click({ Open-Chat })
$icon.add_MouseClick({
    param($sender, $eventArgs)
    if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Chat }
})
$stopItem.add_Click({
    if ($script:stopProcess) { return }
    try {
        $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$stopScript`" -ProjectRoot `"$rootArgument`""
        $script:stopProcess = Start-Process -FilePath $powershell -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
        $openItem.Enabled = $false
        $stopItem.Enabled = $false
    } catch {
        $icon.ShowBalloonTip(5000, 'Яцуми', 'Не удалось остановить приложение. Попробуйте ещё раз.', 'Warning')
    }
})

$timer.Interval = 1000
$timer.add_Tick({
    if (-not (Test-Path -LiteralPath $state)) {
        $context.ExitThread()
        return
    }
    try {
        $owner = Get-Content -LiteralPath $state -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($owner.pid -ne $PID) {
            $context.ExitThread()
            return
        }
    } catch { }
    if ($script:stopProcess -and $script:stopProcess.HasExited) {
        $script:stopProcess.Dispose()
        $script:stopProcess = $null
        $openItem.Enabled = $true
        $stopItem.Enabled = $true
        $icon.ShowBalloonTip(5000, 'Яцуми', 'Не удалось остановить приложение. Попробуйте ещё раз.', 'Warning')
    }
})

try {
    $icon.Icon = [System.Drawing.SystemIcons]::Application
    $icon.Text = 'Хакурэй Яцуми'
    $icon.ContextMenuStrip = $menu
    $icon.Visible = $true

    $process = Get-Process -Id $PID
    $owner = @{
        pid = $process.Id
        path = $process.Path
        startTicks = [string]$process.StartTime.ToUniversalTime().Ticks
    }
    [IO.File]::WriteAllText($state, ($owner | ConvertTo-Json), [Text.Encoding]::UTF8)
    $timer.Start()
    [System.Windows.Forms.Application]::Run($context)
} finally {
    $timer.Dispose()
    $icon.Visible = $false
    $icon.Dispose()
    $menu.Dispose()
    $context.Dispose()
    if ($script:stopProcess) { $script:stopProcess.Dispose() }
}
