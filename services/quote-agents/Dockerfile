# quote-agents (privateAI-design-44 §3.2, ARCH-737). Node runs the TypeScript directly: no build step, no npm dependencies.
# Build context: the repository root; services/quote-agents/Dockerfile.dockerignore keeps only what is copied below.
# The tenant tokens (QUOTE_TOKEN_JUPITER, QUOTE_TOKEN_TOMMY) come from the env file compose mounts read-only at
# /run/secrets/quote-agents.env (read by Node's --env-file-if-exists, never baked in); the gateway key from the compose
# secret gateway-key (--gateway-key-file).
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY services/quote-agents/package.json services/quote-agents/package.json
COPY services/quote-agents/src services/quote-agents/src
COPY config/quote-tenants.json config/quote-tenants.json
COPY config/quote-prompts config/quote-prompts
COPY sample-data/quote sample-data/quote
USER node
EXPOSE 8785
ENTRYPOINT ["node", "--env-file-if-exists=/run/secrets/quote-agents.env", "services/quote-agents/src/main.ts"]
CMD ["--host", "0.0.0.0", "--allow-non-loopback", "--port", "8785"]
