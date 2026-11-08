# syntax=docker/dockerfile:1.7
# The push relay (crates/hushos-push; docs/push-relay-plan.md). Built from the repository root:
#   docker build -f crates/hushos-push/Dockerfile -t hushos-push:local .
# HushOS runs it at push.hushos.com; self-hosted servers never need to.

FROM rust:1.97-bookworm AS build
WORKDIR /src
# The whole workspace's manifests and members, since cargo reads every member; only the relay
# is compiled.
COPY Cargo.toml Cargo.lock ./
COPY crates crates
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p hushos-push \
    && cp target/release/hushos-push /usr/local/bin/hushos-push

# glibc and CA roots, no shell. Runs as uid 65532.
FROM gcr.io/distroless/cc-debian12:nonroot AS relay
COPY --from=build /usr/local/bin/hushos-push /usr/local/bin/hushos-push
ENV PUSH_LISTEN=0.0.0.0:8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["/usr/local/bin/hushos-push", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/hushos-push"]
