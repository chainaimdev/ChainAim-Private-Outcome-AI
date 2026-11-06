# chainaim-agent: the tab 03 agent service (architecture-tab03-agent-mode.md ARCH-310). Build context: services/
# (the agent imports services/web/src and services/gateway/src/privacy); ignore file: paywall/agent.Dockerfile.dockerignore.
#   docker build -f services/paywall/agent.Dockerfile -t chainaim-agent:local services
# No key, env file or tenant file is in the image: compose mounts rig/tenants and the agent's env file read-only, and
# Node's --env-file reads the env file at start, so its values are not in the container's configuration.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY paywall/package.json paywall/package-lock.json ./services/paywall/
# Strands, the AWS SDK and zod are devDependencies of the paywall (F9), so they are installed here, not in the paywall image.
RUN npm --prefix services/paywall ci --include=dev --no-audit --no-fund
COPY paywall/src ./services/paywall/src
COPY paywall/scripts ./services/paywall/scripts
COPY web/src/balance.ts web/src/crossmark-signer.ts web/src/near-payment.ts web/src/xrpl-payment.ts ./services/web/src/
COPY gateway/src/privacy/entities.ts gateway/src/privacy/presidio.ts gateway/src/privacy/residual.ts ./services/gateway/src/privacy/
USER node
EXPOSE 8760
ENTRYPOINT ["node", "--env-file=/run/secrets/agent-tenants.env", "services/paywall/scripts/agent-jobs.ts"]
# The container's defaults; up.ps1 -Agent on writes the full command (tenants, region, model, timeout) in runtime/compose/commands.yml.
CMD ["--host", "0.0.0.0", "--port", "8760", "--allowed-hosts", "agent:8760,127.0.0.1:8760,localhost:8760", "--tenants", "/app/rig/tenants", "--console", "http://console-api:8735", "--paywall", "http://paywall:8080", "--presidio-url", "http://presidio.railway.internal:3000", "--aws-auth", "bearer"]
