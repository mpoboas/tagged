#!/bin/bash
# Arranque automático no macOS: um LaunchAgent que corre o tagged quando inicias sessão (e o relança se falhar).
# Uso: duplo clique, ou  ./scripts/autostart-install.command [--dry-run]
cd "$(dirname "$0")/.." || exit 1
REPO="$(pwd)"
LABEL="top.povoas.tagged"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/tagged.log"
xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
SCRIPT="$(printf '%s' "$REPO/start.command" | xml)"
LOGX="$(printf '%s' "$LOG" | xml)"
PLIST_TEXT=$(cat <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$SCRIPT</string></array>
  <key>EnvironmentVariables</key><dict><key>TAGGED_NO_BROWSER</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOGX</string>
  <key>StandardErrorPath</key><string>$LOGX</string>
</dict>
</plist>
PL
)
if [ "$1" = "--dry-run" ]; then printf '%s\n' "$PLIST_TEXT"; exit 0; fi
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
printf '%s\n' "$PLIST_TEXT" > "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
if launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
  echo "Instalado. O tagged arranca sozinho quando iniciares sessão e já está a arrancar agora."
  echo "Abre http://127.0.0.1:8768 · registo em $LOG"
  echo "Para remover: scripts/autostart-remove.command"
else
  echo "Não consegui carregar o LaunchAgent. O ficheiro ficou em $PLIST"; exit 1
fi
