#!/bin/sh
set -eu
ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
COMMAND=${1:-help}
[ "$#" -eq 0 ] || shift
case "$COMMAND" in
  help|--help|-h)
    echo 'Setdraft: ./install.sh [--network cn|global] [--public-origin URL] [--docker-registry HOST]'
    echo '默认拉取官方镜像；--build 使用本地源码构建，--prebuilt 切回官方镜像。'
    echo './install.sh 默认清空数据库和用户文件；--keep-data 保留数据重新部署。'
    echo './upgrade.sh 保留数据升级；./uninstall.sh 交互选择保留或清空数据。'
    echo './uninstall.sh --keep-data | --purge-data（非交互执行必须指定）'
    echo './backup.sh [宿主机目录]（默认仓库旁的 setdraft-backups 目录）'
    echo './scripts/setdraft-compose.sh start|stop|status|logs|account|backup|restore'
    echo 'backup/restore <宿主机目录>；account setup-code|reset-password <用户名>'
    echo '原生开发安装：./install.sh --native --mode dev'
    exit 0;;
  install|upgrade|uninstall|start|stop|status|logs|account|backup|restore) ;;
  *) echo "未知命令：$COMMAND" >&2; exit 1;;
esac
KEEP_DATA=no
PURGE_DATA=no
FRESH_INSTALL=no
for arg in "$@"; do
  case "$arg" in
    --fresh-install)
      [ "$COMMAND" = install ] && [ "$FRESH_INSTALL" = no ] || { echo '全新安装标记无效或重复。' >&2; exit 1; }
      FRESH_INSTALL=yes;;
    --keep-data)
      [ "$KEEP_DATA" = no ] && [ "$PURGE_DATA" = no ] || { echo '数据选项不能重复或同时使用。' >&2; exit 1; }
      case "$COMMAND" in install|upgrade|uninstall) KEEP_DATA=yes;; *) echo '此命令不支持 --keep-data。' >&2; exit 1;; esac;;
    --purge-data)
      [ "$COMMAND" = uninstall ] && [ "$KEEP_DATA" = no ] && [ "$PURGE_DATA" = no ] || { echo '--purge-data 仅用于卸载，不能与 --keep-data 同时使用。' >&2; exit 1; }
      PURGE_DATA=yes;;
  esac
done
# Rev1.2 and earlier upgraders enter this file directly with "install" after git merge.
# Only the public install.sh wrapper opts into destructive installation.
if [ "$COMMAND" = install ] && [ "$FRESH_INSTALL" = no ]; then KEEP_DATA=yes; fi
for arg in "$@"; do
  if [ "$arg" = '--help' ]; then exec "$ROOT/scripts/setdraft-compose.sh" help; fi
  if [ "$arg" = '--dry-run' ]; then
    echo "Setdraft Docker Compose: $COMMAND；默认 0.0.0.0:4321，不安装反向代理。"
    echo '配置写入 .env / .env.compose；默认拉取官方 web、sandbox、maintenance 镜像；--build 才从源码构建。'
    if [ "$COMMAND" = install ] && [ "$KEEP_DATA" = no ]; then echo '安装将清空数据库与用户文件；需要保留时使用 --keep-data。'; fi
    if [ "$COMMAND" = upgrade ]; then echo '升级始终保留数据库、用户文件和已有密钥。'; fi
    if [ "$COMMAND" = uninstall ]; then echo "卸载数据选项：keep=$KEEP_DATA purge=$PURGE_DATA；未指定时交互选择，默认保留。"; fi
    echo '不会更改任何文件、容器或数据。原生安装请使用 --native。'
    exit 0
  fi
done
if [ "$COMMAND" = uninstall ]; then
  [ "$#" -le 1 ] && { [ "$#" -eq 0 ] || [ "$KEEP_DATA" = yes ] || [ "$PURGE_DATA" = yes ]; } || { echo '卸载只接受 --keep-data 或 --purge-data。' >&2; exit 1; }
  if [ "$KEEP_DATA" = no ] && [ "$PURGE_DATA" = no ]; then
    [ -t 0 ] || { echo '非交互卸载需要指定 --keep-data 或 --purge-data。' >&2; exit 1; }
    printf '卸载后保留数据库和用户文件？[Y/n] '
    read -r answer
    case "$answer" in ''|y|Y|yes|YES) KEEP_DATA=yes;; n|N|no|NO) PURGE_DATA=yes;; *) echo '未识别选择，未执行卸载。' >&2; exit 1;; esac
  fi
