FROM node:22-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/indexer/package.json apps/indexer/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/chain/package.json packages/chain/package.json
COPY packages/db/package.json packages/db/package.json
RUN pnpm install --filter @pools/indexer... --frozen-lockfile
COPY apps/indexer apps/indexer
COPY packages/core packages/core
COPY packages/chain packages/chain
COPY packages/db packages/db
RUN pnpm --filter @pools/indexer typecheck
WORKDIR /app/apps/indexer
USER node
CMD ["node", "--import", "tsx", "src/main.ts", "run"]
