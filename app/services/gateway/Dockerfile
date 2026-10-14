# Build context: repository root
#   docker build -f services/gateway/Dockerfile -t travelduty/gateway .
FROM node:20-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY libs/ts-common/package.json libs/ts-common/
COPY services/gateway/package.json services/gateway/
COPY services/booking-service/package.json services/booking-service/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts --workspace @travelduty/gateway --include-workspace-root
COPY libs/ts-common libs/ts-common
COPY services/gateway services/gateway
RUN npx tsc -b libs/ts-common services/gateway \
 && npm prune --omit=dev --workspace @travelduty/gateway

FROM node:20-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/libs/ts-common/package.json libs/ts-common/package.json
COPY --from=build /src/libs/ts-common/dist libs/ts-common/dist
COPY --from=build /src/services/gateway/package.json services/gateway/package.json
COPY --from=build /src/services/gateway/dist services/gateway/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "services/gateway/dist/index.js"]
