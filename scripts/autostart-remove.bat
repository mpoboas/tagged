@echo off
rem Remove o arranque automatico do tagged no Windows. Nao apaga nada do projeto.
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\tagged.vbs" 2>nul
del "%LOCALAPPDATA%\tagged\autostart.cmd" 2>nul
echo Arranque automatico removido. Se o tagged estiver a correr, termina-o no Gestor de Tarefas ou reinicia o PC.
