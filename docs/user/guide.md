# User guide (command line)

Prefer screenshots and no command line? Use the [Web UI guide](web-ui-guide.md). This page covers
the same steps for the CLI.

The full walkthrough for separating your coins: install, check the network, import your wallet,
scan, plan, sign, verify, broadcast and track. For the idea behind it, see the
[README](../../README.md). For flags, see the [CLI reference](../reference/cli.md).

The guided route is **forks first, BTC last**:

1. **ECX:** send each shared coin to yourself with the ECX marker. Any signer works, hardware
   wallets included.
2. **XBT:** send it to yourself with a 0x21 (`SIGHASH_ALL|SIGHASH_UNIFIED`) signature. This needs a
   signer that supports it (see [Signers](signers.md)). Stock hardware wallets can't make these
   signatures; the [advanced donor route](advanced-donor-routes.md) is the workaround.
3. **BTC:** once both splits are deeply confirmed, the BTC copy can be spent normally.

## Install and run

**Release binary** (Linux x86_64, bundles Tor, no install needed): download, verify and extract from
the [releases page](https://github.com/BrashRatel/splayed/releases) as described in the
[README](../../README.md#quick-start), then run `./splayed --help`. The commands below are the same
either way: swap `deno task cli` for `./splayed`.

**From source** (any platform Deno supports): requires [Deno 2.x](https://deno.com).

```sh
deno install
deno task cli --help
```

## First run: network settings come before anything else

```sh
deno task cli init
```

`init` shows where every query will go, then checks each backend is on the right chain. It asks only
for the chain tip and a few fixed block hashes, so nothing about your coins is sent. Importing and
scanning stay disabled until you confirm. Changing any network setting closes the gate again.

Defaults, Tor modes and using your own nodes are covered in
[Network and privacy](network-and-privacy.md).

## Import and scan

```sh
deno task cli import "wpkh([d34db33f/84h/0h/0h]xpub6.../<0;1>/*)#checksum" --label cold
deno task cli scan
deno task cli status        # or: status --json
```

`import` prints the first address of each branch. Check they match your wallet.

Supported descriptors:

- `pkh`, `wpkh`, `sh(wpkh)` and `tr` (key path);
- `sh`, `wsh` and `sh(wsh)` with `multi` or `sortedmulti`.

`ypub` and `zpub` keys are accepted and converted to xpub. Private keys, and bare 32-byte hex keys
(which could be one), are refused.

Not supported: miniscript, `combo()`, Taproot script trees, and any script with a timelock
(`after()`/`older()`, that is CLTV or CSV). A timelocked input needs its own `nLockTime` or
sequence, which can't be combined with the ECX replay marker, so splayed can't separate such coins.
`import` says so instead of failing obscurely.

Each coin gets one status:

| Status       | Meaning                                                          |
| ------------ | ---------------------------------------------------------------- |
| `shared`     | Unspent on two or more chains. The output lists the next steps   |
| `separated`  | Unspent on one chain; every other copy is deeply spent or absent |
| `pending`    | A spend is unconfirmed, shallow, or its depth can't be checked   |
| `unverified` | A chain couldn't be asked. Never treated as safe                 |
| `spent`      | Not unspent anywhere                                             |

A coin that exists on one chain only because of **how it was made** shows as `separated (XBT only)`
(or BTC, ECX), with the reason in the details. Its creating transaction can't be valid on the other
chains: it carries the XBT `0x21` signature or the ECX replay marker, it is a coinbase after the
forks, or it descends from such a transaction (one of this tool's splits, for example). Such a coin
can never turn up on the other chains later, so it counts as separated even when another chain's
server couldn't be asked. Coins that are merely absent elsewhere keep the ordinary status: their
creating transaction could still be broadcast there by someone holding it.

### Coins that turn up later

Coins can arrive after you have split: a deposit to an old address, or a pre-fork coin on an address
beyond the gap limit of an earlier scan. Such a coin is still shared, so spending its BTC copy would
replay onto the forks. Every `scan` compares itself with the previous one and prints a **NEW SHARED
COINS** block (also shown by `status`) for coins that are shared now but weren't in the previous
scan, or weren't shared then (a split that left the chain shows up here too). Don't spend them on
BTC until they are split: plan them like the others (`plan --coin txid:vout` plans only them; in the
web UI, **Plan these coins** on the Coins tab's banner). They stay listed, with when they were first
seen, until the split shows on the chains. They are saved in `scan.json` under `newShared`; the exit
code doesn't change for them. The first scan has nothing to compare with, and a scan right after
importing another wallet or raising the gap limit lists that wallet's shared coins: expected.

## Plan the splits (unsigned PSBTs)

```sh
# Where split coins go on each fork (best: a new seed per fork). Ranged descriptor, branch 0 used.
deno task cli dest set ecx "wpkh([fp/84h/0h/0h]xpub.../0/*)"
deno task cli dest set xbt "tr([fp/86h/0h/0h]xpub.../0/*)"
# Say what will sign XBT: knots, sparrow-blake2b, shrike, embit, privkeyio-firmware
deno task cli plan --xbt-signer knots --fee-rate ecx=2,xbt=3
```

For every coin the last scan saw as shared, `plan`:

1. re-checks the coin on the target fork;
2. fetches the previous transaction and checks it hashes to the right txid;
3. builds one PSBT per batch.

Options:

- `--batch coin` (default) keeps coins unlinked. `--batch address`, `--batch N` and `--batch all`
  combine coins, and the summary says which addresses that links publicly.
- `--batch linked` combines only coins that are **already linked on chain**, so it saves fees
  without revealing anything new: coins on the same address, and coins created by transactions that
  your wallet funded entirely and that spent from a common address of yours (directly or through a
  chain of them). A coin someone else paid you, or one from a coinjoin, stays on its own unless it
  shares an address. Only each coin's own funding transaction is read; anything it can't read stays
  apart.
- Fees come from `--fee-rate` or the backend's 6-block estimate. A batch whose fee would be over 10%
  of its value is skipped.

The smallest transaction on each chain is marked **TEST FIRST**. Destination addresses are reserved,
so re-planning never reuses one.

Plans go to `<data dir>/plans/<id>/` (`ecx/*.psbt`, `xbt/*.psbt`, `plan.json`, `README.txt`). What
each PSBT contains is documented in the [transaction model](../reference/transaction-model.md).

## Sign, verify, broadcast

Sign each PSBT in your wallet and save the result next to the original as `<name>.signed.psbt`.
Finalized PSBTs, partially signed PSBTs, and raw transaction hex (`.hex`/`.txn`) are all accepted.
For air-gapped signers, see [Signers](signers.md#air-gapped-signers-animated-qr).

**Multisig:** each cosigner signs the same unsigned PSBT, on their own. Save each result as its own
file next to the original (`cosigner-a.signed.psbt`, `cosigner-b.signed.psbt`, any names): `verify`
combines the signatures for the same transaction, and refuses until enough are present ("1 of 2
required signature(s)"). In the web UI each upload is merged into the one before it.

```sh
deno task cli verify <plan-id>          # or: verify <plan-id> path/to/signed files...
deno task cli broadcast <plan-id>
deno task cli track <plan-id>
```

`verify` checks that the signed transaction is exactly the planned one, that its replay protection
is intact, that every signature is valid on its own chain, and that the fee matches. With your own
node RPC backends it also asks every node: the target chain must accept and the others must reject.
The full list of checks is in the
[transaction model](../reference/transaction-model.md#what-verify-checks).

`broadcast` sends only verified transactions, each only to its own chain over its own Tor circuit.
On each chain the first run sends the **TEST FIRST** transaction alone. Run `track` until it
confirms, then `broadcast` again: it says where each TEST FIRST transaction is now (confirmed, in
the mempool, replaced by a fee bump, dropped, in conflict…) and asks before sending the rest.
`--yes` answers yes only while the TEST FIRST spend is confirmed or in the mempool; if it never went
out (not verified, rejected, in conflict, superseded…), `--yes` sends none of the rest and says why,
and answering yourself means answering a question that says so plainly. `--all` sends everything at
once. An unknown result (timeout, Tor failure) is recorded as unknown, never as failed, and is safe
to retry. Re-running is idempotent, and sends again a split that has dropped out of the mempool.
Details: [broadcast semantics](../reference/transaction-model.md#what-broadcast-does).

`track` shows confirmations against your configured depth, and warns (exit 1) about anything that
needs you: see [Recovery](recovery.md). An alert you have dealt with, or decided to leave, can be
acknowledged with `track <plan> --ack`; it is then shown muted. When the splits are deep, run
`scan`: the BTC copies then show as separated and can be spent normally. Keep scanning now and then
before you spend: a coin that turns up later is flagged as
[new and shared](#coins-that-turn-up-later).

## Starting over

`splayed wipe` forgets everything recorded about your coins: imported and donor descriptors, fork
destinations, scan results, every plan (PSBTs, signed files, progress) and the web UI's donor
opt-in. It resets the network confirmation, so you run `splayed init` again, and keeps your network
settings and any servers you added. It lists what goes and asks first. If a transaction you sent
isn't confirmed yet it warns and asks again, because `track` stops following it; with `--yes` it
refuses in that case unless you add `--force`. Nothing on any blockchain changes, and no keys are
involved. In the web UI this is the **Burn history** button.

## When something goes wrong

- A split disappears, is re-mined, or its input is spent by something else: see
  [Recovery](recovery.md#reorgs).
- A split that was sent never confirms and drops out of the mempool: see
  [Recovery](recovery.md#dropped-from-the-mempool).
- A split is stuck at too low a fee: see [Recovery](recovery.md#stuck-transactions-fee-bump-rbf).

## Before real coins

Read [TODO.md](../../TODO.md) for open work and known issues. Start with one small coin.
