#!/usr/bin/env python3
"""
Generates testdata/seedsigner_ur.json: real wallet-export QR frames for splayed's QR import
tests, produced by SeedSigner's own encoder, with expected results computed independently.

Not run by `deno task test`; the JSON it writes is committed. To regenerate:

  git clone https://github.com/SeedSigner/seedsigner && git -C seedsigner checkout 0.8.7
  git clone https://github.com/selfcustody/urtypes && \
    git -C urtypes checkout 7fb280eab3b3563dfc57d2733b0bf5cbc0a96a6a   # SeedSigner 0.8.7's pin
  pip install embit==0.8.0 pillow qrcode ./urtypes
  SEEDSIGNER_SRC=seedsigner/src python3 tests/fixtures/seedsigner/generate.py > testdata/seedsigner_ur.json

Seeds are the public BIP39 test vectors: never use them for real coins.

What is produced:
- SeedSigner xpub exports (UR crypto-account, animated) for single-sig 84/49/86/44 and multisig
  48'/0'/0'/2' (native) and 48'/0'/0'/1' (nested), plus SeedSigner's "Static" text export.
- A coordinator-style whole-wallet export as legacy UR crypto-output: wsh(sortedmulti(2, …)) of
  the three seeds' 48'/0'/0'/2' keys (urtypes + SeedSigner's UR encoder, as Sparrow-like input).
- Expected xpubs, descriptors and first receive addresses from embit (not from splayed).
"""
import json
import os
import sys

sys.path.insert(0, os.environ.get("SEEDSIGNER_SRC", "."))

from embit import bip32  # noqa: E402
from embit.descriptor import Descriptor  # noqa: E402
from embit.networks import NETWORKS  # noqa: E402
from seedsigner.helpers.ur2.ur import UR  # noqa: E402
from seedsigner.helpers.ur2.ur_encoder import UREncoder  # noqa: E402
from seedsigner.models.encode_qr import StaticXpubQrEncoder, UrXpubQrEncoder  # noqa: E402
from seedsigner.models.seed import Seed  # noqa: E402
from seedsigner.models.settings import SettingsConstants as S  # noqa: E402
from urtypes.crypto import (  # noqa: E402
    SCRIPT_EXPRESSION_TAG_MAP,
    HDKey,
    Keypath,
    MultiKey,
    Output,
    PathComponent,
)

SEEDS = [
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    "legal winner thank year wave sausage worth useful legal winner thank yellow",
    "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
]
MAIN = NETWORKS["main"]


def frames(encoder, extra=4):
    """Every pure fragment plus a few fountain (mixed) frames, as SeedSigner would show them."""
    n = encoder.seq_len()
    return [encoder.next_part() for _ in range(n + (extra if n > 1 else 0))]


def account_xpub(mnemonic, path):
    seed = Seed(mnemonic=mnemonic.split())
    root = bip32.HDKey.from_seed(seed.seed_bytes, version=MAIN["xprv"])
    fp = root.child(0).fingerprint.hex()
    xpub = root.derive(path).to_public().to_string(version=MAIN["xpub"])
    return seed, fp, xpub


def first_address(desc):
    d = Descriptor.from_string(desc)
    return d.derive(0, branch_index=0).address(MAIN)


def norm(path):
    return path[2:].replace("'", "h")


out = {"generator": "SeedSigner 0.8.7 encode_qr.py + urtypes@7fb280e + embit 0.8.0", "cases": []}

SINGLE = {"m/84'/0'/0'": "wpkh({})", "m/49'/0'/0'": "sh(wpkh({}))", "m/86'/0'/0'": "tr({})",
          "m/44'/0'/0'": "pkh({})"}
for path, wrap in SINGLE.items():
    seed, fp, xpub = account_xpub(SEEDS[0], path)
    enc = UrXpubQrEncoder(seed=seed, derivation=path, network=S.MAINNET,
                          qr_density=S.DENSITY__MEDIUM, sig_type=S.SINGLE_SIG)
    key = f"[{fp}/{norm(path)}]{xpub}"
    desc = wrap.format(f"{key}/<0;1>/*")
    out["cases"].append({
        "name": f"seedsigner crypto-account single-sig {path}",
        "kind": "account",
        "frames": frames(enc),
        "fingerprint": fp,
        "path": norm(path),
        "xpub": xpub,
        "descriptor": desc,
        "firstAddress": first_address(wrap.format(f"{key}/0/*")),
    })

