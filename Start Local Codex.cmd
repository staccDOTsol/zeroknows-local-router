@echo off
rem Close Codex first, then double-click this file (or run it from a terminal).
"C:\Users\User\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local-codex.ps1" %*
pause