fi
command -v docker >/dev/null 2>&1 || { echo '请先安装 Docker Engine 和 Docker Compose 插件（国内可使用可信镜像源）。' >&2; exit 1; }
docker compose version >/dev/null
docker info >/dev/null
compose() {
  if grep -q "^SETDRAFT_IMAGE_MODE='source'$" "$ROOT/.env.compose"; then
    docker compose --env-file "$ROOT/.env.compose" -f "$ROOT/compose.yaml" -f "$ROOT/compose.build.yaml" "$@"
  else
    docker compose --env-file "$ROOT/.env.compose" -f "$ROOT/compose.yaml" "$@"
  fi
}
# Use the checked-out maintenance scripts even when removing an older deployment.
maintenance() {
  compose run --rm --no-deps --pull never \
    -e "SETDRAFT_REPOSITORY_ROOT=$ROOT" -e SETDRAFT_BACKUP_CONFIG_ROOT=/configuration \
    -v "$ROOT/scripts:/app/scripts:ro" -v "$ROOT:/configuration:ro" "$@"
}
reset_data() {
  compose up -d --no-build --pull never --wait --wait-timeout 120 database
  maintenance maintenance reset --preflight
  compose stop web
  maintenance maintenance reset
  # A completed migration container must run again after its schemas are removed.
  compose rm -f migrate
}
if [ "$COMMAND" = upgrade ]; then
  [ -f "$ROOT/.env.compose" ] || { echo '没有已有部署配置，请先运行 ./install.sh。' >&2; exit 1; }
  [ "$(git branch --show-current)" = main ] || { echo '只能升级 main 分支。' >&2; exit 1; }
  [ -z "$(git status --porcelain --untracked-files=normal)" ] || { echo '请先处理未提交改动，升级不会覆盖它们。' >&2; exit 1; }
  git fetch origin main
  git merge --ff-only FETCH_HEAD
  if [ "$KEEP_DATA" = yes ]; then exec "$ROOT/scripts/setdraft-compose.sh" install "$@"; fi
  exec "$ROOT/scripts/setdraft-compose.sh" install --keep-data "$@"
fi
if [ "$COMMAND" = install ]; then
  if command -v node >/dev/null 2>&1 && node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)'; then
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
      -e SETDRAFT_DOWNLOAD_PROXY -e SETDRAFT_SEARCH_PROXY -e SETDRAFT_NODE_IMAGE -e SETDRAFT_DOCKER_CLI_IMAGE \
      -e SETDRAFT_IMAGE_MODE -e SETDRAFT_IMAGE_NAMESPACE -e SETDRAFT_IMAGE_TAG \
      -e SETDRAFT_WEB_IMAGE -e SETDRAFT_SANDBOX_IMAGE -e SETDRAFT_MAINTENANCE_IMAGE \
      -e SETDRAFT_TESTCASES_MAX -e SETDRAFT_TOTAL_TIME_LIMIT_MS -e SETDRAFT_CASE_MAX_BYTES -e SETDRAFT_PROJECT_MAX_BYTES \
      -e SETDRAFT_AI_CONFIG_PATH -e SETDRAFT_SANDBOX_CONCURRENCY -e SETDRAFT_SANDBOX_MAX_OUTSTANDING \
      -e SETDRAFT_SANDBOX_MAX_OUTSTANDING_PER_USER -e SETDRAFT_SANDBOX_QUEUE_TIMEOUT_MS \
      -e SETDRAFT_SANDBOX_RUN_TIMEOUT_MS -e SETDRAFT_SANDBOX_BUILD_TIMEOUT_MS \
      -e SETDRAFT_SANDBOX_CONCURRENCY_PER_USER -e SETDRAFT_SANDBOX_CPUS -e SETDRAFT_SANDBOX_MEMORY_MB \
      -e SETDRAFT_AI_CONCURRENCY -e SETDRAFT_AI_MAX_OUTSTANDING -e SETDRAFT_AI_MAX_OUTSTANDING_PER_USER \
      -e SETDRAFT_AI_QUEUE_TIMEOUT_MS -e SETDRAFT_AI_RUN_TIMEOUT_MS \
      -e SETDRAFT_OTEL_ENABLED -e OTEL_SERVICE_NAME -e OTEL_TRACES_SAMPLER -e OTEL_TRACES_SAMPLER_ARG \
      -e OTEL_EXPORTER_OTLP_ENDPOINT -e OTEL_EXPORTER_OTLP_HEADERS -e OTEL_EXPORTER_OTLP_PROTOCOL \
      -e OTEL_EXPORTER_OTLP_TRACES_ENDPOINT -e OTEL_EXPORTER_OTLP_TRACES_HEADERS -e OTEL_EXPORTER_OTLP_TRACES_PROTOCOL \
      -e OTEL_EXPORTER_OTLP_METRICS_ENDPOINT -e OTEL_EXPORTER_OTLP_METRICS_HEADERS -e OTEL_EXPORTER_OTLP_METRICS_PROTOCOL \
      -e SETDRAFT_POSTGRES_IMAGE -e SETDRAFT_SEARCH_IMAGE -e SETDRAFT_DB_ADMIN_PASSWORD -e SETDRAFT_DB_APP_PASSWORD -e SETDRAFT_SEARCH_SECRET \
      "$BOOTSTRAP_IMAGE" node scripts/compose-config.mjs "$@"
  fi
  # Prepare every image before stopping the current service. A failed pull leaves it running.
  if grep -q "^SETDRAFT_IMAGE_MODE='source'$" "$ROOT/.env.compose"; then
    compose build web sandbox maintenance
    compose pull database search
  else
    compose pull web sandbox maintenance database search
  fi
  if [ "$KEEP_DATA" = yes ]; then
    compose stop web
  else
    echo '全新安装：清空 Setdraft 数据库和用户文件，保留部署配置。'
    reset_data
  fi
  compose up -d --no-build --pull never --wait --wait-timeout 120 web
  compose logs --tail 15 web
  exit 0
