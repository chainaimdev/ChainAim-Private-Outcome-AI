# ca-control-signer (privateAI-design-36 ARCH-660): ChainAim's signer, the control plane of a paid job. Build context: the
# repository root; services/signer/Dockerfile.dockerignore replaces the root .dockerignore for this build and lets in only
# what is copied below. No npm dependencies: node built-ins and four dependency-free packages. The same image runs in its own
# compose project on the PC (services/signer/compose.yml), on Railway or on AWS (docs/deploy/signer-cloud.md).
# Keys are NEVER copied in: AP2_SIGNING_KEY, RECEIPT_SIGNING_KEY and SIGNER_REQUEST_KEY come from the runtime environment
# (compose: by name from up.ps1's process; Railway / AWS: the platform's secret variables).
# config/ holds public settings only (pricing catalogs, cost model, the tenants' PUBLIC mandate keys); the run command
# names the files (--pricing-catalog, --cost-model, --mandate-keys).
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY packages/crossask/package.json packages/crossask/package.json
COPY packages/crossask/src/cost.ts packages/crossask/src/cost.ts
COPY packages/receipt/package.json packages/receipt/package.json
COPY packages/receipt/src packages/receipt/src
COPY packages/ap2/package.json packages/ap2/package.json
COPY packages/ap2/src packages/ap2/src
COPY packages/offer/package.json packages/offer/package.json
COPY packages/offer/src packages/offer/src
COPY packages/signer/package.json packages/signer/package.json
COPY packages/signer/src packages/signer/src
COPY services/signer/package.json services/signer/package.json
COPY services/signer/src services/signer/src
COPY config config
USER node
EXPOSE 8780
ENTRYPOINT ["node", "services/signer/src/main.ts"]
CMD ["--host", "0.0.0.0", "--port", "8780"]
