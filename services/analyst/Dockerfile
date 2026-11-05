# chainaim-analyst (DOCKERIZE-PLAN 4.4). Build context: the repository root (the analyst imports packages/crossask and
# reads its domain-pack configs from config/). npm ci runs inside the image so DuckDB's Linux binary is installed; a
# Windows node_modules is never copied (the root .dockerignore excludes every node_modules).
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY services/analyst/package.json services/analyst/package-lock.json services/analyst/
RUN npm --prefix services/analyst ci --omit=dev --no-audit --no-fund
COPY packages/crossask/src packages/crossask/src
COPY packages/crossask/package.json packages/crossask/package.json
COPY config config
COPY services/analyst/src services/analyst/src
# Data is mounted read-only at run time; recipes and run manifests go to the /work volume.
RUN mkdir -p /work && chown node:node /work
USER node
EXPOSE 8740
ENTRYPOINT ["node", "services/analyst/src/main.ts"]
CMD ["--port", "8740", "--bind", "0.0.0.0", "--allowed-hosts", "analyst:8740,127.0.0.1:8740,localhost:8740", "--data-config", "/app/config/data-sources.docker.json", "--work-dir", "/work"]
