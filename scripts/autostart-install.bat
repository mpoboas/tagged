@echo off
rem Arranque automatico no Windows: ao iniciares sessao, corre o tagged escondido (sem janela, sem abrir o browser).
rem Nao precisa de administrador. Para remover: scripts\autostart-remove.bat
setlocal
set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "DATA=%LOCALAPPDATA%\tagged"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if not exist "%ROOT%\start.bat" (
  echo Nao encontro start.bat em %ROOT%
  exit /b 1
)
if not exist "%DATA%" mkdir "%DATA%"

> "%DATA%\autostart.cmd" echo @echo off
>> "%DATA%\autostart.cmd" echo call "%ROOT%\start.bat" nobrowser ^>^> "%DATA%\tagged.log" 2^>^&1

> "%STARTUP%\tagged.vbs" echo CreateObject("Wscript.Shell").Run """%DATA%\autostart.cmd""", 0, False

echo Instalado. O tagged vai arrancar sozinho quando iniciares sessao.
echo Registo em %DATA%\tagged.log
echo Para ja, a arrancar agora sem janela...
wscript "%STARTUP%\tagged.vbs"
echo Abre http://127.0.0.1:8768 dentro de uns instantes.
