@echo off
setlocal
set "ACDE_CLI=%~dp0..\lib\acde\src\cli.js"
for /f "delims=" %%p in ('where bun.exe 2^>nul') do (set "ACDE_RT=%%p" & goto bun)
for /f "delims=" %%p in ('where node.exe 2^>nul') do (set "ACDE_RT=%%p" & goto node)
echo acde: needs Bun or Node.js 22.3+ and there is neither on PATH: install Bun (https://bun.sh) or Node.js (https://nodejs.org) 1>&2
exit /b 1
:bun
"%ACDE_RT%" "%ACDE_CLI%" %*
exit /b %errorlevel%
:node
"%ACDE_RT%" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=3)?0:1)" || goto old
"%ACDE_RT%" "%ACDE_CLI%" %*
exit /b %errorlevel%
:old
for /f "delims=" %%v in ('call "%ACDE_RT%" --version') do echo acde: needs Node.js 22.3 or newer, and the node on PATH is %%v: install a newer Node.js (https://nodejs.org) or Bun (https://bun.sh) 1>&2
exit /b 1
