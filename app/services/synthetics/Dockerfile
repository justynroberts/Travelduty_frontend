# Build context: repository root
#   docker build -f services/synthetics/Dockerfile -t travelduty/synthetics .
FROM node:20-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY libs/ts-common/package.json libs/ts-common/
COPY services/gateway/package.json services/gateway/
COPY services/booking-service/package.json services/booking-service/
COPY services/synthetics/package.json services/synthetics/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts --workspace @travelduty/synthetics --include-workspace-root
COPY libs/ts-common libs/ts-common
COPY services/synthetics services/synthetics
RUN npx tsc -b libs/ts-common services/synthetics \
 && npm prune --omit=dev --workspace @travelduty/synthetics

FROM node:20-alpine
ENV NODE_ENV=production PORT=8088
WORKDIR /app
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/libs/ts-common/package.json libs/ts-common/package.json
COPY --from=build /src/libs/ts-common/dist libs/ts-common/dist
COPY --from=build /src/services/synthetics/package.json services/synthetics/package.json
COPY --from=build /src/services/synthetics/dist services/synthetics/dist
USER node
EXPOSE 8088
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8088/health >/dev/null || exit 1
CMD ["node", "services/synthetics/dist/index.js"]
