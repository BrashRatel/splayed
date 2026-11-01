# Security

Splayed builds and broadcasts transactions that move real coins. Please report vulnerabilities
**privately**, not in a public issue.

## Reporting

- **Email:** brash@in-btc.com
- **Encrypted (preferred for anything exploitable):** use the maintainer's PGP key.
  - Fingerprint: `E6D1 FC88 69F4 317E 0AEF  C588 51E2 C57C 67FA 2A4A`
  - Key:
    <https://keybase.io/brashratel/pgp_keys.asc?fingerprint=e6d1fc8869f4317e0aefc58851e2c57c67fa2a4a>
  - Import it and check the fingerprint before trusting it: `curl -sS "<key URL>" | gpg --import`
    then `gpg --fingerprint brash@in-btc.com`.

Please include what you found, the version or commit, and steps to reproduce. Never send real seeds,
private keys or descriptors (xpubs) for coins you care about; use regtest or a throwaway wallet.

## What to expect

Splayed is **pre-alpha** and maintained by one person, so these are goals, not guarantees:

- an acknowledgement within 7 days;
- a fix or a mitigation plan within 90 days, with coordinated disclosure: please don't publish
  details until a fix is released or 90 days have passed, whichever comes first;
- credit in the changelog if you want it.

Bugs that are not security issues (wrong output, crashes, a signer that doesn't work) belong in a
normal [issue](https://github.com/BrashRatel/splayed/issues/new/choose).

## Scope

The most sensitive parts:

- `src/core/sigcheck.ts`: signature verification and final transaction assembly.
- `src/core/planner.ts` and `src/core/psbt.ts`: replay markers, sighash types and PSBT contents.
- `src/core/profiles.ts`: pinned replay constants and chain checkpoints.
- `src/net/`: Tor/SOCKS routing, the no-clearnet-fallback policy, and the HTTP client.
- `src/ui/server.ts`: the local web UI's access controls.

## Known limitations

See [TODO.md](TODO.md). In short:

- Nothing has moved real coins on mainnet yet, and the code has not had an independent security
  review.
- Backends have been tested against regtest nodes and a few default servers, not against every kind
  of real server.
