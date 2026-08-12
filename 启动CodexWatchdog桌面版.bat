@echo off
setlocal
set "ROOT=%~dp0"
if not exist "%ROOT%CodexWatchdog.exe" (
  echo 未找到 CodexWatchdog.exe，请先双击“构建CodexWatchdog桌面版.bat”。
  pause
  exit /b 1
)
start "Codex Watchdog" "%ROOT%CodexWatchdog.exe"
