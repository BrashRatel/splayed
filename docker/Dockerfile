# splayed in a container: the web UI (proxied mode) or any CLI command.
#
#   docker build -f docker/Dockerfile -t splayed .
#   docker buildx build -f docker/Dockerfile --platform linux/amd64,linux/arm64 -t splayed .
#
# See docs/user/docker.md.

ARG DENO_VERSION=2.9.6

# ---- build: compile the CLI (UI files included) into one binary for this platform ----
FROM denoland/deno:${DENO_VERSION} AS build
WORKDIR /src
COPY deno.json deno.lock package.json ./
COPY main.ts ./
COPY src ./src
RUN deno install --frozen && deno task compile

# ---- runtime: a slim Debian with Tor from Debian's signed repository ----
FROM debian:bookworm-slim
# tor: the managed Tor that splayed starts for public backends (fail-closed; no clearnet fallback).
#   WITH_TOR=0 leaves it out, for hosts that provide their own Tor (StartOS; SPLAYED_TOR_MODE=system).
# ca-certificates: TLS to clearnet HTTPS backends reached through Tor.
ARG WITH_TOR=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
    $(if [ "$WITH_TOR" = 1 ]; then echo tor; fi) \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin splayed \
  && mkdir -p /data && chown splayed:splayed /data && chmod 700 /data
COPY --from=build /src/dist/splayed /usr/local/bin/splayed
COPY docker/entrypoint.sh /usr/local/bin/splayed-entrypoint
RUN chmod 0755 /usr/local/bin/splayed /usr/local/bin/splayed-entrypoint

ENV SPLAYED_DATA_DIR=/data \
    SPLAYED_TOR_BINARY=/usr/bin/tor \
    SPLAYED_UI_LISTEN=0.0.0.0:8080 \
    SPLAYED_UI_TOKEN_FILE=/data/ui-token \
    SPLAYED_UI_ALLOWED_HOSTS=localhost:8080,127.0.0.1:8080

USER splayed
VOLUME ["/data"]
EXPOSE 8080
# Listening is all this checks (the UI answers only to its allowed host names and a token).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/8080' || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/splayed-entrypoint"]