fi
[ -f "$ROOT/.env.compose" ] || { echo '请先运行 ./install.sh 生成 Compose 配置。' >&2; exit 1; }
case "$COMMAND" in
  start) [ "$#" -eq 0 ]; compose up -d --no-build --pull never --wait --wait-timeout 120 web;;
  stop) [ "$#" -eq 0 ]; compose stop web;;
  status) [ "$#" -eq 0 ]; compose ps;;
  logs) compose logs --tail 100 "$@" web;;
  uninstall)
    if [ "$PURGE_DATA" = yes ]; then
      reset_data
      compose down --volumes
      echo '已卸载并清空数据库和用户文件，部署配置和镜像保留。'
    else
      compose down
      echo '已卸载，数据库、用户文件、部署配置和镜像保留。'
    fi;;
  account) compose exec web node packages/hydro-server/dist/account-cli.js "$@";;
  backup|restore)
    if [ "$COMMAND" = backup ] && [ "$#" -eq 0 ]; then
      BACKUPS="$(dirname "$ROOT")/setdraft-backups"
      (umask 077; mkdir -p "$BACKUPS")
      set -- "$BACKUPS/setdraft-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    fi
    [ "$#" -eq 1 ] || { echo '需要备份目录参数。' >&2; exit 1; }
    DEST_PARENT=$(CDPATH= cd "$(dirname "$1")" && pwd -P)
    DEST_NAME=$(basename "$1")
    case "$DEST_NAME" in .|..|'') echo '请选择有效目录。' >&2; exit 1;; esac
    DATA_PATH=$(sed -n "s/^SETDRAFT_DATA_PATH='\(.*\)'$/\1/p" "$ROOT/.env.compose")
    [ -n "$DATA_PATH" ] || { echo '数据目录配置缺失。' >&2; exit 1; }
    DATA_PATH=$(CDPATH= cd "$DATA_PATH" && pwd -P)
    DEST_PATH="$DEST_PARENT/$DEST_NAME"
    case "$DEST_PATH/" in "$DATA_PATH/"*) echo '备份目录不能在数据目录内。' >&2; exit 1;; esac
    case "$DATA_PATH/" in "$DEST_PATH/"*) echo '备份目录不能包含数据目录。' >&2; exit 1;; esac
    DATABASE_RUNNING=$(compose ps --status running -q database)
    WEB_RUNNING=$(compose ps --status running -q web)
    RESUME_WEB=no
    finish_maintenance() {
      result=$?
      trap - 0 INT TERM
      if [ "$RESUME_WEB" = yes ]; then compose start --wait --wait-timeout 120 web || result=1; fi
      if [ -z "$DATABASE_RUNNING" ] && [ "$RESUME_WEB" = no ]; then compose stop database || result=1; fi
      exit "$result"
    }
    trap finish_maintenance 0
    trap 'exit 130' INT
    trap 'exit 143' TERM
    compose up -d --no-build --pull never --wait --wait-timeout 120 database
    maintenance -v "$DEST_PARENT:/backup" maintenance "$COMMAND" "/backup/$DEST_NAME" --preflight
    if [ "$COMMAND" = backup ] && [ -n "$WEB_RUNNING" ]; then RESUME_WEB=yes; fi
    compose stop web
    maintenance -v "$DEST_PARENT:/backup" maintenance "$COMMAND" "/backup/$DEST_NAME"
    echo "维护完成：$DEST_PATH"
    if [ "$COMMAND" = restore ]; then echo '运行 ./scripts/setdraft-compose.sh start 启动服务。'; fi;;
esac
