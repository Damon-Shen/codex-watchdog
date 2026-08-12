@echo off
setlocal EnableExtensions
title Codex Desktop Watchdog - SSE Retry Proxy

set "PROJECT_DIR=%~dp0"
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"
set "NODE_EXE=node.exe"
for /f "delims=" %%N in ('where node.exe 2^>nul') do if "%NODE_EXE%"=="node.exe" set "NODE_EXE=%%N"
set "PROXY_SCRIPT=%PROJECT_DIR%\src\desktop-proxy.mjs"
set "LOG_DIR=%PROJECT_DIR%\logs"
set "PROXY_LOG=%LOG_DIR%\desktop-proxy.log"
set "PROXY_STDOUT_LOG=%LOG_DIR%\desktop-proxy.stdout.log"
set "CONFIG_FILE=%PROJECT_DIR%\desktop-watchdog.config.bat"
set "NEW_API_STATUS=http://127.0.0.1:3000/api/status"
set "PROXY_HEALTH=http://127.0.0.1:3001/healthz"
set "PROXY_STATUS=http://127.0.0.1:3001/statusz"
set "POLICY_MENU=%PROJECT_DIR%\src\desktop-policy-menu.mjs"

set "CODEX_DESKTOP_STATUS_REFRESH_SECONDS=60"
if exist "%CONFIG_FILE%" call "%CONFIG_FILE%"

where "%NODE_EXE%" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found: %NODE_EXE%
  pause
  exit /b 1
)

if not exist "%PROXY_SCRIPT%" (
  echo [ERROR] Proxy script not found: %PROXY_SCRIPT%
  pause
  exit /b 1
)

call :check_proxy
if not errorlevel 1 goto already_running

call :check_new_api
if errorlevel 1 (
  echo.
  echo [ERROR] New API is not responding.
  echo Start the upstream service on http://127.0.0.1:3000 first.
  echo Then double-click this BAT again.
  echo.
  pause
  exit /b 1
)

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo [STATUS] Starting proxy in the background...
powershell.exe -NoProfile -Command "$p = Start-Process -FilePath '%NODE_EXE%' -ArgumentList @('%PROXY_SCRIPT%') -WorkingDirectory '%PROJECT_DIR%' -WindowStyle Hidden -RedirectStandardOutput '%PROXY_STDOUT_LOG%' -RedirectStandardError '%PROXY_LOG%' -PassThru; Write-Output $p.Id"
if errorlevel 1 goto start_failed

for /l %%I in (1,1,10) do (
  call :check_proxy
  if not errorlevel 1 goto already_running
  timeout /t 1 /nobreak >nul
)

:start_failed
cls
echo ============================================================
echo   Codex Desktop Watchdog failed to start
echo ============================================================
echo.
echo Error log: %PROXY_LOG%
echo.
if exist "%PROXY_LOG%" powershell.exe -NoProfile -Command "Get-Content -Tail 20 -LiteralPath '%PROXY_LOG%'"
echo.
pause
exit /b 1

:already_running
cls
call :proxy_pid
echo ============================================================
echo   Codex Desktop Watchdog is already running
echo ============================================================
echo.
echo Proxy URL : http://127.0.0.1:3001
echo Health    : OK
echo PID       : %PROXY_PID%
echo Error log : %PROXY_LOG%
echo Config    : %CONFIG_FILE%
echo.
echo The proxy runs in the background. Closing this window is always safe.
echo Press Q to close this status window. Status refreshes every %CODEX_DESKTOP_STATUS_REFRESH_SECONDS% seconds.
echo Press C to choose which conversations follow the model monitor.
echo ============================================================

:status_loop
call :print_status
choice /C RCQ /N /T %CODEX_DESKTOP_STATUS_REFRESH_SECONDS% /D R /M "Press C to configure, Q to exit, or wait to refresh: "
if errorlevel 3 exit /b 0
if errorlevel 2 goto configure_policy
call :check_proxy
if errorlevel 1 goto proxy_stopped
goto status_loop

:configure_policy
"%NODE_EXE%" "%POLICY_MENU%"
goto status_loop

:proxy_stopped
cls
echo [STATUS] The background proxy has stopped.
echo Double-click this BAT again to start it.
pause
exit /b 1

:check_new_api
powershell.exe -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%NEW_API_STATUS%' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
exit /b %ERRORLEVEL%

:check_proxy
powershell.exe -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%PROXY_HEALTH%' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
exit /b %ERRORLEVEL%

:proxy_pid
set "PROXY_PID=unknown"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3001" ^| findstr "LISTENING"') do set "PROXY_PID=%%P"
exit /b 0

:print_status
call :proxy_pid
powershell.exe -NoProfile -Command "$now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'; $proxy = 'DOWN'; $model = 'UNKNOWN'; try { $s = Invoke-RestMethod -Uri '%PROXY_STATUS%' -TimeoutSec 3; $proxy = 'OK'; if ($s.enabled) { $model = $s.state.ToUpperInvariant() } else { $model = 'DISABLED' } } catch {}; $newApi = 'DOWN'; try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%NEW_API_STATUS%' -TimeoutSec 3; if ($r.StatusCode -eq 200) { $newApi = 'OK' } } catch {}; Write-Host ('[' + $now + '] Proxy=' + $proxy + ' PID=%PROXY_PID% NewAPI=' + $newApi + ' Model=' + $model)"
exit /b 0
