@echo off
setlocal EnableExtensions
title ModelDock

if /I "%~1"=="--help" goto :help

set "MODELDOCK_VERSION=11.19.0"
set "MODELDOCK_TARGET=%LOCALAPPDATA%\ModelDock\app"
set "MODELDOCK_APP=%~dp0"

echo.
echo  ModelDock
echo  Preparazione del server AI locale...
echo.

if exist "%MODELDOCK_APP%package.json" goto :app_ready

set "MODELDOCK_APP=%MODELDOCK_TARGET%"
if exist "%MODELDOCK_APP%package.json" goto :app_ready

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo PowerShell non e disponibile. Impossibile scaricare ModelDock.
  goto :failed
)

echo [1/4] Download di ModelDock...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$target=$env:LOCALAPPDATA+'\ModelDock\app'; $temp=Join-Path $env:TEMP ('modeldock-'+[guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Force -Path $target,$temp ^| Out-Null; $zip=Join-Path $temp 'modeldock.zip'; Invoke-WebRequest 'https://github.com/flowente/modeldock/archive/refs/heads/main.zip' -OutFile $zip; Expand-Archive -LiteralPath $zip -DestinationPath $temp -Force; Copy-Item -Path (Join-Path $temp 'modeldock-main\*') -Destination $target -Recurse -Force; Remove-Item -LiteralPath $temp -Recurse -Force"
if errorlevel 1 (
  echo Il download di ModelDock non e riuscito.
  goto :failed
)

:app_ready
cd /d "%MODELDOCK_APP%"

where node.exe >nul 2>nul
if errorlevel 1 goto :install_node

for /f "usebackq delims=" %%V in (`node -p "Number(process.versions.node.split('.')[0])"`) do set "MODELDOCK_NODE_MAJOR=%%V"
if not defined MODELDOCK_NODE_MAJOR goto :install_node
if %MODELDOCK_NODE_MAJOR% LSS 24 goto :install_node
goto :node_ready

:install_node
where winget.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 o successivo e necessario.
  start "" "https://nodejs.org/en/download"
  echo Installa Node.js, poi avvia di nuovo questo file.
  goto :failed
)

echo [2/4] Installazione di Node.js...
winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js e stato installato. Riavvia questo file per continuare.
  goto :failed
)

:node_ready
echo [3/4] Installazione delle dipendenze di ModelDock...
call npx.exe --yes pnpm@%MODELDOCK_VERSION% install --frozen-lockfile
if errorlevel 1 (
  echo L'installazione delle dipendenze non e riuscita.
  goto :failed
)

if not exist ".env" copy /Y ".env.example" ".env" >nul

echo [4/4] Avvio di ModelDock...
echo La pagina di benvenuto si aprira automaticamente.
echo Chiudi questa finestra per arrestare ModelDock.
echo.

start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "$url='http://127.0.0.1:5173/#welcome'; for($i=0;$i -lt 120;$i++){ try { Invoke-WebRequest 'http://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 2 ^| Out-Null; Start-Process $url; exit 0 } catch {}; Start-Sleep -Seconds 1 }"
call npx.exe --yes pnpm@%MODELDOCK_VERSION% dev
exit /b %errorlevel%

:help
echo Avvia ModelDock con un doppio clic.
echo.
echo Se il file si trova nella repository, usa quella cartella.
echo Se e stato scaricato da solo, scarica ModelDock in %%LOCALAPPDATA%%\ModelDock\app.
echo Installa le dipendenze, crea .env, avvia i servizi e apre la welcome page.
exit /b 0

:failed
echo.
pause
exit /b 1
