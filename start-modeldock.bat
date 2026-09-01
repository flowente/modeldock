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

for /f "tokens=1 delims=." %%V in ('node.exe --version') do if "%%V"=="v24" goto :node_ready
goto :portable_node

:portable_node
set "MODELDOCK_NODE=%MODELDOCK_RUNTIME%\node.exe"
set "MODELDOCK_NPX=%MODELDOCK_RUNTIME%\npx.cmd"
if exist "%MODELDOCK_NODE%" (
  set "PATH=%MODELDOCK_RUNTIME%;%PATH%"
  for /f "tokens=1 delims=." %%V in ('node.exe --version') do if "%%V"=="v24" goto :portable_node_ready
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

echo Creazione della versione stabile...
call "%MODELDOCK_NPX%" --yes pnpm@%MODELDOCK_VERSION% build
if errorlevel 1 (
  echo La compilazione di ModelDock non e riuscita.
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

start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "$url='http://127.0.0.1:4173/#welcome'; for($i=0;$i -lt 120;$i++){ try { $null=Invoke-WebRequest 'http://127.0.0.1:4173/' -UseBasicParsing -TimeoutSec 2; $null=Invoke-WebRequest 'http://127.0.0.1:4317/api/health' -UseBasicParsing -TimeoutSec 2; Start-Process $url; exit 0 } catch {}; Start-Sleep -Seconds 1 }"
call "%MODELDOCK_NPX%" --yes pnpm@%MODELDOCK_VERSION% start
exit /b %errorlevel%

:help
echo Avvia ModelDock con un doppio clic.
echo.
echo Se il file si trova nella repository, usa quella cartella.
echo Se e stato scaricato da solo, scarica ModelDock in %%LOCALAPPDATA%%\ModelDock\app.
echo Prepara un runtime locale, aggiorna l'app, crea la build stabile, avvia i servizi e apre la welcome page.
echo Usa --check per verificare il launcher senza avviare i server.
exit /b 0

:failed
echo.
pause
exit /b 1
