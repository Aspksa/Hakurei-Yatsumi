@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "YATSUMI_ROOT=%~dp0"
set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" goto no_powershell
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%YATSUMI_ROOT%scripts\setup-and-start.ps1" -ProjectRoot "%YATSUMI_ROOT%"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" pause
exit /b %RESULT%
:no_powershell
echo ERROR: Windows PowerShell 5.1 is required.
pause
exit /b 1
