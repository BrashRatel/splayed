# Recovery: reorgs, dropped and stuck transactions

## Reorgs

`track` remembers the block each split was confirmed in. If a later `track` finds that a split that
was confirmed has changed, it says so loudly and exits with status 1:

| What happened                                                                                    | What `track` says                                                         |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Re-mined in a different block (a reorg)                                                          | `REORG`, with the old and new block. Still confirmed; depth restarts      |
| Back in the mempool                                                                              | `REORG`: back in the mempool                                              |
| Gone from the chain and the mempool, input unspent again                                         | `REORG`: the coin is shared with BTC again. `broadcast` can send it again |
| Input spent by a different transaction (an outside spend, or a BTC spend replayed onto the fork) | `CONFLICT`. The split is marked conflicting and will not be re-sent       |
| Input spent by one of your own fee bumps or plans                                                | No alarm: `REPLACED by plan …` or `superseded by plan …`, see below       |

Blocks are named by height and the last 8 hex digits of their hash (the first digits are zeros on
every real block).

`track` records the depth as it is now: a split that left its block shows depth 0 (in the web UI
"back in the mempool (was N conf)" or "not on the chain (was N conf)"), so it can be fee-bumped
again and `plans delete` keeps refusing the plan. The warning repeats on every `track` until the
split is in a block again; once it (or the fee bump that replaced it) is confirmed to the required
depth, the alert is marked resolved (muted in the web UI).

Every open alert keeps `track` at exit status 1 until it is resolved, including a split that is in a
block again but not yet deep enough (`… is still open (now: 1 of 50)`).

A split that left the chain is sent again by **Broadcast verified** (`broadcast <plan>`): its bytes
are verified again, the backend's identity is checked and its inputs must be unspent, as for any
broadcast.

### Conflicts: whose spend was it?

Before calling a spent input a `CONFLICT`, `track` and `broadcast` look the spending transaction up
among the verified transactions of all your plans (archived ones too):

- **One of its own fee bumps** (or a bump of a bump): the split is marked `replaced`, any `CONFLICT`
  it was given is withdrawn, and `track` follows the replacement. This also covers a bump whose send
  reply was lost.
- **Another of your plans** (the same coin planned twice, and the other plan got there first): the
  split is marked `superseded by plan …`. That is a note, not an alarm: nothing is sent or bumped
  for it again, and the plan can be deleted once the other plan's transaction is confirmed deep
  enough (`track` records how deep).
- **Anything else**: `CONFLICT`. The likely causes, most likely first: the coin was spent with
  another wallet or tool (a fork wallet, say); an ordinary BTC spend of it was replayed onto the
  fork; only if neither applies, the key may be compromised. A backend that can't name the spender
  (node RPC without `txindex`) is said to be unable to, rather than implying a stranger.

A split marked conflicting whose own transaction later shows up confirmed deep enough goes back to
`accepted`.

## Dropped from the mempool

A split can be sent and accepted, never confirm, and then fall out of every mempool: nodes drop a
transaction whose fee rate falls below their mempool minimum (a busy mempool), or that has waited
too long (mempool expiry, two weeks by default). Its inputs are unspent again, so **the coin is
still shared with BTC**.

`track` says so with a `DROPPED` alert and exits with status 1:

```text
ECX ecx/002-6a237fcf.psbt: DROPPED: This split was in the mempool (last seen 2026-11-02 13:42 UTC)
but never confirmed, and it is no longer in the mempool or on the chain. ...
```

`track` remembers when it last saw the split in the mempool (`unmined` in `progress.json`; the web
UI shows "dropped from the mempool (last seen …)" under the transaction, the alert above the plan,
and the **Fee bump…** button). A send whose result was unknown and that is not on the network is
reported the same way ("it never arrived, or it was dropped"). A split that no mempool has shown yet
gets 10 minutes after its send before it is called dropped, because the server `track` asks may not
have it yet.

What to do:

- **Send it again**: **Broadcast verified** (`broadcast <plan>`). A transaction that was sent before
  is asked about on the chain and is sent again only if it is in neither a block nor the mempool and
  its inputs are unspent, with all the usual checks. The TEST FIRST step applies as usual.
- **Or replace it** if the fee was too low: **Fee bump…** (`bump <plan>`), see below.

The split still counts as sent: `plans delete` refuses the plan, and the coin shows as "in plan … ·
broadcast" in the coin picker, because it may come back. The alert stays open (and `track` keeps
exiting 1) until the split, or the fee bump that replaced it, is confirmed deep enough.

If a fee bump that replaced a split is the one that drops out, `track` on the original plan says so
too, and names the bump plan to send again; the original vanishing is expected and never alarms.

