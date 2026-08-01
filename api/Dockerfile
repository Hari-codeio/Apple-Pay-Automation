# ─────────────────────────────────────────────────────────────────────────────
# Base: Microsoft's Playwright image.
#
# Chromium needs ~40 shared libraries that node:22-slim does not ship. Installing
# them by hand produces a Dockerfile that breaks on every Playwright bump, because
# the dependency list is version-specific. This image is published per Playwright
# release and already carries the browsers and a non-root `pwuser`.
#
# The tag MUST track the `playwright` version in api/package.json. A mismatch
# means the driver looks for a browser build that is not in the image and fails at
# launch with "Executable doesn't exist".
# ─────────────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS builder

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

WORKDIR /workspace

# Workspace manifests first: these change far less often than source, so the
# install layer stays cached across ordinary code edits.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY api/package.json ./api/
COPY packages ./packages

# Only this service's dependency closure, not the whole workspace.
RUN pnpm install --frozen-lockfile --filter=@apple-pay/api...

COPY api ./api

RUN pnpm --filter=@apple-pay/api... build

# ── Stage 2: prune to production dependencies ───────────────────────────────
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS deployer

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY --from=builder /workspace/api/package.json ./api/
COPY --from=builder /workspace/packages ./packages

# Hardlink workspace deps into the pruned output instead of symlinking them,
# so the result is self-contained and can be copied into the runtime stage.
RUN echo "inject-workspace-packages=true" >> .npmrc

RUN pnpm deploy --filter=@apple-pay/api --prod /app/deploy

# ── Stage 3: runtime ────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# dumb-init reparents node so SIGTERM actually reaches it. Without it node runs
# as PID 1, does not forward signals, and the orchestrator hard-kills the
# container at the end of its grace period — mid-verification, with the MySQL
# pool open and a browser still running.
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deployer /app/deploy ./
COPY --from=builder /workspace/api/dist ./dist

# The session file and Playwright artifacts are written at runtime. Created here
# so the non-root user owns them rather than discovering it cannot write at all.
RUN mkdir -p /app/.playwright /app/.artifacts \
    && chown -R pwuser:pwuser /app

# pwuser ships with the base image and owns the browser installation.
USER pwuser

EXPOSE 3000

# The session file is a credential and must survive a restart. Without a volume
# here, every rolling deploy loses it and needs another interactive
# `pnpm apple:login`.
VOLUME ["/app/.playwright"]

# Liveness only. /readyz needs MySQL, and a dependency flap should drain the pod
# from rotation, not restart it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main"]
