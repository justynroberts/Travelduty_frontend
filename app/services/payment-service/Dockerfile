# Build context: repository root
#   docker build -f services/payment-service/Dockerfile -t travelduty/payment-service .
FROM rust:1.91-slim-bookworm AS build
WORKDIR /src

# Compile dependencies against stub sources first so they cache independently of app code.
COPY services/payment-service/Cargo.toml services/payment-service/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && touch src/lib.rs \
    && cargo build --release --locked \
    && rm -rf src target/release/deps/payment_service* target/release/deps/libpayment_service* target/release/payment-service*

COPY services/payment-service/src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home app
COPY --from=build /src/target/release/payment-service /usr/local/bin/payment-service
USER 10001
ENV PORT=8086
EXPOSE 8086
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD curl -fsS http://localhost:8086/health || exit 1
ENTRYPOINT ["/usr/local/bin/payment-service"]
