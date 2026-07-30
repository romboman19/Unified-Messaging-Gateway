# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/database/package.json ./packages/database/
RUN npm install

FROM base AS build
COPY . .
RUN npm run build --workspace=packages/contracts --workspace=packages/database
RUN npx prisma generate --schema packages/database/prisma/schema.prisma
RUN npm run build --workspace=apps/api --workspace=apps/worker

FROM node:24-alpine AS api
ENV NODE_ENV=production
RUN apk add --no-cache openssl
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY infra/docker/entrypoint-api.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 4000
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]

FROM node:24-alpine AS worker
ENV NODE_ENV=production
RUN apk add --no-cache openssl
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY infra/docker/entrypoint-worker.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "apps/worker/dist/main.js"]

FROM node:24-alpine AS web-builder
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
RUN npm install
COPY . .
RUN npm run build --workspace=apps/web

FROM nginx:1.27-alpine AS web
COPY --from=web-builder /app/apps/web/dist /usr/share/nginx/html
COPY infra/docker/nginx-web.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
