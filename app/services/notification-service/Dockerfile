# Build context: repository root
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY libs/go-platform libs/go-platform
COPY services/notification-service/go.mod services/notification-service/go.sum services/notification-service/
RUN cd services/notification-service && GOWORK=off go mod download
COPY services/notification-service services/notification-service
RUN cd services/notification-service && CGO_ENABLED=0 GOWORK=off go build -trimpath -ldflags="-s -w" -o /out/notification-service .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/notification-service /app/notification-service

ENV PORT=8087
EXPOSE 8087
USER nonroot
ENTRYPOINT ["/app/notification-service"]
