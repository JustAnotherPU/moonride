#!/bin/sh
# mgu-deploy "check": the decoder binary loads (glibc/MSDK/libva resolve) and node22 parses the daemon; offline on purpose.
set -eu
d=$(cd "$(dirname "$0")" && pwd)
"$d/mgu-moonlight" --version
exec /var/opt/jap-node22/current/bin/node -e "require('$d/gs.js'); require('$d/png.js')"
