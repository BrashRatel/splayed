# Releasing: bundling Tor

For maintainers and release builds. Users don't need this; forksplit falls back to a `tor` on `PATH`
(see [Network and privacy](../user/network-and-privacy.md#tor)).

```sh
deno task update-tor-manifest 15.0.1   # pin hashes after verifying the Tor Browser team's GPG signature
deno task fetch-tor --all              # download Tor Expert Bundles, check SHA-256, unpack to vendor/tor/
deno task compile                      # dist/forksplit; ship it next to vendor/tor/
```

`fetch-tor` refuses anything that isn't pinned in `vendor/tor-manifest.json`. That file pins Tor
Browser 16.0 (tor 0.4.9.15). Re-pin with `update-tor-manifest` after checking the signature
yourself.

Before tagging a release, work through the release gates (section 1) in [TODO.md](../../TODO.md) and
update [CHANGELOG.md](../../CHANGELOG.md).
