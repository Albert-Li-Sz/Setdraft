#!/bin/sh
set -eu
ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
COMMAND=${1:-help}
[ "$#" -eq 0 ] || shift
case "$COMMAND" in
  help|--help|-h)
    echo 'Setdraft: ./install.sh [--network cn|global] [--public-origin URL] [--docker-registry HOST]'
    echo './upgrade.sh | ./uninstall.sh (保留数据和镜像)'
    echo './scripts/setdraft-compose.sh start|stop|status|logs|account|backup|restore'
    echo 'backup/restore <宿主机目录>；account setup-code|reset-password <用户名>'
    echo '原生开发安装：./install.sh --native --mode dev'
    exit 0;;
  install|upgrade|uninstall|start|stop|status|logs|account|backup|restore) ;;
  *) echo "未知命令：$COMMAND" >&2; exit 1;;
esac
for arg in "$@"; do
  if [ "$arg" = '--help' ]; then exec "$ROOT/scripts/setdraft-compose.sh" help; fi
  if [ "$arg" = '--dry-run' ]; then
    echo "Setdraft Docker Compose: $COMMAND；默认 0.0.0.0:4321，不安装反向代理。"
    echo '配置写入 .env / .env.compose；构建 web 与 sandbox 镜像，持久化全部账号数据。'
    echo '不会更改任何文件、容器或数据。原生安装请使用 --native。'
    exit 0
  fi
done
command -v docker >/dev/null 2>&1 || { echo '请先安装 Docker Engine 和 Docker Compose 插件（国内可使用可信镜像源）。' >&2; exit 1; }
docker compose version >/dev/null
docker info >/dev/null
compose() { docker compose --env-file "$ROOT/.env.compose" -f "$ROOT/compose.yaml" "$@"; }
if [ "$COMMAND" = upgrade ]; then
  [ "$(git branch --show-current)" = main ] || { echo '只能升级 main 分支。' >&2; exit 1; }
  [ -z "$(git status --porcelain --untracked-files=normal)" ] || { echo '请先处理未提交改动，升级不会覆盖它们。' >&2; exit 1; }
  git fetch origin main
  git merge --ff-only FETCH_HEAD
  exec "$ROOT/scripts/setdraft-compose.sh" install "$@"
fi
if [ "$COMMAND" = install ]; then
  if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
    node scripts/compose-config.mjs "$@"
  else
    BOOTSTRAP_IMAGE=${SETDRAFT_NODE_IMAGE:-node:24.18.0-bookworm-slim}
    NEXT_REGISTRY=no
    for arg in "$@"; do
      if [ "$NEXT_REGISTRY" = yes ]; then BOOTSTRAP_IMAGE="$arg/library/node:24.18.0-bookworm-slim"; NEXT_REGISTRY=no; fi
      [ "$arg" != --docker-registry ] || NEXT_REGISTRY=yes
    done
    echo "使用 $BOOTSTRAP_IMAGE 生成配置；无需在宿主机安装 Node.js。"
    docker run --rm --user "$(id -u):$(id -g)" -v "$ROOT:$ROOT" -w "$ROOT" \
      -e SETDRAFT_WORKSPACE_ROOT -e SETDRAFT_PORT -e SETDRAFT_HOST -e SETDRAFT_PUBLIC_ORIGIN \
      -e SETDRAFT_NETWORK -e SETDRAFT_NPM_REGISTRY -e SETDRAFT_DOCKER_REGISTRY -e SETDRAFT_DEBIAN_MIRROR \
      -e SETDRAFT_DOWNLOAD_PROXY -e SETDRAFT_NODE_IMAGE -e SETDRAFT_DOCKER_CLI_IMAGE \
      -e SETDRAFT_POSTGRES_IMAGE -e SETDRAFT_SEARCH_IMAGE -e SETDRAFT_DB_ADMIN_PASSWORD -e SETDRAFT_DB_APP_PASSWORD -e SETDRAFT_SEARCH_SECRET \
      "$BOOTSTRAP_IMAGE" node scripts/compose-config.mjs "$@"
  fi
  compose build web sandbox maintenance
  compose stop web
  compose up -d --wait --wait-timeout 120 web
  compose logs --tail 15 web
  exit 0
fi
[ -f "$ROOT/.env.compose" ] || { echo '请先运行 ./install.sh 生成 Compose 配置。' >&2; exit 1; }
case "$COMMAND" in
  start) [ "$#" -eq 0 ]; compose up -d --wait --wait-timeout 120 web;;
  stop) [ "$#" -eq 0 ]; compose stop web;;
  status) [ "$#" -eq 0 ]; compose ps;;
  logs) compose logs --tail 100 "$@" web;;
  uninstall) [ "$#" -eq 0 ]; compose down; echo '已停止并移除容器，数据、配置和镜像保留。';;
  account) compose exec web node packages/hydro-server/dist/account-cli.js "$@";;
  backup|restore)
    [ "$#" -eq 1 ] || { echo '需要备份目录参数。' >&2; exit 1; }
    DEST_PARENT=$(CDPATH= cd "$(dirname "$1")" && pwd)
    DEST_NAME=$(basename "$1")
    case "$DEST_NAME" in .|..|'') echo '请选择有效目录。' >&2; exit 1;; esac
    DATA_PATH=$(sed -n "s/^SETDRAFT_DATA_PATH='\(.*\)'$/\1/p" "$ROOT/.env.compose")
    [ -n "$DATA_PATH" ] || { echo '数据目录配置缺失。' >&2; exit 1; }
    DEST_PATH="$DEST_PARENT/$DEST_NAME"
    case "$DEST_PATH/" in "$DATA_PATH/"*) echo '备份目录不能在数据目录内。' >&2; exit 1;; esac
    case "$DATA_PATH/" in "$DEST_PATH/"*) echo '备份目录不能包含数据目录。' >&2; exit 1;; esac
    compose stop web
    compose run --rm --no-deps -v "$DEST_PARENT:/backup" maintenance "$COMMAND" "/backup/$DEST_NAME"
    echo '维护完成；运行 ./scripts/setdraft-compose.sh start 启动服务。';;
esac
