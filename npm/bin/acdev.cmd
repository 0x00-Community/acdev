@echo off
setlocal
set "ACDE_CLI=%~dp0..\lib\acdev\dist\cli.js"
set "ACDE_CACHE=%~dp0..\lib\runtime-cache"
set "ACDE_BUN="
set "ACDE_NODE="
for /f "delims=" %%p in ('where bun.exe 2^>nul') do if not defined ACDE_BUN set "ACDE_BUN=%%p"
for /f "delims=" %%p in ('where node.exe 2^>nul') do if not defined ACDE_NODE set "ACDE_NODE=%%p"
set "ACDE_KEY=bun"
if defined ACDE_BUN for %%f in ("%ACDE_BUN%") do set "ACDE_KEY=bun?%%~ff?%%~tf?%%~zf"
if defined ACDE_NODE for %%f in ("%ACDE_NODE%") do set "ACDE_KEY=%ACDE_KEY%?node?%%~ff?%%~tf?%%~zf"
set "ACDE_CACHED_KEY="
set "ACDE_CHOSEN="
if exist "%ACDE_CACHE%" for /f "usebackq tokens=1,2 delims=*" %%a in ("%ACDE_CACHE%") do (
  set "ACDE_CACHED_KEY=%%a"
  set "ACDE_CHOSEN=%%b"
)
if not defined ACDE_CHOSEN goto probe
if not "%ACDE_CACHED_KEY%"=="%ACDE_KEY%" goto probe
if not exist "%ACDE_CHOSEN%" goto probe
"%ACDE_CHOSEN%" "%ACDE_CLI%" %*
exit /b %errorlevel%
:probe
if not defined ACDE_BUN goto node
"%ACDE_BUN%" -e "const [a,b]=process.versions.bun.split('.').map(Number);process.exit(a>1||(a===1&&b>=4)?0:1)" >nul 2>&1 || goto node
>"%ACDE_CACHE%" 2>nul echo %ACDE_KEY%*%ACDE_BUN%
"%ACDE_BUN%" "%ACDE_CLI%" %*
exit /b %errorlevel%
:node
if not defined ACDE_NODE goto old
"%ACDE_NODE%" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(!process.versions.bun&&(a>22||(a===22&&b>=3))?0:1)" >nul 2>&1 || goto old
>"%ACDE_CACHE%" 2>nul echo %ACDE_KEY%*%ACDE_NODE%
"%ACDE_NODE%" "%ACDE_CLI%" %*
exit /b %errorlevel%
:old
if defined ACDE_BUN goto oldbun
if defined ACDE_NODE goto oldnode
echo acdev: needs Bun 1.4+ or Node.js 22.3+ and there is neither on PATH: install one of them, Bun (https://bun.sh) or Node.js (https://nodejs.org) 1>&2
exit /b 1
:oldbun
for /f "delims=" %%v in ('call "%ACDE_BUN%" --version') do echo acdev: needs Bun 1.4 or newer, and the bun on PATH is %%v: update it (bun upgrade, or https://bun.sh) 1>&2
exit /b 1
:oldnode
for /f "delims=" %%v in ('call "%ACDE_NODE%" --version') do echo acdev: needs Node.js 22.3 or newer, and the node on PATH is %%v: update it (https://nodejs.org) 1>&2
exit /b 1
