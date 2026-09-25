#!/bin/sh
set -eu
ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
command -v node >/dev/null 2>&1 || { echo "需要 Node.js 22.19 或更新版本。" >&2; exit 1; }
exec node "$ROOT/scripts/hydro-local.mjs" install "$@"
