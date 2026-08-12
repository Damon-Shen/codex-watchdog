@echo off
rem Copy this file to desktop-watchdog.config.bat before changing local settings.

rem Set to 0 to disable model monitoring and request pausing.
set "CODEX_DESKTOP_MODEL_MONITOR_ENABLED=1"
set "CODEX_DESKTOP_MODEL_MONITOR_URL=https://status.input.im/api/status"
set "CODEX_DESKTOP_MODEL_MONITOR_MODEL=gpt-5.6-sol"
set "CODEX_DESKTOP_MODEL_MONITOR_INTERVAL_MS=60000"
set "CODEX_DESKTOP_MODEL_MONITOR_TIMEOUT_MS=5000"

rem Local proxy route. Codex Desktop connects to port 3001; New API listens on 3000.
set "CODEX_DESKTOP_PROXY_HOST=127.0.0.1"
set "CODEX_DESKTOP_PROXY_PORT=3001"
set "CODEX_DESKTOP_PROXY_UPSTREAM=http://127.0.0.1:3000"

rem Status window refresh interval in seconds.
set "CODEX_DESKTOP_STATUS_REFRESH_SECONDS=60"
