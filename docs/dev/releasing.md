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
pinned Tor bundle, and writes `.tar.gz` archives (`.zip` for Windows) plus `SHA256SUMS`. Add the
StartOS packages (below) to `dist/release/`, rebuild the sums with `sha256sum` over every file
except `SHA256SUMS`, then sign them yourself: `gpg --detach-sign --armor SHA256SUMS`. The Linux
x86_64 and Windows x86_64 archives have been run from a clean extract; run the macOS and Linux
aarch64 ones on their platforms first.

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

## Release checklist

Order matters: the StartOS package pins a splayed commit, so splayed is merged and tagged first, the
package is built against that tag, and the packages are added to the release last. `X` below is the
version, for example `0.1.0-pre-alpha.2`; the tag is `vX`.

Tools: `deno`, `docker` with the buildx builder above, `zip`, `tar`, `gpg` with the key in
[SECURITY.md](../../SECURITY.md), `gh`, `node`/`npm`, `jq`, and `start-cli` 2.x
(`start-cli --version`; the 0.3.x one has no `s9pk` commands). The workspace is
`../start9-workspace` (see above) and the package repo is cloned beside this one as
`../splayed-startos`.

1. **Prepare on the release branch.**
   - Check [TODO.md](../../TODO.md) for open bugs (section 1) and move finished items to the
     [archive](todo-archive.md).
   - Re-run the sensitive-information search on the tree and on the history since the last tag:
     personal paths, email addresses, private keys (`xprv`, WIF, PEM), secret-looking assignments,
     secret-type file names, onion hosts and IPs, and the PNG metadata of the screenshots. The last
     run (see the archive) lists what to expect: public test vectors, the public security contact,
     and the public mempool onion hosts.
   - Bump `version` in `deno.json` and `package.json`, change the version in the README download
     commands and the tester-report template, write `docs/release-notes/X.md`, and give the
     CHANGELOG's Unreleased heading the version and date.
   - `deno task check`, `deno task lint`, `deno fmt --check` and `deno task test`; the regtest suite
     (`deno task test:integration`) when anything near the signing or backend code changed.
2. **Merge.** Open a PR from the release branch to `main` so the CI jobs run (`gh pr create`), wait
   for green, then merge it (`gh pr merge --merge`, not squash: the tag should sit on the commits
   that were tested). Then `git checkout main && git pull`.
3. **Tag** `main`: `git tag vX && git push origin vX`. Don't create the GitHub release yet; the tag
   is the pin for the package. (If something is found later, delete the tag and re-cut it before
   anyone has downloaded anything; after that, make a new version.)
4. **Build the StartOS package.** `start-cli s9pk pack` only runs inside a packaging workspace (a
   folder made by `start-cli s9pk init-workspace` that holds the package repo), so a plain clone
   like `../splayed-startos` can edit and push but not build. Build in the workspace's clone,
   `../start9-workspace/splayed-startos`, once the package change is merged:
   - In `../splayed-startos` (`master`): first `git pull` (the workspace clone falls behind GitHub,
     and the next revision number comes from `origin/master`'s `startos/versions/current.ts`, not
     the local one), `git submodule update --init`, then
     `git -C upstream-project fetch --tags origin && git -C upstream-project checkout vX`.
   - Edit `startos/versions/current.ts`: version
     `<splayed version without the pre-release part>:<n>` (`0.1.0:7` is the revision after
     `0.1.0:6`; it counts up per package change) with release notes in all five locales. Check
     upstream's CHANGELOG for changes to the env variables, `ui` flags or the backend-detect command
     that `startos/main.ts` relies on (see its `UPDATING.md`).
   - Commit on a branch, open a PR to `master` (its Build workflow packs both architectures), merge
     it, then in the workspace clone: `git pull && git submodule update --init`.
   - Build from that clean checkout, so the package's git hash has no `-modified` suffix:
     ```sh
     cd ../start9-workspace/splayed-startos
     npm ci --ignore-scripts && npx tsc --noEmit
     make x86 arm        # splayed_x86_64.s9pk and splayed_aarch64.s9pk; about 4 GB of Docker storage
     start-cli s9pk inspect splayed_x86_64.s9pk manifest | grep '"version"'
     ```
   - Install `splayed_x86_64.s9pk` on a StartOS server (System > Sideload) over the previous
     version, because updates are where package bugs show (the RPC login task once came back on
     every update). Check the Web UI, the token, node detection and a Tor scan. Install the aarch64
     one when an arm device is at hand and say so in the release notes if it wasn't. A same-version
     sideload may be refused: bump the revision for every rebuild you install.
5. **Build the release files** (back in this repo, on the tag):
   ```sh
   deno task fetch-tor --all
   deno task package                       # dist/release/ with the five platform archives
   cp ../splayed-startos/splayed_x86_64.s9pk  dist/release/splayed-X-startos-x86_64.s9pk
   cp ../splayed-startos/splayed_aarch64.s9pk dist/release/splayed-X-startos-aarch64.s9pk
   cd dist/release && rm SHA256SUMS
   sha256sum $(ls | grep -v -E '^SHA256SUMS') > SHA256SUMS
   gpg --detach-sign --armor SHA256SUMS    # you sign; writes SHA256SUMS.asc
   gpg --verify SHA256SUMS.asc SHA256SUMS && sha256sum -c SHA256SUMS
   ```
   The release page lists exactly these files: the five archives, the two `.s9pk` files,
   `SHA256SUMS` and `SHA256SUMS.asc`.
6. **Publish.**
   ```sh
   gh release create vX --prerelease --title "splayed X" --notes-file docs/release-notes/X.md \
     dist/release/*
   ```
   Then download the files again from the release and verify the signature and sums from the
   download, not the local build. (A publish to a StartOS registry is not part of this checklist
   yet.)
7. **After:** note the release and what was checked in the [archive](todo-archive.md), and remove
   the finished items from [TODO.md](../../TODO.md).
