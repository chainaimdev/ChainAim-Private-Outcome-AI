# chainaim-agent: the tab 03 agent service (architecture-tab03-agent-mode.md ARCH-310). Build context: the repository
# root (the agent imports services/web/src, services/gateway/src/privacy and, since privateAI-design-32 ARCH-620,
# packages/agent-policy); ignore file: services/paywall/agent.Dockerfile.dockerignore. Every file the agent loads at run
# time must be copied here and kept by that ignore file: scripts/test/agent-docker.test.ts walks agent-jobs.ts's imports.
#   docker build -f services/paywall/agent.Dockerfile -t chainaim-agent:local .
# No key, env file or tenant file is in the image: compose mounts rig/tenants and the agent's env file read-only, and
# Node's --env-file reads the env file at start, so its values are not in the container's configuration.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY services/paywall/package.json services/paywall/package-lock.json ./services/paywall/
# Strands, the AWS SDK and zod are devDependencies of the paywall (F9), so they are installed here, not in the paywall image.
RUN npm --prefix services/paywall ci --include=dev --no-audit --no-fund
COPY services/paywall/src ./services/paywall/src
COPY services/paywall/scripts ./services/paywall/scripts
COPY services/web/src/balance.ts services/web/src/crossmark-signer.ts services/web/src/near-payment.ts services/web/src/xrpl-payment.ts ./services/web/src/
COPY services/gateway/src/privacy/entities.ts services/gateway/src/privacy/presidio.ts services/gateway/src/privacy/residual.ts ./services/gateway/src/privacy/
# The buyer-side spending policy (ARCH-620): pure, Node built-ins only.
COPY packages/agent-policy/package.json packages/agent-policy/package.json
COPY packages/agent-policy/src packages/agent-policy/src
# /data/spend: the spend ledger (--spend-dir, volume chainaim-agent-spend); owned by node, which runs the service, so an
# empty named volume takes this owner on first use.
RUN mkdir -p /data/spend && chown node:node /data/spend
USER node
EXPOSE 8760
ENTRYPOINT ["node", "--env-file=/run/secrets/agent-tenants.env", "services/paywall/scripts/agent-jobs.ts"]
# The container's defaults; up.ps1 -Agent on writes the full command (tenants, region, model, timeout) in runtime/compose/commands.yml.
CMD ["--host", "0.0.0.0", "--port", "8760", "--allowed-hosts", "agent:8760,127.0.0.1:8760,localhost:8760", "--tenants", "/app/rig/tenants", "--console", "http://console-api:8735", "--paywall", "http://paywall:8080", "--presidio-url", "http://presidio.railway.internal:3000", "--aws-auth", "bearer", "--spend-dir", "/data/spend"]
