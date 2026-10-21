@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem No installation, execution-policy change, credentials, or model execution.
set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%NODE_EXE%" goto node_found
set "NODE_EXE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE (
  echo Node.js 24 or later was not found. No download or installation was attempted. 1>&2
  exit /b 1
)
:node_found
"%NODE_EXE%" -e "if(Number(process.versions.node.split('.')[0])>=24)process.exit(0);process.exit(1)"
if errorlevel 1 (
  echo This downloader requires Node.js 24 or later. Nothing was downloaded. 1>&2
  exit /b 1
)
if "%~1"=="" goto help
if /i "%~1"=="--help" goto help
set "MANIFEST=%~dp0manifests\staccs-lecore-gguf.json"
for %%A in (%*) do if /i "%%~A"=="--conversion-staging" set "MANIFEST=%~dp0manifests\staccs-lecore-conversion-staging.json"
"%NODE_EXE%" "%~dp0download-models.mjs" --manifest "%MANIFEST%" %*
exit /b %errorlevel%
:help
echo Read-only plan, no download:
echo   download-models.cmd --dest "D:\Models\staccs"
echo Reuse matching existing weights without moving or changing them:
echo   download-models.cmd --dest "D:\Models\staccs" --existing-dir "D:\Models"
echo Explicit download after reviewing the plan:
echo   download-models.cmd --dest "D:\Models\staccs" --existing-dir "D:\Models" --download
echo Separate conversion-only assets: add --conversion-staging and choose a separate --dest.
echo Options: --reserve-gib 32, --concurrency 1, --idle-timeout-seconds 60, --total-timeout-hours 24
exit /b 0
