@echo off
rem tagged: arranca a webapp neste PC Windows (duplo clique em start.bat).
rem   set TAGGED_PORT=9000      porta (por defeito 8768)
rem   start.bat nobrowser       nao abrir o browser (usado pelo arranque automatico)
setlocal
cd /d "%~dp0"
if "%TAGGED_PORT%"=="" set "TAGGED_PORT=8768"
set "URL=http://127.0.0.1:%TAGGED_PORT%"
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
set "NOBROWSER=%TAGGED_NO_BROWSER%"
if /i "%~1"=="nobrowser" set "NOBROWSER=1"

curl.exe -sf "%URL%/api/ping" >nul 2>&1
if not errorlevel 1 (
  if not defined NOBROWSER start "" "%URL%"
  echo.
  echo   O tagged ja esta a correr em %URL%
  if not defined NOBROWSER (
    echo   Abri o browser. Para PARAR esse servidor, fecha a janela onde ele corre.
    pause
  )
  exit /b 0
)

where uv >nul 2>&1
if errorlevel 1 (
  echo O "uv" - gestor de Python - nao esta instalado.
  choice /m "Instalar agora a partir de astral.sh/uv"
  if errorlevel 2 exit /b 1
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
  set "PATH=%USERPROFILE%\.local\bin;%PATH%"
)

cd backend
echo A preparar as dependencias - a primeira vez demora uns minutos...
uv sync
if errorlevel 1 goto fallback

if not defined NOBROWSER call :openwhenready
cls
echo.
echo   +----------------------------------------------------------+
echo   ^|  tagged esta a correr em %URL%
echo   ^|
echo   ^|  Prime Ctrl+C para PARAR o servidor, ou fecha esta janela.
echo   +----------------------------------------------------------+
echo.
".venv\Scripts\tagged.exe" serve --port %TAGGED_PORT%
echo.
echo   O servidor parou.
if not defined NOBROWSER pause
exit /b 0

:fallback
echo.
echo Nao consegui instalar as dependencias nativas. No Windows o InsightFace precisa do
echo "Microsoft C++ Build Tools" para compilar uma extensao.
where docker >nul 2>&1
if errorlevel 1 (
  echo.
  echo Alternativa sem compilador: instalar o Docker Desktop e voltar a correr este ficheiro.
  pause
  exit /b 1
)
echo A usar o Docker em vez disso - os modelos descarregam na primeira vez, cerca de 280 MB...
cd /d "%~dp0"
docker compose up -d
if errorlevel 1 (
  echo O Docker nao arrancou. Confirma que o Docker Desktop esta aberto.
  pause
  exit /b 1
)
set "URL=http://127.0.0.1:8768"
if not defined NOBROWSER call :openwhenready
echo tagged a correr em %URL% via Docker. Para parar: docker compose down
exit /b 0

:openwhenready
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 180;$i++){try{Invoke-WebRequest -UseBasicParsing '%URL%/api/ping'|Out-Null;Start-Process '%URL%';break}catch{Start-Sleep 1}}"
exit /b 0
