@echo off
setlocal
set "ROOT=%~dp0"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (echo 找不到 C# 编译器& pause& exit /b 1)
"%CSC%" /nologo /target:winexe /platform:x64 /out:"%ROOT%CodexWatchdog.exe" /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll "%ROOT%desktop-manager.cs"
if errorlevel 1 (echo 编译失败& pause& exit /b 1)
echo 已生成 %ROOT%CodexWatchdog.exe
pause
