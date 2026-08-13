FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY core-artifacts.lock.json ./
COPY vendor ./vendor
COPY scripts ./scripts
COPY packages ./packages
COPY examples ./examples
RUN npm ci --ignore-scripts \
    && npm run check:public \
    && npm run verify:core \
    && npm run build \
    && npm prune --omit=dev

FROM node:24.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    VOICECAN_HOST=0.0.0.0 \
    VOICECAN_PORT=8787 \
    VOICECAN_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "packages/device-server/dist/cli.js", "serve"]
