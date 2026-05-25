#!/bin/bash
# Chrome Hearts Miami – Appointment Monitor Launcher
# Double-click this file (or run it) to start monitoring

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "Starting Chrome Hearts Miami appointment monitor..."
echo "Press Ctrl+C to stop."
echo ""

node monitor.js
