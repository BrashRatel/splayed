# Releasing: bundling Tor

For maintainers and release builds. Users don't need this; splayed falls back to a `tor` on `PATH`
(see [Network and privacy](../user/network-and-privacy.md#tor)).

```sh
deno task update-tor-manifest 15.0.1   # pin hashes after verifying the Tor Browser team's GPG signature
deno task fetch-tor --all              # download Tor Expert Bundles, check SHA-256, unpack to vendor/tor/
deno task compile                      # dist/splayed for this machine; ship it next to vendor/tor/
deno task package                      # every platform's archive and SHA256SUMS in dist/release/
```

`deno task package [out-dir] [--only name,name]` (`scripts/package_release.ts`; it needs `zip` and
`tar` installed, and `--only` builds just the named platforms) cross-compiles Linux x86_64 and
aarch64, macOS arm64 and x86_64 and Windows x86_64 from one Linux machine, adds each platform's
pinned Tor bundle (Linux aarch64 has none yet and needs `tor` on `PATH`), and writes `.tar.gz`
archives (`.zip` for Windows) plus `SHA256SUMS`. Add the StartOS packages (below) to
`dist/release/`, rebuild the sums with `sha256sum` over every file except `SHA256SUMS`, then sign
them yourself: `gpg --detach-sign --armor SHA256SUMS`. Only the Linux x86_64 archive has been run
from a clean extract; run the others on their platforms first.

The Windows and macOS bundles don't get the generic `README.md`. They get `README.txt` and a
double-click launcher from `packaging/windows/` and `packaging/macos/` (`{{VERSION}}` is filled in;
the Windows files are written with CRLF line endings, the macOS `.command` file is made executable).
Edit those files, not the packager, to change the wording.

## Docker and StartOS images

```sh
# a builder that can export OCI images and build for arm64 (one time; needs QEMU binfmt for arm64:
#   docker run --privileged --rm tonistiigi/binfmt --install arm64)
docker buildx create --name splayed-builder --driver docker-container --bootstrap --use
docker buildx build -f docker/Dockerfile --platform linux/amd64,linux/arm64 -o type=oci,dest=splayed.oci.tar .
```

The StartOS package is built in the separate `splayed-startos` repo, inside a packaging workspace
(`start-cli s9pk init-workspace` in the folder that holds the repo) with a `start-cli` from the 2.x
line (the 0.3.x one has no `s9pk` commands) and the buildx builder above: `make x86` and `make arm`
make `splayed_x86_64.s9pk` and `splayed_aarch64.s9pk`. Both need about 4 GB free for Docker's
storage.

`fetch-tor` refuses anything that isn't pinned in `vendor/tor-manifest.json`. That file pins Tor
Browser 16.0 (tor 0.4.9.15). Re-pin with `update-tor-manifest` after checking the signature
yourself.

Before tagging a release, check [TODO.md](../../TODO.md) for open bugs (section 1), move finished
items to the [archive](todo-archive.md), and update [CHANGELOG.md](../../CHANGELOG.md).
