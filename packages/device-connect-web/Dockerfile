FROM node:24.19.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json core-artifacts.lock.json ./
COPY vendor ./vendor
COPY scripts ./scripts
COPY packages ./packages
COPY examples ./examples
COPY .gitea ./.gitea

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts \
    && npm run check:public \
    && npm run verify:core \
    && npm run typecheck \
    && npm run build --workspace @voicecan/device-connect-web \
    && node --import tsx --test packages/device-connect-web/test/*.test.ts packages/device-server/test/admin-ui.test.ts

FROM nginx:1.28.0-alpine AS runtime

COPY packages/device-connect-web/deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/device-connect-web/dist/ /usr/share/nginx/html/

RUN chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /run /etc/nginx/conf.d

USER 101:101
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/index.html || exit 1

CMD ["nginx", "-g", "daemon off;"]
