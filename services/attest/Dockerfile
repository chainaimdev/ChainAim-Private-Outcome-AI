# ca-attest (PLAN-private-ai-nearai-attestation.md ARCH-409/410). Build context: services/attest.
#
# Stage 1 builds the OFFICIAL verifier exactly at the pinned commit (gate V3 ran this commit on the owner PC 2026-11-06):
# git fetch of that one commit, checked against the full SHA, then `npm ci` with OUR committed lockfile
# (verifier/package-lock.json: upstream ships only a pnpm lock, and pnpm refused esbuild's build script in V3), then the
# verifier's own `npm run build` (tsc, module commonjs -> dist/ts/*.js). Stage 2 is the service: our code (Node built-ins,
# no npm dependencies) plus the built verifier at /opt/nearai-cloud-verifier (--verifier-dir).
FROM node:24-slim AS verifier
ARG VERIFIER_REPO=https://github.com/nearai/nearai-cloud-verifier.git
ARG VERIFIER_COMMIT=94554726fd548676842b7ea603a8173a60c31341
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/nearai-cloud-verifier
RUN git init -q . \
 && git remote add origin "$VERIFIER_REPO" \
 && git fetch -q --depth 1 origin "$VERIFIER_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$VERIFIER_COMMIT" \
 && rm -rf .git
COPY verifier/package-lock.json ./package-lock.json
RUN npm ci --no-audit --no-fund \
 && npm run build \
 && test -f dist/ts/model_verifier.js \
 && test -f dist/ts/chat_verifier.js

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=verifier /opt/nearai-cloud-verifier /opt/nearai-cloud-verifier
COPY package.json ./package.json
COPY src ./src
COPY scripts ./scripts
COPY test ./test
USER node
EXPOSE 8770
ENTRYPOINT ["node", "src/main.ts"]
CMD ["--host", "0.0.0.0", "--allow-non-loopback", "--port", "8770", "--allowed-hosts", "attest:8770,127.0.0.1:8770,localhost:8770", "--catalog", "/config/generated/catalog.local.json"]