seed, fp, xpub = account_xpub(SEEDS[0], "m/84'/0'/0'")
static = StaticXpubQrEncoder(seed=seed, derivation="m/84'/0'/0'", network=S.MAINNET,
                             sig_type=S.SINGLE_SIG)
key = f"[{fp}/84h/0h/0h]{xpub}"
out["cases"].append({
    "name": "seedsigner static text 84'",
    "kind": "static",
    "frames": [static.next_part()],
    "fingerprint": fp,
    "path": "84h/0h/0h",
    "xpub": xpub,
    "descriptor": f"wpkh({key}/<0;1>/*)",
    "firstAddress": first_address(f"wpkh({key}/0/*)"),
})

for path, script in (("m/48'/0'/0'/2'", "wsh"), ("m/48'/0'/0'/1'", "sh-wsh")):
    cosigners = []
    for mnemonic in SEEDS:
        seed, fp, xpub = account_xpub(mnemonic, path)
        enc = UrXpubQrEncoder(seed=seed, derivation=path, network=S.MAINNET,
                              qr_density=S.DENSITY__MEDIUM, sig_type=S.MULTISIG)
        cosigners.append({"frames": frames(enc), "fingerprint": fp, "path": norm(path),
                          "xpub": xpub})
    keys = ",".join(f"[{c['fingerprint']}/{c['path']}]{c['xpub']}/0/*" for c in cosigners)
    inner = f"sortedmulti(2,{keys})"
    receive = f"wsh({inner})" if script == "wsh" else f"sh(wsh({inner}))"
    out["cases"].append({
        "name": f"seedsigner multisig cosigners {path} 2-of-3 sortedmulti",
        "kind": "cosigners",
        "script": script,
        "threshold": 2,
        "cosigners": cosigners,
        "descriptor": receive.replace("/0/*", "/<0;1>/*"),
        "firstAddress": first_address(receive),
    })

# Coordinator-style whole wallet, legacy crypto-output (no children paths: splayed adds <0;1>/*).
hdkeys = []
cos = out["cases"][-2]["cosigners"]  # the native (48'/0'/0'/2') set
for mnemonic in SEEDS:
    seed = Seed(mnemonic=mnemonic.split())
    root = bip32.HDKey.from_seed(seed.seed_bytes, version=MAIN["xprv"])
    acct = root.derive("m/48'/0'/0'/2'").to_public()
    origin = Keypath([PathComponent(48, True), PathComponent(0, True), PathComponent(0, True),
                      PathComponent(2, True)], root.child(0).fingerprint, 4)
    hdkeys.append(HDKey({"key": acct.key.serialize(), "chain_code": acct.chain_code,
                         "origin": origin, "parent_fingerprint": acct.fingerprint}))
output = Output([SCRIPT_EXPRESSION_TAG_MAP[401], SCRIPT_EXPRESSION_TAG_MAP[407]],
                MultiKey(2, [], hdkeys))
enc = UREncoder(UR("crypto-output", output.to_cbor()), 120)
wallet_frames = [enc.next_part().upper() for _ in range(enc.fountain_encoder.seq_len() + 3)]
keys = ",".join(f"[{c['fingerprint']}/{c['path']}]{c['xpub']}/0/*" for c in cos)
out["cases"].append({
    "name": "coordinator legacy crypto-output wsh(sortedmulti(2,...)) of the three seeds",
    "kind": "output",
    "frames": wallet_frames,
    "descriptor": f"wsh(sortedmulti(2,{keys}))".replace("/0/*", "/<0;1>/*"),
    "firstAddress": first_address(f"wsh(sortedmulti(2,{keys}))"),
})

json.dump(out, sys.stdout, indent=1)
sys.stdout.write("\n")
