# Orchestrator worker image. Build from the repository root:
#   docker build -f apps/orchestrator/Dockerfile -t agent-factory-orchestrator .
# Run with a volume for the clone and the worktrees, e.g.:
#   docker run --env-file orchestrator.env -v factory-data:/data -p 3100:3100 agent-factory-orchestrator
# with REPO_DIR=/data/repo and WORKTREES_DIR=/data/worktrees.
FROM node:22-bookworm-slim

# git for worktrees; bubblewrap for CLAUDE_CODE_SUBPROCESS_ENV_SCRUB (the
# sandbox needs user namespaces: allow them in the container runtime, or set
# AGENT_SUBPROCESS_ENV_SCRUB=0).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates bubblewrap \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Never run as root: the agent and pnpm verify execute code from issues.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin factory \
  && mkdir -p /app /data \
  && chown factory:factory /app /data

USER factory
WORKDIR /app
COPY --chown=factory:factory . .
RUN pnpm install --frozen-lockfile && pnpm build --filter orchestrator

ENV NODE_ENV=production PORT=3100
EXPOSE 3100
VOLUME ["/data"]
CMD ["node", "apps/orchestrator/dist/main.js"]
