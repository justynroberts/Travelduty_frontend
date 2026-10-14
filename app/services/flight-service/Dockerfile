# Build context: repository root
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY libs/go-platform libs/go-platform
COPY services/flight-service/go.mod services/flight-service/go.sum services/flight-service/
RUN cd services/flight-service && GOWORK=off go mod download
COPY services/flight-service services/flight-service
RUN cd services/flight-service && CGO_ENABLED=0 GOWORK=off go build -trimpath -ldflags="-s -w" -o /out/flight-service .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/flight-service /app/flight-service
COPY data/airports.json /data/airports.json
ENV PORT=8082 REFERENCE_DATA_DIR=/data
EXPOSE 8082
USER nonroot
ENTRYPOINT ["/app/flight-service"]
