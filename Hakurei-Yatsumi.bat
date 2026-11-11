@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "YATSUMI_ROOT=%~dp0"
set "YATSUMI_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%YATSUMI_PS%" (
 echo ERROR: Windows PowerShell 5.1 required.
 pause
 exit /b 1
)
"%YATSUMI_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%YATSUMI_ROOT%scripts\setup-and-start.ps1" -ProjectRoot "%YATSUMI_ROOT%"
set "YATSUMI_EXIT=%ERRORLEVEL%"
if not "%YATSUMI_EXIT%"=="0" (
 echo Setup failed. See logs\startup.log
 pause
)
exit /b %YATSUMI_EXIT%
