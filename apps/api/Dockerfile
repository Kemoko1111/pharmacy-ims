# PharmaTrack API — Railway deploy (ADR-007). Build from the repo ROOT:
#   docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @pharmatrack/api --filter @pharmatrack/shared

COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @pharmatrack/shared build \
 && pnpm --filter @pharmatrack/api db:generate \
 && pnpm --filter @pharmatrack/api build \
 && pnpm --filter @pharmatrack/api deploy --prod --legacy /app

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
COPY --from=build /repo/apps/api/dist /app/dist

EXPOSE 3000
# migrations run on boot so deploys stay zero-touch (ADR-009)
CMD ["sh", "-c", "npx prisma@6 migrate deploy && node dist/main.js"]
