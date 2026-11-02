// Wallet import by QR code: scan a signer's xpub export (e.g. SeedSigner's animated
// crypto-account) or a coordinator's whole-wallet descriptor (crypto-output), see the resulting
// descriptor and its first address, then put it in the import or destination field. For multisig,
// scan each cosigner in turn and set the threshold. Decoding and checks happen in splayed on this
// machine (/api/wallet/qr, /api/wallet/preview); nothing is stored until you press Import or
// Set destination yourself.

import { overlay, startCamera } from "./qr.js";

const SCRIPT_NAMES = {
  "wpkh": "Native SegWit (wpkh)",
  "sh-wpkh": "Nested SegWit (sh(wpkh))",
  "tr": "Taproot (tr)",
  "pkh": "Legacy (pkh)",
  "wsh": "Multisig, native (wsh)",
  "sh-wsh": "Multisig, nested (sh(wsh))",
};
const isMultisig = (script) => script === "wsh" || script === "sh-wsh";
const shortXpub = (x) => `${x.slice(0, 12)}…${x.slice(-6)}`;

/**
 * Opens the import dialog. `purpose` is "import" (wallet to scan: receive and change) or "dest"
 * (fork destination: receive branch). `onUse(descriptor)` gets the final text.
 */
export function walletQrImport({ api, h, purpose, title, onUse }) {
  let camera = null;
  let closed = false;
  const cosigners = []; // { script, key }
  // The threshold the user typed, if any. Until then a majority (2 of 3, 3 of 5) is suggested.
  let chosenThreshold = null;
  let sorted = true;
  const { box, close } = overlay(h, title, () => {
    closed = true;
    camera?.stop();
  });
  box.classList.add("wallet-qr");
  const scanArea = h("div", {});
  const resultArea = h("div", {});
  box.append(scanArea, resultArea);

  const error = (text) => h("div", { class: "banner bad" }, text);
  const descriptorBlock = (descriptor) => h("pre", { class: "wallet-qr-desc" }, descriptor);

  /** One scan (camera, or pasted text). Resolves with the decoded result. */
  let scanNumber = 0;
  /** One scan (camera, or pasted text). Resolves with the decoded result, or null if cancelled. */
  function scan(intro, onCancel) {
    camera?.stop();
    camera = null;
    const mine = ++scanNumber;
    const session = crypto.randomUUID();
    const status = h("p", { class: "note" }, "Starting the camera…");
    const bar = h("progress", { max: "100", value: "0", class: "qr-progress" });
    const video = h("video", { class: "qr-video", playsinline: true, muted: true });
    const paste = h("textarea", {
      rows: "4",
      placeholder:
        "ur:crypto-account/… (one frame per line), [fingerprint/path]xpub…, or a descriptor",
    });
    return new Promise((resolve) => {
      let queue = [];
      let sending = false;
      let done = false;
      const flush = async () => {
        if (sending || !queue.length || done || closed) return;
        sending = true;
        const frames = queue;
        queue = [];
        try {
          const r = await api("/api/wallet/qr", {
            method: "POST",
            body: JSON.stringify({ session, frames }),
          });
          if (r.complete) {
            done = true;
            camera?.stop();
            bar.value = 100;
            status.textContent = "Got it.";
            resolve(r.result);
            return;
          }
          bar.value = r.progress?.percent ?? 0;
          status.textContent =
            `Reading… ${r.progress?.known ?? 0} of ${r.progress?.fragments || "?"} pieces` +
            (r.rejected ? ` (${r.rejected} unreadable frame(s) skipped)` : "");
        } catch (e) {
          status.textContent = e.message;
          if (/another transfer|Start the scan again/u.test(e.message)) camera?.forget();
        } finally {
          sending = false;
        }
      };
      scanArea.replaceChildren(
        h("p", { class: "note" }, intro),
        onCancel
          ? h(
            "div",
            { class: "row" },
            h("button", {
              class: "secondary",
              onclick: () => {
                done = true;
                camera?.stop();
                resolve(null);
                onCancel();
              },
            }, "Back to the cosigners"),
          )
          : null,
        video,
        bar,
        status,
        h(
          "details",
          {},
          h("summary", {}, "No camera? Paste the QR text instead"),
          paste,
          h(
            "div",
            { class: "row" },
            h("button", {
              class: "secondary",
              onclick: () => {
                queue.push(...paste.value.split(/\s+/u).filter(Boolean));
                // A descriptor contains no whitespace, but a pasted one may be split: rejoin it.
                if (!/^ur:/iu.test(paste.value.trim())) queue = [paste.value.trim()];
                flush();
              },
            }, "Read"),
          ),
        ),
      );
      startCamera({
        video,
        status,
        accept: () => true,
        onText: (text) => {
          queue.push(text);
          flush();
        },
        otherwise: "Use the paste box below instead.",
      }).then((c) => {
        // A late start from an earlier scan must not take over (or leave the camera on).
        if (closed || done || mine !== scanNumber) c?.stop();
        else camera = c;
      }).catch((e) => (status.textContent = e.message));
      const timer = setInterval(() => {
        if (done || closed) clearInterval(timer);
        else flush();
      }, 500);
    });
  }

  async function preview(body) {
    return await api("/api/wallet/preview", {
      method: "POST",
      body: JSON.stringify({ ...body, purpose }),
    });
  }

  function useButton(descriptor) {
    return h("button", {
      onclick: () => {
        onUse(descriptor);
        close();
      },
    }, "Use this");
  }

  async function showDescriptor(body, heading, extra = []) {
    resultArea.replaceChildren(h("p", { class: "note" }, "Checking…"));
    try {
      const p = await preview(body);
      resultArea.replaceChildren(
        h("h3", {}, heading),
        ...extra,
        descriptorBlock(p.descriptor),
        h(
          "p",
          {},
          "First address: ",
          h("strong", { class: "mono" }, p.firstAddresses[0]),
        ),
        h(
          "p",
          { class: "note" },
          "Check this address appears in your wallet before using it.",
        ),
        h("div", { class: "row" }, useButton(p.descriptor)),
      );
    } catch (e) {
      resultArea.replaceChildren(error(e.message));
    }
  }

  function renderBuilder() {
    const script = cosigners[0].script;
    const n = cosigners.length;
    const threshold = Math.min(Math.max(1, chosenThreshold ?? Math.floor(n / 2) + 1), n);
    const list = h(
      "table",
      {},
      h("tr", {}, ...["#", "Fingerprint", "Path", "Key", ""].map((x) => h("th", {}, x))),
      ...cosigners.map((c, i) =>
        h(
          "tr",
          {},
          h("td", {}, String(i + 1)),
          h("td", { class: "mono" }, c.key.fingerprint),
          h("td", { class: "mono" }, c.key.path),
          h("td", { class: "mono" }, shortXpub(c.key.xpub)),
          h(
            "td",
            {},
            sorted ? null : h("button", {
              class: "secondary",
              disabled: i === 0,
              onclick: () => {
                [cosigners[i - 1], cosigners[i]] = [cosigners[i], cosigners[i - 1]];
                renderBuilder();
              },
            }, "↑"),
            sorted ? null : h("button", {
              class: "secondary",
              disabled: i === cosigners.length - 1,
              onclick: () => {
                [cosigners[i + 1], cosigners[i]] = [cosigners[i], cosigners[i + 1]];
                renderBuilder();
              },
            }, "↓"),
            h("button", {
              class: "secondary",
              onclick: () => {
                cosigners.splice(i, 1);
                if (cosigners.length) renderBuilder();
                else start();
              },
            }, "Remove"),
          ),
        )
      ),
    );
    const thr = h("input", {
      type: "number",
      min: "1",
      max: String(cosigners.length),
      value: String(threshold),
      class: "w60",
    });
    thr.addEventListener("change", () => {
      chosenThreshold = Number(thr.value) || 1;
      renderBuilder();
    });
    const sortBox = h("input", { type: "checkbox" });
    sortBox.checked = sorted;
    sortBox.addEventListener("change", () => {
      sorted = sortBox.checked;
      renderBuilder();
    });
    const out = h("div", {}, h("p", { class: "note" }, "Checking…"));
    scanArea.replaceChildren(
      h("h3", {}, `Multisig wallet: ${SCRIPT_NAMES[script]}`),
      list,
      h(
        "div",
        { class: "row" },
        h("label", {}, "Signatures required", thr),
        h("span", {}, `of ${cosigners.length}`),
        h(
          "label",
          { class: "inline" },
          sortBox,
          " Sorted keys (sortedmulti; most wallets use this)",
        ),
        h("button", {
          class: "secondary",
          onclick: async () => {
            const r = await scan(
              "Scan the next cosigner's xpub export (its multisig key).",
              renderBuilder,
            );
            if (r) add(r);
          },
        }, "Add cosigner"),
      ),
      out,
    );
    resultArea.replaceChildren();
    if (cosigners.length < 2) {
      out.replaceChildren(
        h("p", { class: "note" }, "Add every cosigner: scan each device's multisig xpub export."),
      );
      return;
    }
    preview({
      mode: "multisig",
      script,
      threshold,
      sorted,
      keys: cosigners.map((c) => c.key),
    }).then((p) => {
      out.replaceChildren(
        h(
          "div",
          { class: "banner" },
          h("div", {}, "First receive address of this wallet:"),
          h("div", { class: "big-address mono" }, p.firstAddresses[0]),
          h(
            "div",
            {},
            "Check this matches the first receive address in your coordinator (e.g. Sparrow) before importing. If it doesn't, the key order, the sorted setting or the threshold is different.",
          ),
        ),
        descriptorBlock(p.descriptor),
        h("div", { class: "row" }, useButton(p.descriptor)),
      );
    }).catch((e) => out.replaceChildren(error(e.message)));
  }

  /** While building a multisig: back to the builder, with the problem shown under it. */
  function builderError(text) {
    renderBuilder();
    resultArea.replaceChildren(error(text));
  }

  function add(result) {
    if (cosigners.length && result.kind === "output") {
      builderError(
        "That's a whole wallet descriptor, not one cosigner's key. Scan each device's multisig xpub export, or close this and scan the coordinator's wallet on its own.",
      );
      return;
    }
    if (result.kind === "output") {
      showDescriptor(
        { mode: "output", descriptor: result.descriptor },
        result.name ? `Wallet “${result.name}”` : "Wallet descriptor",
      );
      return;
    }
    const multi = result.keys.filter((k) => isMultisig(k.script));
    const single = result.keys.filter((k) => !isMultisig(k.script));
    if (cosigners.length) {
      const want = cosigners[0].script;
      const k = multi.find((x) => x.script === want);
      if (!k) {
        builderError(
          `That code has no ${
            SCRIPT_NAMES[want]
          } key. On the device, export the multisig xpub for the same script type.`,
        );
        return;
      }
      if (cosigners.some((c) => c.key.xpub === k.key.xpub)) {
        builderError("That cosigner was already added.");
        return;
      }
      cosigners.push(k);
      renderBuilder();
      return;
    }
    if (multi.length === 1 && !single.length) {
      cosigners.push(multi[0]);
      renderBuilder();
      return;
    }
    if (single.length === 1) {
      scanArea.replaceChildren();
      showDescriptor(
        { mode: "single", script: single[0].script, key: single[0].key },
        `${SCRIPT_NAMES[single[0].script]} · ${single[0].key.fingerprint}`,
      );
      return;
    }
    // Several script types in one export: let the user pick theirs.
    scanArea.replaceChildren(
      h("h3", {}, "Which wallet type?"),
      h("p", { class: "note" }, "This export holds keys for several script types."),
      h(
        "div",
        { class: "row" },
        ...single.map((k) =>
          h("button", {
            class: "secondary",
            onclick: () =>
              showDescriptor(
                { mode: "single", script: k.script, key: k.key },
                `${SCRIPT_NAMES[k.script]} · ${k.key.fingerprint}`,
              ),
          }, SCRIPT_NAMES[k.script])
        ),
        ...multi.map((k) =>
          h("button", {
            class: "secondary",
            onclick: () => {
              cosigners.push(k);
              renderBuilder();
            },
          }, `Start a multisig: ${SCRIPT_NAMES[k.script]}`)
        ),
      ),
    );
  }

  async function start() {
    resultArea.replaceChildren();
    const r = await scan(
      purpose === "dest"
        ? "Scan the xpub export of the wallet this fork's coins should go to (ideally a new seed for this fork), or a coordinator's wallet descriptor."
        : "On the signer, export the xpub (SeedSigner: Seeds → your seed → Export Xpub; for multisig choose Multisig), or show the wallet descriptor in your coordinator. Then hold it in front of the camera.",
    );
    if (!closed) add(r);
  }
  start();
}
