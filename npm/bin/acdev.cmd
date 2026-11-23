@echo off
setlocal
set "ACDEV_CLI=%~dp0..\lib\acdev\dist\cli.js"
set "ACDEV_CACHE=%~dp0..\lib\runtime-cache"
set "ACDEV_BUN="
set "ACDEV_NODE="
for /f "delims=" %%p in ('where bun.exe 2^>nul') do if not defined ACDEV_BUN set "ACDEV_BUN=%%p"
for /f "delims=" %%p in ('where node.exe 2^>nul') do if not defined ACDEV_NODE set "ACDEV_NODE=%%p"
set "ACDEV_KEY=bun"
if defined ACDEV_BUN for %%f in ("%ACDEV_BUN%") do set "ACDEV_KEY=bun?%%~ff?%%~tf?%%~zf"
if defined ACDEV_NODE for %%f in ("%ACDEV_NODE%") do set "ACDEV_KEY=%ACDEV_KEY%?node?%%~ff?%%~tf?%%~zf"
set "ACDEV_CACHED_KEY="
set "ACDEV_CHOSEN="
if exist "%ACDEV_CACHE%" for /f "usebackq tokens=1,2 delims=*" %%a in ("%ACDEV_CACHE%") do (
  set "ACDEV_CACHED_KEY=%%a"
  set "ACDEV_CHOSEN=%%b"
)
if not defined ACDEV_CHOSEN goto probe
if not "%ACDEV_CACHED_KEY%"=="%ACDEV_KEY%" goto probe
if not exist "%ACDEV_CHOSEN%" goto probe
endlocal & goto #_undefined_# 2>nul || title %COMSPEC% & "%ACDEV_CHOSEN%" "%ACDEV_CLI%" %*
:probe
if not defined ACDEV_BUN goto node
"%ACDEV_BUN%" -e "const [a,b]=process.versions.bun.split('.').map(Number);process.exit(a>1||(a===1&&b>=4)?0:1)" >nul 2>&1 || goto node
>"%ACDEV_CACHE%" 2>nul echo %ACDEV_KEY%*%ACDEV_BUN%
endlocal & goto #_undefined_# 2>nul || title %COMSPEC% & "%ACDEV_BUN%" "%ACDEV_CLI%" %*
:node
if not defined ACDEV_NODE goto old
"%ACDEV_NODE%" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(!process.versions.bun&&(a>22||(a===22&&b>=3))?0:1)" >nul 2>&1 || goto old
>"%ACDEV_CACHE%" 2>nul echo %ACDEV_KEY%*%ACDEV_NODE%
endlocal & goto #_undefined_# 2>nul || title %COMSPEC% & "%ACDEV_NODE%" "%ACDEV_CLI%" %*
:old
if defined ACDEV_BUN goto oldbun
if defined ACDEV_NODE goto oldnode
echo acdev: needs Bun 1.4+ or Node.js 22.3+ and there is neither on PATH: install one of them, Bun (https://bun.sh) or Node.js (https://nodejs.org) 1>&2
exit /b 1
:oldbun
for /f "delims=" %%v in ('call "%ACDEV_BUN%" --version') do echo acdev: needs Bun 1.4 or newer, and the bun on PATH is %%v: update it (bun upgrade, or https://bun.sh) 1>&2
exit /b 1
:oldnode
for /f "delims=" %%v in ('call "%ACDEV_NODE%" --version') do echo acdev: needs Node.js 22.3 or newer, and the node on PATH is %%v: update it (https://nodejs.org) 1>&2
exit /b 1
