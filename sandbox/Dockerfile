# One step of the graph, executed away from the host.
#
# bookworm-slim rather than alpine: the host is glibc, and keeping the same libc means anything
# that does ship a native binary behaves the same in here as it does outside.
FROM node:22-bookworm-slim

WORKDIR /app

# Dependencies first, so editing a step's code does not reinstall them.
COPY sandbox/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Only the modules a run actually needs. trace.ts, graphstore.ts and index.ts are deliberately
# absent: the container has no database, no port and no way to reach either.
COPY server/providers.ts server/tools.ts server/links.ts server/workspace.ts server/runner.ts server/events.ts ./server/

# Read by tools.ts, which rewrites a localhost MCP URL to reach the host rather than this
# container's own loopback.
ENV MNEMONIC_IN_SANDBOX=1

# node's own user, so nothing in here runs as root.
USER node

ENTRYPOINT ["npx", "tsx", "/app/server/runner.ts"]
