#!/bin/sh
set -e
# Virtual display for headed Playwright (Waitwhile reCAPTCHA)
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
export DISPLAY=:99
# Wait until X is accepting connections
i=0
while [ $i -lt 50 ]; do
  if xdpyinfo -display :99 >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 0.1
done
exec node monitor-v2.js
