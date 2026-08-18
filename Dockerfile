# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_STANDALONE=true
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
ENV APP_URL=http://localhost:2040
ENV APP_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
RUN pnpm build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=2040
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 wgcontrol && useradd --system --uid 1001 --gid wgcontrol --create-home wgcontrol
COPY --from=deps --chown=wgcontrol:wgcontrol /app/node_modules ./node_modules
COPY --from=builder --chown=wgcontrol:wgcontrol /app/.next/standalone ./
COPY --from=builder --chown=wgcontrol:wgcontrol /app/.next/static ./.next/static
COPY --from=builder --chown=wgcontrol:wgcontrol /app/public ./public
COPY --from=builder --chown=wgcontrol:wgcontrol /app/migrations ./migrations
COPY --from=builder --chown=wgcontrol:wgcontrol /app/scripts ./scripts
COPY --from=builder --chown=wgcontrol:wgcontrol /app/src ./src
COPY --from=builder --chown=wgcontrol:wgcontrol /app/tsconfig.json ./tsconfig.json
COPY --chown=wgcontrol:wgcontrol docker-entrypoint.sh /usr/local/bin/wg-control-entrypoint
RUN chmod 0555 /usr/local/bin/wg-control-entrypoint
USER wgcontrol
EXPOSE 2040
ENTRYPOINT ["wg-control-entrypoint"]
CMD ["node", "server.js"]
