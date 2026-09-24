#!/bin/sh
set -eu
if ! command -v node >/dev/null 2>&1; then
	echo "需要 Node.js 22.19 或更新版本。" >&2
	exit 1
fi
ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
exec node "$ROOT/scripts/hydro-local.mjs" upgrade "$@"
