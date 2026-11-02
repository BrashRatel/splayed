# A plain Tor client for the compose.tor.yml variant: SOCKS on the compose network only.
FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends tor \
  && rm -rf /var/lib/apt/lists/*
# SocksPort on all of the container's interfaces (only the compose network reaches it). Default
# isolation flags include IsolateSOCKSAuth. SocksPolicy limits clients to private networks.
RUN printf '%s\n' \
  'SocksPort 0.0.0.0:9050' \
  'SocksPolicy accept 10.0.0.0/8' \
  'SocksPolicy accept 172.16.0.0/12' \
  'SocksPolicy accept 192.168.0.0/16' \
  'SocksPolicy reject *' \
  'DataDirectory /var/lib/tor' \
  'Log notice stdout' > /etc/tor/torrc \
  && mkdir -p /var/lib/tor && chown debian-tor:debian-tor /var/lib/tor && chmod 700 /var/lib/tor
USER debian-tor
ENTRYPOINT ["tor", "-f", "/etc/tor/torrc"]
