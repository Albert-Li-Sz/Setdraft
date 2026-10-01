#!/bin/sh
# Exercise release images, not the runner's source/dependencies. Uses isolated test data only.
set -eu
COMPONENT=${1:?web|maintenance|sandbox}
IMAGE=${2:?image reference}
case "$COMPONENT" in
  sandbox)
    docker run --rm --network none --read-only --tmpfs /tmp --tmpfs /work:exec -w /work "$IMAGE" sh -eu -c '
      test "$(g++ -dumpfullversion)" = 16.2.0
      printf "#include <testlib.h>\n#include <iostream>\nint main(int argc,char** argv){registerGen(argc,argv,1);std::cout << 42;}\n" > check.cpp
      g++ -std=c++20 -I/opt/testlib check.cpp -o check
      ./check > result
      test "$(cat result)" = 42
      test "$(python3 -c "print(6 * 7)")" = 42
      printf "class Check {public static void main(String[] a){System.out.print(42);}}\n" > Check.java
      javac Check.java
      test "$(java Check)" = 42
    '
    ;;
  maintenance)
    docker run --rm --network none --entrypoint sh "$IMAGE" -eu -c '
      pg_dump --version
      pg_restore --version
      node --input-type=module -e "import {migrateDatabase} from \"./packages/hydro-server/dist/database-schema.js\"; if(typeof migrateDatabase !== \"function\") process.exit(1);"
      test -f scripts/compose-maintenance.mjs
    '
    node scripts/test-maintenance.mjs "$IMAGE"
    ;;
  web)
    NAME="setdraft-image-smoke-$$"
    POSTGRES_IMAGE=${SETDRAFT_POSTGRES_IMAGE:-postgres:18-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650}
    cleanup() {
      docker rm -f "$NAME-web" "$NAME-db" >/dev/null 2>&1 || true
      docker network rm "$NAME" >/dev/null 2>&1 || true
    }
    trap cleanup EXIT
    trap 'exit 1' INT TERM
    docker network create "$NAME" >/dev/null
    docker run -d --name "$NAME-db" --network "$NAME" --network-alias database \
      -e POSTGRES_PASSWORD=smoke-admin-password -e POSTGRES_DB=setdraft \
      --tmpfs /var/lib/postgresql "$POSTGRES_IMAGE" >/dev/null
    ready=no
    for attempt in $(seq 1 60); do
      if docker exec "$NAME-db" pg_isready -h 127.0.0.1 -U postgres -d setdraft >/dev/null 2>&1; then ready=yes; break; fi
      sleep 1
    done
    [ "$ready" = yes ] || { echo 'PostgreSQL did not start.' >&2; exit 1; }
    docker run --rm --network "$NAME" --entrypoint node \
      -e SETDRAFT_DB_APP_PASSWORD=smoke-app-password-0123456789 \
      -e SETDRAFT_DATABASE_ADMIN_URL=postgresql://postgres:smoke-admin-password@database:5432/setdraft \
      "$IMAGE" packages/hydro-server/dist/migrate-cli.js
    docker run -d --name "$NAME-web" --network "$NAME" \
      --tmpfs /workspace -e SETDRAFT_WORKSPACE_ROOT=/workspace \
      -e SETDRAFT_DATABASE_URL=postgresql://setdraft_app:smoke-app-password-0123456789@database:5432/setdraft \
      "$IMAGE" >/dev/null
    ready=no
    for attempt in $(seq 1 45); do
      if docker exec "$NAME-web" node -e 'fetch("http://127.0.0.1:4321/api/health").then(async r=>{if(!r.ok||(await r.json()).status!=="ok")process.exit(1)}).catch(()=>process.exit(1))' >/dev/null 2>&1; then ready=yes; break; fi
      sleep 1
    done
    [ "$ready" = yes ] || { echo 'Setdraft did not become healthy.' >&2; exit 1; }
    docker exec "$NAME-web" node --input-type=module -e '
      const base="http://127.0.0.1:4321";
      const page=await fetch(base); const html=await page.text();
      if(!page.ok||!html.includes("<div id=\"root\""))throw new Error("Missing Web UI");
      const asset=html.match(/src="([^\"]+\.js)"/); if(!asset||!(await fetch(base+asset[1])).ok)throw new Error("Missing Web assets");
      const session=await fetch(base+"/api/auth/session");
      if(!session.ok||!(await session.json()).setupRequired)throw new Error("Setup endpoint failed");
      const business=await fetch(base+"/api/projects");
      if(business.ok)throw new Error("Business API must require setup/login");
    '
    ;;
  *) echo 'Expected web, maintenance or sandbox.' >&2; exit 1 ;;
esac
printf '%s image smoke test passed.\n' "$COMPONENT"
