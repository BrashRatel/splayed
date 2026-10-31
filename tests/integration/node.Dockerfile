# Official Bitcoin Core / Bitcoin Knots release binaries, pinned by SHA-256. Regtest only.
FROM debian:bookworm-slim
ARG NODE=core
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    if [ "$NODE" = core ]; then \
      version=31.0; base=https://bitcoincore.org/bin/bitcoin-core-31.0; \
      checksum=d3e4c58a35b1d0a97a457462c94f55501ad167c660c245cb1ffa565641c65074; \
    else \
      version=29.4.1.knots20260508; base=https://bitcoinknots.org/files/29.x/29.4.1.knots20260508; \
      checksum=0d0b435ae67dd38d150c048a388be821ad0ca8b46d6dcace5c34d4ba2977801b; \
    fi; \
    curl -fL "$base/bitcoin-$version-x86_64-linux-gnu.tar.gz" -o /tmp/node.tar.gz; \
    echo "$checksum  /tmp/node.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/node.tar.gz -C /tmp; \
    install /tmp/bitcoin-*/bin/bitcoind /tmp/bitcoin-*/bin/bitcoin-cli /usr/local/bin/; \
    rm -rf /tmp/bitcoin-* /tmp/node.tar.gz
RUN mkdir /data
ENTRYPOINT ["bitcoind", "-datadir=/data", "-regtest", "-server", "-mocktime=1791820800", "-txindex", "-listen=1", "-connect=0", "-dnsseed=0", "-discover=0", "-rpcbind=0.0.0.0", "-rpcallowip=0.0.0.0/0", "-rpcuser=regtest", "-rpcpassword=regtest", "-fallbackfee=0.00001", "-acceptnonstdtxn=0"]
