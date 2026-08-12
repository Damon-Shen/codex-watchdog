@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Codex Desktop input.im Gate Policy

set "NODE_EXE=node.exe"
set "MENU_SCRIPT=%~dp0src\desktop-policy-menu.mjs"

"%NODE_EXE%" "%MENU_SCRIPT%"
if errorlevel 1 (
  echo.
  echo Policy was not changed.
) else (
  echo.
  echo Policy saved and applied to new requests immediately.
)
echo.
pause
