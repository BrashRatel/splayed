# eCash (ECX) full node, built from source at the commit forksplit's ECX rule is pinned to
# (IsFinalTx exempts nLockTime 499,999,998). Regtest only. Slow first build (C++), then cached.
FROM debian:bookworm-slim AS builder
ARG ECX_COMMIT=c8474e0b4f2be9b470c46598a5a6a3e55a85b765
RUN apt-get update -y && apt-get install -y --no-install-recommends ca-certificates git \
      build-essential cmake pkg-config libevent-dev libboost-dev libsqlite3-dev python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q . && git fetch -q --depth 1 https://github.com/ecash-com/bitcoin.git "$ECX_COMMIT" \
    && git checkout -q FETCH_HEAD && test "$(git rev-parse HEAD)" = "$ECX_COMMIT"
RUN cmake -S . -B build -DENABLE_IPC=OFF -DBUILD_TESTS=OFF -DBUILD_UTIL=OFF -DBUILD_TX=OFF \
      -DBUILD_WALLET_TOOL=OFF -DWITH_ZMQ=OFF -DBUILD_GUI=OFF
ARG JOBS
RUN cmake --build build -j"${JOBS:-$(nproc)}" --target bitcoind bitcoin-cli

FROM debian:bookworm-slim
RUN apt-get update -y && apt-get install -y --no-install-recommends libevent-2.1-7 libevent-extra-2.1-7 \
      libevent-pthreads-2.1-7 libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /src/build/bin/bitcoind /src/build/bin/bitcoin-cli /usr/local/bin/
RUN mkdir /data
ENTRYPOINT ["bitcoind", "-datadir=/data", "-regtest", "-server", "-mocktime=1791820800", "-txindex", "-listen=1", "-connect=0", "-dnsseed=0", "-discover=0", "-rpcbind=0.0.0.0", "-rpcallowip=0.0.0.0/0", "-rpcuser=regtest", "-rpcpassword=regtest", "-fallbackfee=0.00001", "-acceptnonstdtxn=0"]