### When the chain can't be asked

"Dropped" is never concluded from a failed or ambiguous lookup. The split must be absent from both
the chain and the mempool **and** every one of its inputs must be seen unspent; anything else is
`unknown` or a conflict. When a lookup fails (a server error, a timeout), `track` shows
`? (lookup failed)` for that transaction, leaves its record as it was, carries on with the others
and exits 1; `broadcast` doesn't send it again. Per backend:

- **Esplora**: asks for the transaction's status, then checks it exists (some eCash servers answer
  "unconfirmed" for any txid). An HTTP error in either step is a failed lookup, not an answer.
- **Electrum**: a "not found" answer for the transaction, then the input's own state from the
  server's index.
- **Node RPC**: without `txindex` the node can't say whether a transaction was ever confirmed, but
  an input that is unspent in its UTXO set proves the split is in neither a block nor the mempool,
  so a drop is still recognised; if the input can't be found, the answer is `unknown`.

Until every split is confirmed again, leave the BTC copies alone. `scan` also warns when a spend it
saw last time has disappeared or been replaced by a different transaction.

Reorg detection needs a backend that can report a transaction's own status: Esplora, Electrum, or
node RPC. Node RPC without `txindex` can't tell a confirmed transaction from one that never existed,
so `track` shows `unknown` rather than guessing.

## Stuck transactions: fee bump (RBF)

Every planned transaction signals RBF. If one is stuck at too low a fee:

```sh
deno task cli bump <plan> --fee-rate ecx=6,xbt=8   # or leave --fee-rate off for an estimate
deno task cli verify <plan>-bump1
deno task cli broadcast <plan>-bump1
```

`bump` writes a new plan whose transactions spend the **same inputs** to the **same destination** at
a higher fee, from the original's own unsigned PSBT. Only the output value changes: inputs,
sequences, locktime (the ECX marker) and the 0x21 request are copied, so the replacement is
replay-protected exactly like the original. Sign it in your wallet and `verify` it like any plan.

- It must follow BIP125: at least the old fee plus 1 sat/vB for its own size. A lower `--fee-rate`
  is refused, and the message says the minimum.
- Only transactions that are broadcast and not yet confirmed can be bumped. A confirmed one, one
  whose input was spent by something else, or one already replaced is refused.
- `--chains ecx` and `--tx N` limit what is bumped. Without `--fee-rate`, the rate is the backend's
  estimate, at least 1.5x the old rate.
- When the replacement is sent (or found on the network later, if the reply was lost), the original
  is marked `replaced`, with the replacement's txid, and `track` shows `REPLACED by plan ...`. A
  replacement can be bumped again (`bump <bump plan>`); `track` follows the chain of bumps
  (`REPLACED by plan C (via B)`). If the original confirms first, the replacement is refused and
  `track` says so.
- A bump plan that an original points to can't be deleted while the original's plan isn't archived:
  `track` and `broadcast` follow it there.
- One replacement at a time: while a bump plan for a transaction is written but not sent, `bump`
  refuses that transaction and names the plan (sign and broadcast it, or `plans delete` it first;
  `--another` writes another anyway; `--yes` only skips the prompt). The web UI shows "bump written:
  plan … (not sent yet)" instead of the **Fee bump…** button.
- Bumping the TEST FIRST transaction is fine: **Broadcast verified** on the original plan says where
  the replacement is (following bumps of bumps) and asks before sending the rest.
- Fee bumps are not supported for BTC transactions yet.

### Dropping a coin from a batch

A `--batch all` transaction replaces as a whole. To bump it without one of its coins, name that
coin:

```sh
deno task cli bump <plan> --tx 1 --drop txid:vout [--drop ...]
```

The dropped coin is not spent by the replacement and stays available for a later plan. At least one
input must stay (that is what makes it a replacement) and a donor input can't be dropped. The
replacement is sized for the smaller transaction, and still has to beat the original's fee.

## Child pays for parent (CPFP)

If the original can't be replaced (a node without full RBF and a transaction that didn't signal it),
lift it from below instead:

```sh
deno task cli bump <plan> --cpfp --tx 1 --fee-rate ecx=20,xbt=20   # the rate for the PAIR
```

This writes a child that spends the split's output to a fresh address of the same destination, so
parent and child together pay about that rate. Sign it with the **destination** wallet (it spends
the split's output), then `verify` and `broadcast` the new `-cpfp` plan. The child can only exist on
its parent's chain, so it needs no replay protection of its own: an XBT child is signed with plain
`SIGHASH_ALL`.
