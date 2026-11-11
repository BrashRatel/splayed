# Advanced donor routes

Both routes use a **donor**: a coin that exists on only one chain. A transaction that spends your
shared coin _and_ a donor is invalid on the chains that have never seen the donor, so the shared
coin can be signed with an ordinary `SIGHASH_ALL` signature. Every donor transaction publicly links
the donor wallet to the coins it is spent with.

Both routes are opt-in. In the web UI, switch on **Advanced** in the tab bar to get a Donors tab,
read the rules and the linkage they create, and turn donor routes on (the UI refuses donor commands
until then). Then import the donor wallet, scan it, tick one or more donors, and fan them out or
plan the splits with them.

### What donors reveal

Blockchain analysis assumes the inputs of one transaction have one owner, and a donor route makes
that true in public:

- each donor transaction links the donor wallet to the coins it is spent with, and both to the
  destination its output goes to;
- `--batch all` links all those coins together too;
- donors made by one fan-out share a parent transaction, so they, and the coins later split with
  them, are linked to each other;
- a donor funded from somewhere else (an exchange, another wallet) links that source as well.

The guided route (ECX locktime, XBT `0x21`) creates none of these links.

## The XBT donor route

For stock hardware wallets, which can't make the 0x21 signature XBT needs. A donor here exists on
XBT only, so a transaction spending it is invalid on BTC and ECX.

```sh
deno task cli donor import '<donor wallet descriptor>'   # a separate wallet, funded on XBT only
deno task cli donor scan                                  # checks every donor on all three chains
deno task cli plan --donor <txid:vout> --donor <txid:vout> --chains ecx,xbt
```

Rules the tool enforces:

- A donor must be unspent and deep on XBT, and **absent** on BTC and ECX (an unanswered check is not
  "absent").
- Its origin must be provable: an XBT coinbase output (mature, 100 blocks), the output of an XBT
  split this tool verified and broadcast, or a donor **funded elsewhere** whose funding transaction
  the tool can trace on chain (see below). Anything else is refused as `unproven`, because a funding
  transaction signed without 0x21 could still be sent to BTC by whoever holds it, which would make
  the donor exist there and the spend replayable.
- One donor per XBT transaction. `--batch all` uses a single donor for all your coins.
- Every signature must be plain `SIGHASH_ALL` (or Taproot default). `ANYONECANPAY` and 0x21 are
  refused, so each signature commits to the donor input. Your signer must sign the donor input too:
  if its keys are in another wallet, sign with both in turn.
- `verify` still asks your nodes: the XBT node must accept and BTC and ECX must reject. `broadcast`
  checks again that the donor is absent from BTC and ECX, and refuses if it can't ask.

The donor's value goes to your XBT destination with the rest.

### Donors funded elsewhere

If another machine or wallet paid your donor wallet, `donor scan` reads the funding transaction from
the chain and accepts the donor (`verified-funding`) only when that transaction cannot be valid on
another chain: it carries a SIGHASH_UNIFIED (0x21) signature (XBT only), or one of its inputs was
made by a transaction that cannot be valid elsewhere, followed back (at most 6 levels, 40
transactions) to a coinbase of that chain or to a split this tool verified. A funding transaction
signed with plain `SIGHASH_ALL` from shared coins is refused: anyone holding it could still send it
to BTC. The scan shows how each donor was proven. When the donor's own scan already proved the coin
exists on its home chain only (see
[explicitly chain-specific coins](../reference/transaction-model.md#explicitly-chain-specific-coins)),
that proof is used instead of tracing again.

### Fan-out

Donors are usually big (a coinbase is 50 BTC on regtest), and each XBT transaction uses one.

```sh
deno task cli donor fanout --donor txid:vout --outputs 5 [--value SATS]
```

This splits a donor into smaller donors paid back to the donor wallet, one transaction per donor so
donors stay unlinked. `--value` sets the size of each new donor and returns the rest as change;
without it the donor is split evenly. Sign it with the donor wallet using plain `SIGHASH_ALL`,
verify and broadcast it like any plan, and scan again: its outputs are donors too, because the
fan-out spends nothing but an XBT-only donor. Fan-out also works on BTC donors.

## The BTC-first route

If you want to move your BTC copy first (say, off an old wallet), a BTC transaction would normally
replay onto XBT and ECX. A **BTC donor** prevents that the same way: a coin that exists on BTC only
(a BTC coinbase mined after the forks, or the output of a BTC transaction this tool verified and
sent), spent in the same transaction, so XBT and ECX reject it.

```sh
deno task cli dest set btc "wpkh([fp/84h/0h/2h]xpub.../0/*)"
deno task cli donor import "<BTC donor wallet descriptor>"
deno task cli donor scan                     # BTC donors are listed as "BTC donor"
deno task cli plan --btc-first --donor txid:vout [--donor ...]
```

The plan has three groups:

- `btc/` the BTC copy, plus one BTC donor per transaction, signed with plain `SIGHASH_ALL` by any
  wallet.
- `ecx/` the ECX copy with its locktime marker, as always.
- `xbt/` the XBT copy, signed with plain `SIGHASH_ALL` and **no replay protection of its own** (no
  0x21 signer needed). It is safe only because the coin is gone from BTC and ECX by then, so
  `broadcast` **holds it back** until the coin is spent and confirmed on both (it checks the plan's
  own BTC and ECX transactions, or the backend's spend details) and your own nodes reject it. Send
  BTC and ECX, wait for them, run `broadcast` again.

Stuck BTC transactions can be fee-bumped like any split (`bump <plan> --chains btc`; see
[recovery](recovery.md#stuck-transactions-fee-bump-rbf)): the replacement keeps its donor, and the
held-back XBT split waits for whichever of them confirms. Fan-outs can be bumped too; the extra fee
comes out of their last output.

## Trying it by hand

In the [regtest playground](../dev/regtest-playground.md), `deno task regtest donors '<descriptor>'`
mines XBT-only donors for a wallet. Add `--chain btc` for BTC-only donors (the BTC-first route).
