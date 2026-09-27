#!/bin/sh
set -eu
: "${SETDRAFT_WORKSPACE_ROOT:?An absolute persistent workspace path is required}"
case "$SETDRAFT_WORKSPACE_ROOT" in /*) ;; *) echo 'Workspace path must be absolute.' >&2; exit 1;; esac
if [ -e "$SETDRAFT_WORKSPACE_ROOT/server.pid" ]; then
  echo '检测到原生服务的进程锁。请先运行原生备份/停止命令；确认旧进程已退出后再迁移到 Docker。' >&2
  exit 1
fi
mkdir -p "$SETDRAFT_WORKSPACE_ROOT/.tmp"
export TMPDIR="$SETDRAFT_WORKSPACE_ROOT/.tmp"
# Kernel lock survives PID namespace changes and is released even after a crash.
export SETDRAFT_CONTAINER_LOCKED=1
exec flock --nonblock --no-fork "$SETDRAFT_WORKSPACE_ROOT/.service.lock" "$@"
