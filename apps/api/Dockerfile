FROM node:22-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/core/package.json packages/core/package.json
RUN pnpm install --filter @pools/api... --frozen-lockfile
COPY apps/api apps/api
COPY packages/core packages/core
RUN pnpm --filter @pools/api typecheck
WORKDIR /app/apps/api
USER node
CMD ["node", "--import", "tsx", "src/main.ts"]
