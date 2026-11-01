# Signers

splayed never holds keys. Your wallet signs the PSBTs it writes. Which wallet you can use depends on
the chain.

| Chain | Needs                                                      | Works with                                                                                        |
| ----- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| ECX   | Any signer. The marker is in the locktime and sequence.    | Everything, including stock hardware wallets.                                                     |
| XBT   | A signer that makes `SIGHASH_ALL\|SIGHASH_UNIFIED` (0x21). | Bitcoin Knots wallet, the Sparrow BLAKE2b build, Shrike, embit, privkeyio-firmware.               |
| BTC   | Any signer, after the forks are split and deep.            | Everything. Before that, use the [BTC-first route](advanced-donor-routes.md#the-btc-first-route). |

Tell `plan` which signer will sign XBT so the PSBT is shaped for it:

```sh
deno task cli plan --xbt-signer knots
```

Valid names: `knots`, `sparrow-blake2b`, `shrike`, `embit`, `privkeyio-firmware`.

## Stock hardware wallets and XBT

They can't make 0x21 signatures. Options:

- Use the [XBT donor route](advanced-donor-routes.md#the-xbt-donor-route), which needs only plain
  `SIGHASH_ALL`.
- Move the XBT copy with a software signer from the list above.

`verify` catches a signer that quietly signs plain `SIGHASH_ALL` for an XBT split, because such a
transaction would also be valid on BTC.

## Air-gapped signers (animated QR)

In the web UI each transaction has a **QR** button and a **Scan signed** button.

- **QR** plays the unsigned PSBT as a looping animation of QR codes (Uniform Resources, type
  `crypto-psbt`, the format Keystone, Passport, Jade, SeedSigner and others read).
- The signer shows its own animated QR codes for the signed transaction.
- **Scan signed** reads them through the camera and saves the result exactly like an uploaded file,
  so the usual `verify` follows.

Frames can be scanned in any order, repeated, or missed: the stream carries extra "fountain" frames,
and a misread frame is skipped.

Notes:

- Browsers only allow the camera on `localhost` or `127.0.0.1`, so open the UI there (not at a LAN
  address).
- Plain base64 QR codes and the BBQr format are not supported yet.
- The coding is in `src/core/ur.ts`, checked frame for frame against the reference implementation.
  QR drawing and reading use two small vendored libraries in `src/ui/static/vendor/` (pinned by
  checksum).

### SeedSigner

SeedSigner reads and writes `crypto-psbt` the same way splayed's **QR** and **Scan signed** buttons
do, so the flow is the same for both forks: scan the unsigned PSBT with the device, check what it
shows, sign, then scan its signed QR back into splayed.

**ECX** needs no special firmware. Stock SeedSigner signs with a plain signature, which is all the
ECX marker needs:

1. In the splayed UI, open the plan and click **QR** on the ECX transaction.
2. On SeedSigner: `Scan` the animated QR. It parses the PSBT and shows the transaction to review.
3. Check the output amount and address against the plan before approving — same as any spend.
4. Approve and sign. SeedSigner shows the signed PSBT as its own animated QR.
5. Back in splayed, click **Scan signed** and scan that QR with the camera.
6. `verify` should report the ECX replay marker (`nLockTime 499999998` with a non-final sequence)
   and a plain `SIGHASH_ALL`/`DEFAULT` signature.

**XBT** needs a signer that makes `SIGHASH_ALL|SIGHASH_UNIFIED` (0x21) signatures. Stock SeedSigner
firmware can't do this. `--xbt-signer privkeyio-firmware` in `planner.ts` (`src/core/planner.ts`)
refers to the SIGHASH_UNIFIED-aware SeedSigner fork at
[github.com/privkeyio/seedsigner](https://github.com/privkeyio/seedsigner). Tested with release
[`v0.8.7-unified-sighash.6`](https://github.com/privkeyio/seedsigner/releases/tag/v0.8.7-unified-sighash.6)
("Take embit 0.8.0-unified-sighash.4"), the `p10.img` asset from that release. It is marked
**experimental and unaudited** — test with the smallest coin first, and plan with
`--xbt-signer privkeyio-firmware` so the plan carries that warning.

1. Flash the device with the unified-sighash firmware fork instead of stock SeedSigner. (A device
   can only run one firmware at a time — use a spare device or SD card if you also sign ECX with
   stock SeedSigner.)
2. In the splayed UI, click **QR** on the XBT transaction.
3. On the device: `Scan` the animated QR, review the transaction the same way as any spend.
4. Approve and sign. The device shows the signed PSBT as an animated QR.
5. Back in splayed, click **Scan signed** and scan it in.
6. `verify` should report every XBT signature as `SIGHASH_ALL|UNIFIED` (0x21), verified under the
   unified digest. If it instead reports a plain `SIGHASH_ALL` signature, the firmware silently
   dropped the 0x21 request — don't broadcast; such a transaction would also be valid on BTC.

Confirmed working on mainnet (2026-11-01): both splits of a real coin, verified and broadcast, with
the XBT split reaching 2 confirmations.
