@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Test Codex Desktop Watchdog

set "NODE_EXE=node.exe"
set "PROJECT_DIR=%~dp0"
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"

pushd "%PROJECT_DIR%"
echo Running desktop proxy syntax checks and offline tests...
echo.
"%NODE_EXE%" --check "src\desktop-proxy.mjs"
if errorlevel 1 goto failed
"%NODE_EXE%" --check "src\desktop-policy-menu.mjs"
if errorlevel 1 goto failed
"%NODE_EXE%" --test "test\desktop-thread-policy.test.mjs" "test\model-availability-monitor.test.mjs" "test\sse-retry-proxy.test.mjs" "test\desktop-gate.integration.test.mjs"
if errorlevel 1 goto failed

echo.
echo PASS: Desktop watchdog offline tests completed successfully.
popd
pause
exit /b 0

:failed
echo.
echo FAIL: Desktop watchdog was not started and Codex routing was not changed.
popd
pause
exit /b 1
