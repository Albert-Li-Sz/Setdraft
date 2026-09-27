ARG NODE_IMAGE=node:24.18.0-bookworm-slim
ARG DOCKER_CLI_IMAGE=docker:29-cli
FROM ${DOCKER_CLI_IMAGE} AS docker-cli
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmmirror.com
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY scripts ./scripts
RUN npm ci --registry="$NPM_REGISTRY" --ignore-scripts --no-audit --no-fund --fetch-retries=3 --fetch-timeout=60000 \
    && npm run build --workspace=@earendil-works/pi-telemetry \
    && npm run build:offline --workspace=@earendil-works/pi-ai \
    && npm run build --workspace=@setdraft/authoring \
    && npm run build --workspace=@setdraft/server \
    && npm run build --workspace=@setdraft/web \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production SETDRAFT_HOST=0.0.0.0 SETDRAFT_WEB_ROOT=/app/packages/hydro-web/dist
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/scripts ./scripts
COPY deploy/container-entrypoint.sh /usr/local/bin/setdraft-entrypoint
RUN command -v flock && chmod +x /usr/local/bin/setdraft-entrypoint
EXPOSE 4321
ENTRYPOINT ["setdraft-entrypoint"]
CMD ["node", "packages/hydro-server/dist/cli.js"]
