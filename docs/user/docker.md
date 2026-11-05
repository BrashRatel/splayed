# Running splayed in Docker

The image runs the web UI behind Docker's port mapping (proxied mode, see the
[CLI reference](../reference/cli.md)), or any CLI command. Keys never enter the container: it holds
your watch-only descriptors, scans and plans, and your wallet signs as usual.

## Start

```sh
docker compose -f docker/compose.yml up -d --build
docker compose -f docker/compose.yml exec splayed cat /data/ui-token   # your access token
```

Open <http://localhost:8080/> and paste the token on the sign-in screen. It's kept for that browser
tab only.

What the compose file sets up:

- **Port:** published on `127.0.0.1` only. Don't change it to `0.0.0.0` on an untrusted network: the
  UI then travels over plain HTTP. Put a TLS reverse proxy in front instead, and add the proxy's
  host name to `SPLAYED_UI_ALLOWED_HOSTS`.
- **Data volume:** everything lives in the `splayed-data` volume (`/data`): config, watch-only
  wallet, scans, plans, signed PSBTs and the access token. Back it up like any wallet file; it
  reveals your addresses.
- **Hardening:** the container runs as a non-root user with a read-only root filesystem, no Linux
  capabilities and `no-new-privileges`.
- **Tor:** public backends are reached over Tor, which splayed starts inside the container. Local
  and LAN nodes (your own) are reached directly.

## CLI commands

Any splayed command runs in the same container and volume:

```sh
docker compose -f docker/compose.yml run --rm splayed status
docker compose -f docker/compose.yml run --rm splayed config backend detect --kind rpc \
  --url http://192.168.1.10:8332 --cookie-file /data/node.cookie --add
```

Files you want splayed to read (a node's cookie file, a CA certificate) must be inside the
container. Copy them into the volume, or add a read-only bind mount in an override file.

## A node on the Docker host

Inside the container, `127.0.0.1` is the container itself, so a node that listens only on the host's
loopback (the usual `rpcbind=127.0.0.1`) can't be reached from the default bridge network. Either
make the node listen on an address the container can reach (and allow that address with
`rpcallowip`), or run the container with `network_mode: host` in an override file. With host
networking the container shares the host's ports, so set `SPLAYED_UI_LISTEN: "127.0.0.1:8080"` to
keep the UI on loopback, and give the node as `http://127.0.0.1:PORT`. Pass an RPC password as an
environment variable (`--user NAME --password-env VAR`, with the variable set in the override file's
`environment` or an `env_file`); a cookie file must be copied into the volume.

## Host names

The UI answers only to the host names in `SPLAYED_UI_ALLOWED_HOSTS`, exactly as your browser sends
them (`name` or `name:port`). For example, add `splayed.home.lan` if a reverse proxy serves it
there. Any other name gets `403 Forbidden`. Change the variable and restart the container.

## Your data, and starting over

Everything is in the `splayed-data` volume, so it survives restarts, rebuilds and image updates.
Only removing the volume (`docker compose down -v`) erases it. To forget your wallet, scans and
plans but keep your servers and settings (the web UI's **Burn history** button does the same):

```sh
docker compose -f docker/compose.yml exec splayed splayed wipe
```

## A new access token

```sh
docker compose -f docker/compose.yml exec splayed splayed ui --new-token-file /data/ui-token
docker compose -f docker/compose.yml restart splayed
```

Open pages then ask you to sign in again.

## Tor in its own container

```sh
docker compose -f docker/compose.yml -f docker/compose.tor.yml up -d --build
```

This adds a `tor` container (Debian's Tor, SOCKS on the compose network only) and sets splayed to
`SPLAYED_TOR_MODE=system` with `SPLAYED_TOR_SOCKS=tor:9050`:

- **Fail closed:** splayed uses only that Tor and never starts its own, so if it's down, queries to
  public backends fail.
- **Circuit isolation:** Tor keeps `IsolateSOCKSAuth` on by default, so splayed's separate circuits
  per chain and per broadcast still apply.

## Images for other platforms

```sh
docker buildx build -f docker/Dockerfile --platform linux/amd64,linux/arm64 -t splayed .
```

The build compiles splayed for each platform with `deno compile` and installs Tor from Debian's
signed repository. The first build downloads the Deno runtime, Debian packages and npm dependencies.
`--build-arg WITH_TOR=0` leaves Tor out of the image, for hosts that run their own Tor; then set
`SPLAYED_TOR_MODE=system` and `SPLAYED_TOR_SOCKS` (the StartOS package does this).
