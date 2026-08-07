@echo off
node "%~dp0..\src\launcher.mjs" %*
exit /b %errorlevel%
