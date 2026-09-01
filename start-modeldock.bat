@echo off
setlocal EnableExtensions EnableDelayedExpansion
title ModelDock

if /I "%~1"=="--help" goto :help
if /I "%~1"=="--check" set "MODELDOCK_CHECK_ONLY=1"

set "MODELDOCK_VERSION=11.19.0"
set "MODELDOCK_TARGET=%LOCALAPPDATA%\ModelDock\app"
set "MODELDOCK_RUNTIME=%LOCALAPPDATA%\ModelDock\runtime\node"
set "MODELDOCK_APP=%~dp0"
set "MODELDOCK_NODE=node.exe"
set "MODELDOCK_NPX=npx.exe"

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
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$target=$env:LOCALAPPDATA+'\ModelDock\app'; $temp=Join-Path $env:TEMP ('modeldock-'+[guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Force -Path $target,$temp | Out-Null; $zip=Join-Path $temp 'modeldock.zip'; Invoke-WebRequest 'https://github.com/flowente/modeldock/archive/refs/heads/main.zip' -OutFile $zip; Expand-Archive -LiteralPath $zip -DestinationPath $temp -Force; Copy-Item -Path (Join-Path $temp 'modeldock-main\*') -Destination $target -Recurse -Force; Remove-Item -LiteralPath $temp -Recurse -Force"
if errorlevel 1 (
  echo Il download di ModelDock non e riuscito.
  goto :failed
)

:app_ready
cd /d "%MODELDOCK_APP%"

where node.exe >nul 2>nul
if errorlevel 1 goto :portable_node

for /f "usebackq delims=" %%V in (`node -p "Number(process.versions.node.split('.')[0])"`) do set "MODELDOCK_NODE_MAJOR=%%V"
if not defined MODELDOCK_NODE_MAJOR goto :portable_node
if %MODELDOCK_NODE_MAJOR% LSS 24 goto :portable_node
goto :node_ready

:portable_node
set "MODELDOCK_NODE=%MODELDOCK_RUNTIME%\node.exe"
set "MODELDOCK_NPX=%MODELDOCK_RUNTIME%\npx.cmd"
if exist "%MODELDOCK_NODE%" (
  set "MODELDOCK_NODE_MAJOR="
  for /f "usebackq delims=" %%V in (`"%MODELDOCK_NODE%" -p "Number(process.versions.node.split('.')[0])"`) do set "MODELDOCK_NODE_MAJOR=%%V"
  if defined MODELDOCK_NODE_MAJOR if !MODELDOCK_NODE_MAJOR! GEQ 24 goto :portable_node_ready
)

echo [2/4] Preparazione del runtime locale...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$runtime=$env:LOCALAPPDATA+'\ModelDock\runtime\node'; $temp=Join-Path $env:TEMP ('modeldock-node-'+[guid]::NewGuid().ToString('N')); try { New-Item -ItemType Directory -Force -Path $temp | Out-Null; $arch=if($env:PROCESSOR_ARCHITECTURE -eq 'ARM64'){'arm64'}else{'x64'}; $sumFile=Join-Path $temp 'SHASUMS256.txt'; Invoke-WebRequest 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' -OutFile $sumFile; $suffix='-win-'+$arch+'.zip'; $line=Get-Content -LiteralPath $sumFile | Where-Object { $_.Trim().EndsWith($suffix) } | Select-Object -First 1; if(-not $line){throw 'Runtime Node.js compatibile non trovato.'}; $parts=$line.Trim() -split '\s+'; $expected=$parts[0].ToLowerInvariant(); $file=$parts[-1]; $archive=Join-Path $temp $file; Invoke-WebRequest ('https://nodejs.org/dist/latest-v24.x/'+$file) -OutFile $archive; $stream=[IO.File]::OpenRead($archive); try { $sha=[Security.Cryptography.SHA256]::Create(); $actual=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose() }; if($actual -ne $expected){throw 'Verifica del runtime Node.js non riuscita.'}; $extract=Join-Path $temp 'extract'; Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force; $source=Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1; if(-not $source){throw 'Archivio Node.js non valido.'}; if(Test-Path -LiteralPath $runtime){Remove-Item -LiteralPath $runtime -Recurse -Force}; New-Item -ItemType Directory -Force -Path (Split-Path -Parent $runtime) | Out-Null; Move-Item -LiteralPath $source.FullName -Destination $runtime } finally { if(Test-Path -LiteralPath $temp){Remove-Item -LiteralPath $temp -Recurse -Force} }"
if errorlevel 1 (
  echo Non e stato possibile preparare il runtime locale di ModelDock.
  goto :failed
)

:portable_node_ready
set "PATH=%MODELDOCK_RUNTIME%;%PATH%"

:node_ready
echo [3/4] Installazione delle dipendenze di ModelDock...
call "%MODELDOCK_NPX%" --yes pnpm@%MODELDOCK_VERSION% install --frozen-lockfile
if errorlevel 1 (
  echo L'installazione delle dipendenze non e riuscita.
  goto :failed
)

if not exist ".env" copy /Y ".env.example" ".env" >nul

if defined MODELDOCK_CHECK_ONLY (
  echo Launcher Windows verificato correttamente.
  exit /b 0
)

echo [4/4] Avvio di ModelDock...
echo La pagina di benvenuto si aprira automaticamente.
echo Chiudi questa finestra per arrestare ModelDock.
echo.

start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "$url='http://127.0.0.1:5173/#welcome'; for($i=0;$i -lt 120;$i++){ try { Invoke-WebRequest 'http://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 2 ^| Out-Null; Start-Process $url; exit 0 } catch {}; Start-Sleep -Seconds 1 }"
call "%MODELDOCK_NPX%" --yes pnpm@%MODELDOCK_VERSION% dev
exit /b %errorlevel%

:help
echo Avvia ModelDock con un doppio clic.
echo.
echo Se il file si trova nella repository, usa quella cartella.
echo Se e stato scaricato da solo, scarica ModelDock in %%LOCALAPPDATA%%\ModelDock\app.
echo Prepara un runtime locale, installa le dipendenze, crea .env, avvia i servizi e apre la welcome page.
echo Usa --check per verificare il launcher senza avviare i server.
exit /b 0

:failed
echo.
pause
exit /b 1
