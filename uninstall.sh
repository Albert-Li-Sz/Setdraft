#!/bin/sh
set -eu
ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
if [ "${1:-}" = --native ]; then
  shift
  exec node "$ROOT/scripts/hydro-local.mjs" uninstall "$@"
fi
exec "$ROOT/scripts/setdraft-compose.sh" uninstall "$@"
