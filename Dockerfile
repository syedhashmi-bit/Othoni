# othoni in a container — an alternative to the one-line installer, which
# runs othoni straight on the host. docker-compose.yml gives the container
# the host views it monitors (host network + PID namespace, the host
# filesystem read-only, the Docker socket); see README → Docker.
#
#   docker compose up -d
#   docker compose logs othoni      # shows the one-time setup link

# ---- build: server deps + the React client ----
FROM node:24-trixie-slim AS build
# Toolchain only here, in case better-sqlite3 has no prebuilt binary for
# this platform and has to compile.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/package-lock.json ./client/
# The root postinstall installs the client's dependencies too.
RUN npm ci --no-audit --no-fund
COPY client ./client
RUN npm run client:build

# ---- the docker CLI, for the Docker page (talks to the mounted socket) ----
FROM node:24-trixie-slim AS dockercli
ARG TARGETARCH
ARG DOCKER_CLI_VERSION=29.9.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && case "$TARGETARCH" in arm64) arch=aarch64 ;; *) arch=x86_64 ;; esac \
 && curl -fsSL "https://download.docker.com/linux/static/stable/$arch/docker-$DOCKER_CLI_VERSION.tgz" \
    | tar -xz -C /tmp docker/docker

# ---- runtime ----
FROM node:24-trixie-slim
# ps for the Processes page, ping for synthetic checks.
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps iputils-ping \
 && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /tmp/docker/docker /usr/local/bin/docker
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8088
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/client/dist ./client/dist
COPY package.json ./
COPY server ./server
COPY scripts/reset-password.js ./scripts/
# Accounts, the setup code, the session secret and the metrics database.
VOLUME ["/app/data"]
EXPOSE 8088
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8088) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server/index.js"]
