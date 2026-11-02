# CLI reference

Run commands as `deno task cli <command>` (or `splayed <command>` from a compiled build). Run with
`--help` for the same summary. The workflow is in the [User guide](../user/guide.md).

## Global options

| Option                  | Env                 | Meaning                                 |
| ----------------------- | ------------------- | --------------------------------------- |
| `--data-dir DIR`        | `SPLAYED_DATA_DIR`  | Where config, wallet and plans live     |
| `--tor-socks HOST:PORT` | `SPLAYED_TOR_SOCKS` | Use this Tor SOCKS endpoint             |
| `--profile ID`          | `SPLAYED_PROFILE`   | Network profile                         |
| `--json`                |                     | Machine-readable output where supported |
| `-h`, `--help`          |                     | Show help                               |

`SPLAYED_TOR_BINARY` selects the Tor binary (see
[Network and privacy](../user/network-and-privacy.md#tor)).

## Setup

| Command                                                                        | Purpose                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init [--yes]`                                                                 | Review network settings, check each backend is on the right chain, and confirm. Required before `import`/`scan`.                                                                                                                                          |
| `config show`                                                                  | Show the effective network settings.                                                                                                                                                                                                                      |
| `config backend add <chain> --kind esplora\|rpc\|electrum --url URL [options]` | Add a backend. Options: `--proxy tor\|none\|socks5://h:p`, `--ca-file PEM`, `--role read\|broadcast\|both`, `--priority N`, `--cookie-file PATH`, `--user U --password-env VAR`, `--label TEXT`. Electrum URLs: `ssl://host:50002` or `tcp://host:50001`. |
| `config backend remove <chain> <url>`                                          | Remove a backend.                                                                                                                                                                                                                                         |
| `config backend reset <chain>`                                                 | Go back to the profile's default backend.                                                                                                                                                                                                                 |
| `config backend fallback <chain>`                                              | Add the profile's fallback backend to the list.                                                                                                                                                                                                           |
| `config clearnet <chain> on\|off`                                              | Allow direct (non-Tor) connections to public hosts.                                                                                                                                                                                                       |
| `config tor auto\|managed\|system [host:port]`                                 | Tor mode (see [Network and privacy](../user/network-and-privacy.md#tor)).                                                                                                                                                                                 |
| `config confirmations <chain> N`                                               | Depth required before a spend counts as final.                                                                                                                                                                                                            |
| `config scan [--gap-limit N] [--jitter MIN-MAX]`                               | Unused addresses checked past the last used one (1-1000, default 20), and the random pause in ms between lookups on remote backends (default 150-900). Re-locks until `init`. Also on the Network tab under **Scan settings**.                            |

`<chain>` is `btc`, `xbt` or `ecx`.

## Coins

| Command                           | Purpose                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `import <descriptor> [--label L]` | Add a watch-only output descriptor (xpub-based).                                        |
| `descriptors`                     | List imported descriptors.                                                              |
| `forget <number>`                 | Remove an imported descriptor (number from `descriptors`).                              |
| `scan [--rpc-range N]`            | Find your coins on all three chains and cross-check them. `--rpc-range` is 1 to 100000. |
| `status [--json]`                 | Show per-coin state from the last scan (no network).                                    |

## Splitting

| Command                                                     | Purpose                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dest set <xbt\|ecx> <descriptor> [--start-index N]`        | Where split coins go on that fork. Must be a ranged descriptor (ends in `/*`). `btc` is also accepted for the [BTC-first route](../user/advanced-donor-routes.md#the-btc-first-route).                                                                                                                                                                                     |
| `dest show`                                                 | Show destinations.                                                                                                                                                                                                                                                                                                                                                         |
| `plan --xbt-signer NAME \| --donor txid:vout ... [options]` | Write unsigned, replay-protected PSBTs for shared coins.                                                                                                                                                                                                                                                                                                                   |
| `plans`                                                     | List written plans; archived ones are listed separately.                                                                                                                                                                                                                                                                                                                   |
| `plans archive <plan>` / `plans unarchive <plan>`           | Hide a plan from the list (and the Plans tab) or bring it back. The folder stays on disk: the donor rules and fee-bump tracking read it. Archiving acknowledges the plan's open alerts (see `track --ack`).                                                                                                                                                                |
| `plans delete <plan> [--yes]`                               | Delete a plan's folder for good, after a confirmation. Refused while any of its transactions was sent and isn't confirmed to the chain's required depth (a fee-bumped original never is: archive it instead). Takes a plan id only, never a path.                                                                                                                          |
| `verify <plan> [signed files...] [--no-mempool]`            | Check signed PSBTs/transactions. See [what verify checks](transaction-model.md#what-verify-checks).                                                                                                                                                                                                                                                                        |
| `broadcast <plan> [--all] [--yes]`                          | Send verified transactions. `--yes` answers the TEST FIRST question only while the test spend is confirmed or in the mempool; otherwise the rest waits (exit 1). `--all` sends everything at once. See [what broadcast does](transaction-model.md#what-broadcast-does).                                                                                                    |
| `track <plan> [--ack [--yes]]`                              | Confirmations of broadcast transactions; warns (exit 1) on reorgs, splits dropped from the mempool and conflicts, and while any such alert is open. `--ack` acknowledges the open alerts after asking (`--yes` skips the question): they stay on record, are shown muted and no longer set exit 1. See [acknowledging alerts](../user/recovery.md#acknowledging-an-alert). |

### `plan` options

| Option                          | Meaning                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `--xbt-signer NAME`             | `knots`, `sparrow-blake2b`, `shrike`, `embit`, `privkeyio-firmware`.            |
| `--donor txid:vout`             | Use a donor (repeatable). See [donor routes](../user/advanced-donor-routes.md). |
| `--btc-first`                   | Plan the BTC-first route (needs `--donor` and a `btc` destination).             |
| `--chains ecx,xbt`              | Limit which chains are planned.                                                 |
| `--batch coin\|address\|all\|N` | `coin` (default) keeps coins unlinked; the others combine coins.                |
| `--fee-rate ecx=2,xbt=3`        | Per-chain sat/vB; default is the backend's 6-block estimate.                    |
| `--coin txid:vout`              | Plan only these coins (repeatable).                                             |
| `--yes`                         | Skip confirmation prompts.                                                      |

## Recovery

| Command                                                                        | Purpose                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------- |
| `bump <plan> [--chains ecx,xbt] [--tx N ...] [--fee-rate ecx=5,xbt=8] [--yes]` | RBF replacement plan at a higher fee.             |
| `bump <plan> ... --another`                                                    | Write one even though a bump is unsent.           |
| `bump <plan> --tx N --drop txid:vout [--drop ...]`                             | Replace one batch transaction without some coins. |
| `bump <plan> --cpfp [--chains ...] [--tx N ...] --fee-rate ecx=20`             | Child-pays-for-parent; the rate is for the pair.  |

See [Recovery](../user/recovery.md).

## Donors

| Command                                                                                    | Purpose                                                             |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `donor import <descriptor> [--label L]`                                                    | Add a donor wallet.                                                 |
| `donor list` / `donor show`                                                                | List donor wallets / show scanned donors.                           |
| `donor forget <number>`                                                                    | Remove a donor wallet.                                              |
| `donor scan [--rpc-range N]`                                                               | Check every donor on all three chains and show how each was proven. |
| `donor fanout --donor txid:vout ... --outputs N [--value SATS] [--fee-rate xbt=N] [--yes]` | Split donors into smaller ones.                                     |

See [Advanced donor routes](../user/advanced-donor-routes.md).

## Web UI

| Command                  | Purpose                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `ui [--port N] [--open]` | Local web interface (127.0.0.1 only) running these same commands. |

See [Web UI](../user/web-ui.md).
