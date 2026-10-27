# syntax=docker/dockerfile:1
FROM node:24.19.0-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS toolchain
WORKDIR /app
RUN --mount=type=secret,id=registry_ca \
    if [ -s /run/secrets/registry_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/registry_ca; fi; \
    npm install --global pnpm@11.25.0

FROM toolchain AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN --mount=type=secret,id=registry_ca \
    if [ -s /run/secrets/registry_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/registry_ca; fi; \
    pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
ARG RELEASE_ID=local-container
RUN RELEASE_ID="$RELEASE_ID" pnpm build

FROM toolchain AS api-dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN --mount=type=secret,id=registry_ca \
    if [ -s /run/secrets/registry_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/registry_ca; fi; \
    pnpm install --prod --frozen-lockfile --filter @apple/api...

FROM node:24.19.0-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS api-runtime
WORKDIR /app
ENV HOST=0.0.0.0 PORT=3001
COPY --from=api-dependencies --chown=node:node /app /app
COPY --from=build --chown=node:node /app/apps/api/dist apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/migrations apps/api/migrations
COPY --from=build --chown=node:node /app/packages/contracts/dist packages/contracts/dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "apps/api/dist/index.js"]

FROM nginxinc/nginx-unprivileged:1.28-alpine@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8 AS web-runtime
COPY --chown=nginx:nginx --chmod=644 infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=nginx:nginx /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -Y off -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
