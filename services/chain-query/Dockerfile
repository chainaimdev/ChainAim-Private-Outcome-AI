# chainaim-chain-query (DOCKERIZE-PLAN 4.4). Build context: the repository root (it imports packages/chain-contracts and
# reads config/chains/networks.json). No npm dependencies (Node fetch). Read-only: holds no keys, signs nothing.
# The per-PC profile (config/local/chain-profile.json, git-ignored) is mounted read-only at run time when wanted.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY packages/chain-contracts/package.json packages/chain-contracts/package.json
COPY packages/chain-contracts/src packages/chain-contracts/src
COPY config/chains config/chains
COPY services/chain-query/package.json services/chain-query/package.json
COPY services/chain-query/src services/chain-query/src
USER node
EXPOSE 8750
ENTRYPOINT ["node", "services/chain-query/src/main.ts"]
CMD ["--host", "0.0.0.0", "--allow-non-loopback", "--port", "8750", "--allowed-hosts", "chain-query:8750,127.0.0.1:8750,localhost:8750", "--chains", "near"]
