@echo off
setlocal EnableExtensions DisableDelayedExpansion
if not defined ACDE_DIST set "ACDE_DIST=http://localhost:8787"
if not defined ACDE_INSTALL set "ACDE_INSTALL=%USERPROFILE%\.acde"
set "VERSION=%ACDE_VERSION%"
set "MODIFY_PATH=1"

:args
if "%~1"=="" goto parsed
if /i "%~1"=="--version" (
  if "%~2"=="" goto usage
  set "VERSION=%~2"
  shift
  shift
  goto args
)
if /i "%~1"=="--no-modify-path" (
  set "MODIFY_PATH="
  shift
  goto args
)
:usage
echo usage: install.cmd [--version X.Y.Z] [--no-modify-path] 1>&2
exit /b 2

:parsed
set "ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "ARCH=%PROCESSOR_ARCHITEW6432%"
if /i "%ARCH%"=="AMD64" (set "TRIPLE=x86_64-pc-windows-msvc") else (
  echo acde: there is no Windows build for %ARCH% yet, only x64 1>&2
  exit /b 1
)
where curl >nul 2>nul || (echo acde: needs curl.exe, which Windows 10 1803+ ships 1>&2 & exit /b 1)
where tar >nul 2>nul || (echo acde: needs tar.exe, which Windows 10 1803+ ships 1>&2 & exit /b 1)

set "WORK=%TEMP%\acde-install-%RANDOM%%RANDOM%"
mkdir "%WORK%" || exit /b 1

if not defined VERSION (
  curl -fsSL -o "%WORK%\latest" "%ACDE_DIST%/latest" || (echo acde: could not read %ACDE_DIST%/latest 1>&2 & goto fail)
  set /p VERSION=<"%WORK%\latest"
)
for /f "tokens=* delims= " %%v in ("%VERSION%") do set "VERSION=%%v"
set "NAME=acde-%VERSION%-%TRIPLE%"
echo acde: installing %NAME% from %ACDE_DIST%
curl -fsSL -o "%WORK%\%NAME%.tar.gz" "%ACDE_DIST%/%VERSION%/%NAME%.tar.gz" || (echo acde: could not download %ACDE_DIST%/%VERSION%/%NAME%.tar.gz 1>&2 & goto fail)
curl -fsSL -o "%WORK%\SHA256SUMS" "%ACDE_DIST%/%VERSION%/SHA256SUMS" || (echo acde: could not download %ACDE_DIST%/%VERSION%/SHA256SUMS 1>&2 & goto fail)

set "WANT="
for /f "tokens=1,2" %%a in ('findstr /e /c:"  %NAME%.tar.gz" "%WORK%\SHA256SUMS"') do set "WANT=%%a"
if not defined WANT (echo acde: %NAME%.tar.gz is not in SHA256SUMS 1>&2 & goto fail)
set "GOT="
for /f "skip=1 delims=" %%h in ('certutil -hashfile "%WORK%\%NAME%.tar.gz" SHA256') do if not defined GOT set "GOT=%%h"
set "GOT=%GOT: =%"
if /i not "%GOT%"=="%WANT%" (echo acde: checksum mismatch for %NAME%.tar.gz: expected %WANT%, got %GOT% 1>&2 & goto fail)

mkdir "%WORK%\x" || goto fail
tar -xzf "%WORK%\%NAME%.tar.gz" -C "%WORK%\x" || (echo acde: could not unpack %NAME%.tar.gz 1>&2 & goto fail)
if not exist "%ACDE_INSTALL%\versions" mkdir "%ACDE_INSTALL%\versions" || goto fail
if exist "%ACDE_INSTALL%\versions\%VERSION%" rd /s /q "%ACDE_INSTALL%\versions\%VERSION%"
move "%WORK%\x\%NAME%" "%ACDE_INSTALL%\versions\%VERSION%" >nul || (echo acde: could not move it into %ACDE_INSTALL%\versions 1>&2 & goto fail)
if exist "%ACDE_INSTALL%\current" rmdir "%ACDE_INSTALL%\current"
mklink /J "%ACDE_INSTALL%\current" "%ACDE_INSTALL%\versions\%VERSION%" >nul || (echo acde: could not link %ACDE_INSTALL%\current 1>&2 & goto fail)
rd /s /q "%WORK%"

set "BIN=%ACDE_INSTALL%\current\bin"
if not defined MODIFY_PATH goto done
set "USERPATH="
for /f "skip=2 tokens=2,*" %%a in ('reg query HKCU\Environment /v Path 2^>nul') do set "USERPATH=%%b"
echo ;%USERPATH%; | find /i ";%BIN%;" >nul && goto done
if defined USERPATH (set "NEWPATH=%USERPATH%;%BIN%") else (set "NEWPATH=%BIN%")
reg add HKCU\Environment /v Path /t REG_EXPAND_SZ /d "%NEWPATH%" /f >nul || (echo acde: could not add %BIN% to your PATH 1>&2 & exit /b 1)
setx ACDE_INSTALL "%ACDE_INSTALL%" >nul
echo acde: added %BIN% to your user PATH; open a new terminal to use it

:done
echo acde: installed acde and acdert %VERSION% into %ACDE_INSTALL%
echo   acde new my-app    starts a project with your Bun or Node.js (npm, pnpm, yarn)
exit /b 0

:fail
rd /s /q "%WORK%" 2>nul
exit /b 1
