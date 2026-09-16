FROM node:22-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/token-image/package.json packages/token-image/package.json
# Sharp's prebuilt libvips binary is a build-allowed optional dependency.
RUN pnpm install --filter @pools/api... --frozen-lockfile
COPY apps/api apps/api
COPY packages/core packages/core
COPY packages/token-image packages/token-image
# Repository checks include integration tests and their fixture dependencies.
# This read-only service image contains only API/core production dependencies.
RUN pnpm --filter @pools/api exec tsc --project tsconfig.runtime.json
WORKDIR /app/apps/api
USER node
CMD ["node", "--import", "tsx", "src/main.ts"]
