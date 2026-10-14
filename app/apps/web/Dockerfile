# Build context: repository root
#   docker build -f apps/web/Dockerfile -t travelduty/web .
FROM node:20-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY libs/ts-common/package.json libs/ts-common/
COPY services/gateway/package.json services/gateway/
COPY services/booking-service/package.json services/booking-service/
COPY services/synthetics/package.json services/synthetics/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @travelduty/web --include-workspace-root
COPY apps/web apps/web
RUN npm run build --workspace @travelduty/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
EXPOSE 80
