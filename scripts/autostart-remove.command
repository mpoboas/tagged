#!/bin/bash
# Remove o arranque automático do tagged no macOS (não apaga nada do projeto).
LABEL="top.povoas.tagged"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
rm -f "$PLIST"
echo "Arranque automático removido."
