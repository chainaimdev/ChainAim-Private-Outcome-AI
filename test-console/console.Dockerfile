# The test console's backend in a container: server.ts --mode api (DOCKERIZE-PLAN 4.4). Build context: the repository
# root; test-console/console.Dockerfile.dockerignore replaces the root .dockerignore for this build (the root one leaves
# out test-console). No npm dependencies: server.ts imports only Node built-ins, packages/crossask, packages/receipt
# (privateAI-design-32 ARCH-613..616, node:crypto only) and two dependency-free files of services/web. Every file it
# loads at run time must be copied here and allowed in the .dockerignore: scripts/test/console-docker.test.ts
# "ARCH-615 ... console image" walks server.ts's imports and fails when one is missing (seen 2026-11-10: the image had
# no packages/receipt, so ca-console-api exited at start). The browser bundles are not needed: in the split they are
# served by the ui process on the PC.
# The gateway key is mounted at run time (--gateway-key-file), never copied into the image.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY packages/crossask/package.json packages/crossask/package.json
COPY packages/crossask/src packages/crossask/src
COPY packages/receipt/package.json packages/receipt/package.json
COPY packages/receipt/src packages/receipt/src
COPY services/web/src/balance.ts services/web/src/near-wallets.ts services/web/src/
COPY config config
COPY test-console/console test-console/console
RUN mkdir -p /runs && chown node:node /runs
USER node
EXPOSE 8735 8731
ENTRYPOINT ["node", "test-console/console/server.ts"]
CMD ["--mode", "api", "--bind", "0.0.0.0", "--port", "8735", "--gateway-key-file", "/run/secrets/gateway-key", "--run-log-dir", "/runs"]
