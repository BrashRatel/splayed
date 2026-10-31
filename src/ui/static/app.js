// forksplit web UI. Every action runs a forksplit CLI command on the local server (same checks,
// same prompts). Text from the server is only ever inserted with textContent.

const token = (() => {
  const m = /token=([\w-]+)/.exec(location.hash);
  if (m) {
    sessionStorage.setItem("forksplit-token", m[1]);
    history.replaceState(null, "", location.pathname);
    return m[1];
  }
  return sessionStorage.getItem("forksplit-token");
})();

// Theme: dark by default; "light" is remembered in this browser only.
function applyTheme(light) {
  document.documentElement.classList.toggle("light", light);
  document.getElementById("theme-toggle").textContent = light ? "Dark mode" : "Light mode";
}
let lightTheme = false;
try {
  lightTheme = localStorage.getItem("forksplit-theme") === "light";
} catch { /* storage unavailable: stay dark */ }
applyTheme(lightTheme);
document.getElementById("theme-toggle").addEventListener("click", () => {
  lightTheme = !lightTheme;
  applyTheme(lightTheme);
  try {
    localStorage.setItem("forksplit-theme", lightTheme ? "light" : "dark");
  } catch { /* not persisted */ }
});

const state = { tab: "network", overview: null, status: null, plans: null, job: null, after: 0 };

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const btc = (sats) => `${Math.floor(sats / 1e8)}.${String(sats % 1e8).padStart(8, "0")}`;
const short = (txid, vout) =>
  `${txid.slice(0, 8)}…${txid.slice(-4)}${vout === undefined ? "" : ":" + vout}`;
const badge = (text, cls) => h("span", { class: `badge ${cls ?? ""}` }, text);

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.headers.get("content-type")?.includes("json") ? res.json() : res;
}

// ---------- jobs (CLI commands) ----------

const log = document.getElementById("log");
function logLine(text, cls) {
  log.append(h("span", { class: cls }, text + "\n"));
  log.scrollTop = log.scrollHeight;
}

async function run(args) {
  if (state.job && !state.job.done) {
    alert("Another command is still running.");
    return;
  }
  logLine(
    `$ forksplit ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`,
    "cmd",
  );
  try {
    state.job = await api("/api/run", { method: "POST", body: JSON.stringify({ args }) });
  } catch (e) {
    logLine(String(e.message), "err");
    return;
  }
  state.after = 0;
  setBusy(true);
  pollJob();
}

let questionShown = null;
async function pollJob() {
  const job = await api(`/api/jobs/${state.job.id}?after=${state.after}`).catch((e) => {
    logLine(e.message, "err");
    return null;
  });
  if (!job) return setBusy(false);
  for (const l of job.lines) logLine(l.text, l.stream === "err" ? "err" : "");
  state.after += job.lines.length;
  state.job = job;
  if (job.question && questionShown !== job.question.id) ask(job.question);
  if (job.done) {
    logLine(`(exit ${job.exitCode})`, job.exitCode ? "err" : "muted");
    setBusy(false);
    await refresh();
    return;
  }
  setTimeout(pollJob, 400);
}

function ask(question) {
  questionShown = question.id;
  const modal = document.getElementById("modal");
  document.getElementById("modal-text").textContent = question.text;
  modal.classList.remove("hidden");
  const answer = async (yes) => {
    modal.classList.add("hidden");
    document.getElementById("modal-yes").onclick = null;
    document.getElementById("modal-no").onclick = null;
    await api(`/api/jobs/${state.job.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ questionId: question.id, yes }),
    }).catch((e) => logLine(e.message, "err"));
  };
  document.getElementById("modal-yes").onclick = () => answer(true);
  document.getElementById("modal-no").onclick = () => answer(false);
}

function setBusy(busy) {
  document.getElementById("job-state").textContent = busy ? "running…" : "idle";
  for (const b of document.querySelectorAll("section#view button")) b.disabled = busy;
}

// ---------- data ----------

async function refresh() {
  try {
    const [overview, status, plans] = await Promise.all([
      api("/api/overview"),
      api("/api/status"),
      api("/api/plans"),
    ]);
    Object.assign(state, { overview, status, plans });
  } catch (e) {
    logLine(`Couldn't load data: ${e.message}`, "err");
  }
  render();
}

function headerPills() {
  const o = state.overview;
  const gate = document.getElementById("gate-pill");
  const torPill = document.getElementById("tor-pill");
  if (!o || o.configError) {
    gate.textContent = "config error";
    gate.className = "pill bad";
    return;
  }
  gate.textContent = o.confirmed ? "network confirmed" : "network not confirmed";
  gate.className = `pill ${o.confirmed ? "ok" : "warn"}`;
  const s = o.tor.status;
  torPill.textContent = s.state === "ready"
    ? `Tor: ${s.detail}`
    : s.state === "starting"
    ? `Tor: starting ${s.progress}%`
    : s.state === "failed"
    ? "Tor: failed"
    : `Tor: ${o.tor.mode} (not started)`;
  torPill.className = `pill ${s.state === "ready" ? "tor" : s.state === "failed" ? "bad" : ""}`;
}

// ---------- views ----------

function viewNetwork() {
  const o = state.overview;
  if (o.configError) {
    return h("div", { class: "banner bad" }, `Configuration error: ${o.configError}`);
  }
  const view = [];
  view.push(h(
    "div",
    { class: `banner ${o.confirmed ? "ok" : ""}` },
    o.confirmed
      ? "Network settings are confirmed. Changing anything here re-locks importing and scanning until you confirm again."
      : "Review where each chain's queries go, change anything you want, then press “Check servers & confirm”. Nothing about your coins is sent before that.",
    h(
      "div",
      { class: "row" },
      h("button", { onclick: () => run(["init"]) }, "Check servers & confirm"),
    ),
  ));

  const torMode = h(
    "select",
    { id: "tor-mode" },
    ...["auto", "managed", "system"].map((m) =>
      h("option", { value: m, selected: o.tor.mode === m }, m)
    ),
  );
  const torSocks = h("input", {
    id: "tor-socks",
    placeholder: "127.0.0.1:9050",
    value: o.tor.socks ? `${o.tor.socks.host}:${o.tor.socks.port}` : "",
  });
  view.push(h(
    "div",
    { class: "card" },
    h("h2", {}, "Tor"),
    h("p", { class: "note" }, o.tor.description),
    h(
      "p",
      { class: "note" },
      "auto: use a Tor already running (or the Tor Browser), else start forksplit's own. managed: always start our own. system: only a Tor you run, never start one.",
    ),
    h(
      "div",
      { class: "row" },
      h("label", {}, "Mode", torMode),
      h("label", {}, "SOCKS address (optional)", torSocks),
      h("button", {
        class: "secondary",
        onclick: () =>
          run([
            "config",
            "tor",
            torMode.value,
            ...(torSocks.value.trim() ? [torSocks.value.trim()] : []),
          ]),
      }, "Save Tor setting"),
    ),
  ));

  for (const c of o.chains) {
    const rows = c.backends.map((b) =>
      h(
        "tr",
        {},
        h("td", {}, String(b.priority)),
        h("td", {}, b.kind),
        h(
          "td",
          { class: "mono" },
          b.url,
          b.origin === "profile-default" ? h("div", { class: "muted" }, "profile default") : null,
        ),
        h("td", {}, b.role),
        h("td", {}, badge(b.privacy, b.privacyClass)),
        h(
          "td",
          {},
          h("button", {
            class: "small secondary",
            onclick: () => run(["config", "backend", "remove", c.chain, b.url]),
          }, "Remove"),
        ),
      )
    );
    const conf = h("input", {
      type: "number",
      min: c.minConfirmations,
      value: c.confirmations,
      class: "w80",
    });
    view.push(h(
      "div",
      { class: "card" },
      h("h2", {}, c.name),
      h(
        "table",
        {},
        h("tr", {}, ...["#", "Kind", "URL", "Role", "Privacy", ""].map((t) => h("th", {}, t))),
        ...rows,
      ),
      h(
        "p",
        { class: "note" },
        "Backends are tried in priority order; checking stops at the first that passes, so lower ones aren't contacted.",
      ),
      h(
        "div",
        { class: "row" },
        h("button", {
          class: "small secondary",
          onclick: () => run(["config", "backend", "reset", c.chain]),
        }, "Reset to profile default"),
        ...c.fallbacks.map((f) =>
          h("button", {
            class: "small secondary",
            onclick: () => run(["config", "backend", "fallback", c.chain]),
          }, `Add fallback ${f}`)
        ),
        h(
          "button",
          {
            class: `small ${c.clearnetOptIn ? "secondary" : "danger"}`,
            onclick: () => {
              if (
                c.clearnetOptIn ||
                confirm(
                  `Allow ${c.chain.toUpperCase()} backends with proxy "none" to be contacted over clearnet? They will see your IP address next to every address and coin you look up.`,
                )
              ) {
                run(["config", "clearnet", c.chain, c.clearnetOptIn ? "off" : "on"]);
              }
            },
          },
          c.clearnetOptIn ? "Turn clearnet off" : "Allow clearnet…",
        ),
        h("label", {}, `Confirmations (min ${c.minConfirmations})`, conf),
        h("button", {
          class: "small secondary",
          onclick: () => run(["config", "confirmations", c.chain, conf.value]),
        }, "Set"),
      ),
    ));
  }

  const f = {
    chain: h(
      "select",
      {},
      ...o.chains.map((c) => h("option", { value: c.chain }, c.chain.toUpperCase())),
    ),
    kind: h(
      "select",
      {},
      ...["esplora", "electrum", "rpc"].map((k) => h("option", { value: k }, k)),
    ),
    url: h("input", {
      class: "wide",
      placeholder: "http://127.0.0.1:8332  ·  ssl://host:50002  ·  https://host/api",
    }),
    proxy: h("input", { value: "tor", class: "w160" }),
    role: h(
      "select",
      {},
      ...["both", "read", "broadcast"].map((r) => h("option", { value: r }, r)),
    ),
    priority: h("input", { type: "number", value: "0", class: "w70" }),
    cookie: h("input", { placeholder: "~/.bitcoin/.cookie" }),
    user: h("input", { placeholder: "rpc user" }),
    pwenv: h("input", { placeholder: "BTC_RPC_PASSWORD" }),
    ca: h("input", { placeholder: "server-cert.pem" }),
  };
  const add = () => {
    const args = [
      "config",
      "backend",
      "add",
      f.chain.value,
      "--kind",
      f.kind.value,
      "--url",
      f.url.value.trim(),
      "--proxy",
      f.proxy.value.trim() || "tor",
      "--role",
      f.role.value,
      "--priority",
      f.priority.value || "0",
    ];
    if (f.cookie.value.trim()) args.push("--cookie-file", f.cookie.value.trim());
    if (f.user.value.trim()) args.push("--user", f.user.value.trim());
    if (f.pwenv.value.trim()) args.push("--password-env", f.pwenv.value.trim());
    if (f.ca.value.trim()) args.push("--ca-file", f.ca.value.trim());
    run(args);
  };
  view.push(h(
    "div",
    { class: "card" },
    h("h2", {}, "Add your own backend"),
    h(
      "p",
      { class: "note" },
      "Adding a backend to a chain removes that chain's profile default, so the default is never contacted. Local and LAN hosts are reached directly; anything else goes through Tor unless you allow clearnet for that chain.",
    ),
    h(
      "div",
      { class: "row" },
      h("label", {}, "Chain", f.chain),
      h("label", {}, "Kind", f.kind),
      h("label", {}, "URL", f.url),
    ),
    h(
      "div",
      { class: "row" },
      h("label", {}, "Proxy (tor | none | socks5://h:p)", f.proxy),
      h("label", {}, "Role", f.role),
      h("label", {}, "Priority", f.priority),
    ),
    h(
      "details",
      {},
      h("summary", {}, "Node RPC credentials / TLS pinning"),
      h(
        "div",
        { class: "row" },
        h("label", {}, "Cookie file", f.cookie),
        h("label", {}, "RPC user", f.user),
        h("label", {}, "Password env var (not the password)", f.pwenv),
        h("label", {}, "CA file (PEM)", f.ca),
      ),
    ),
    h("div", { class: "row" }, h("button", { onclick: add }, "Add backend")),
  ));
  return view;
}

function viewWallet() {
  const o = state.overview;
  const view = [];
  if (!o.confirmed) {
    view.push(
      h(
        "div",
        { class: "banner" },
        "Confirm the network settings first (tab 1). Importing is locked until then.",
      ),
    );
  }
  const desc = h("textarea", {
    placeholder: "wpkh([fingerprint/84h/0h/0h]xpub…/<0;1>/*)#checksum",
  });
  const label = h("input", { placeholder: "label (optional)" });
  view.push(h(
    "div",
    { class: "card" },
    h("h2", {}, "Watch-only descriptors"),
    h(
      "p",
      { class: "note" },
      "Export the output descriptor (xpub, never a seed or xprv) from your wallet. After importing, check the first address matches your wallet.",
    ),
    o.descriptors.length
      ? h(
        "table",
        {},
        h(
          "tr",
          {},
          h("th", {}, "#"),
          h("th", {}, "Descriptor"),
          h("th", {}, "First addresses"),
          h("th", {}),
        ),
        ...o.descriptors.map((d) =>
          h(
            "tr",
            {},
            h("td", {}, String(d.number)),
            h(
              "td",
              { class: "mono" },
              d.label ? h("strong", {}, `[${d.label}] `) : null,
              d.descriptor,
            ),
            h("td", { class: "mono" }, ...d.firstAddresses.map((a) => h("div", {}, a))),
            h(
              "td",
              {},
              h("button", {
                class: "small secondary",
                onclick: () => run(["forget", String(d.number)]),
              }, "Forget"),
            ),
          )
        ),
      )
      : h("p", { class: "muted" }, "None imported yet."),
    desc,
    h(
      "div",
      { class: "row" },
      label,
      h("button", {
        onclick: () =>
          run([
            "import",
            desc.value.trim(),
            ...(label.value.trim() ? ["--label", label.value.trim()] : []),
          ]),
      }, "Import"),
    ),
  ));
  const destCards = ["ecx", "xbt"].map((chain) => {
    const d = o.destinations[chain];
    const input = h("textarea", {
      placeholder: chain === "xbt"
        ? "tr([fp/86h/0h/0h]xpub…/0/*)"
        : "wpkh([fp/84h/0h/0h]xpub…/0/*)",
    });
    const start = h("input", { type: "number", value: "0", class: "w90" });
    return h(
      "div",
      { class: "card" },
      h("h2", {}, `${chain.toUpperCase()} destination`),
      d
        ? h(
          "div",
          {},
          h("div", { class: "mono" }, d.descriptor),
          h("p", { class: "note" }, `Next address: ${d.nextAddress} (index ${d.nextIndex})`),
        )
        : h("p", { class: "muted" }, "Not set."),
      h(
        "p",
        { class: "note" },
        `Where split coins go on ${chain.toUpperCase()}. Best: a new seed used only for ${chain.toUpperCase()}.`,
      ),
      input,
      h(
        "div",
        { class: "row" },
        h("label", {}, "Start index", start),
        h("button", {
          onclick: () =>
            run(["dest", "set", chain, input.value.trim(), "--start-index", start.value || "0"]),
        }, "Set destination"),
      ),
    );
  });
  view.push(h("div", { class: "grid2" }, ...destCards));
  return view;
}

function obsCell(obs, tip, shared) {
  if (!obs) return "-";
  switch (obs.state) {
    case "unspent":
      return badge(
        obs.createdHeight === undefined ? "unspent (unconf)" : "unspent",
        shared ? "shared" : "",
      );
    case "spent":
      return badge(
        obs.spendHeight !== undefined && tip !== undefined
          ? `spent, ${tip - obs.spendHeight + 1} deep`
          : "spent",
        "separated",
      );
    case "absent":
      return badge("absent", "");
    case "gone":
      return badge("spent/absent ?", "pending");
    default:
      return badge("unknown", "unverified");
  }
}

function viewCoins() {
  const s = state.status?.scan;
  const view = [h(
    "div",
    { class: "card" },
    h("h2", {}, "Scan"),
    h(
      "p",
      { class: "note" },
      "Finds your coins on all three chains and checks each coin on every chain. Uses the confirmed backends only.",
    ),
    h(
      "div",
      { class: "row" },
      h("button", { onclick: () => run(["scan"]) }, "Scan now"),
      s
        ? h("span", { class: "muted" }, `Last scan ${new Date(s.scannedAt).toLocaleString()}`)
        : null,
    ),
    s && s.warnings.length
      ? h("div", { class: "banner bad" }, ...s.warnings.map((w) => h("div", {}, w)))
      : null,
  )];
  if (!s) return view;
  const counts = {};
  for (const c of s.coins) {
    counts[c.classification.status] = (counts[c.classification.status] ?? 0) + 1;
  }
  view.push(h(
    "div",
    { class: "card" },
    h("h2", {}, `Coins (${s.coins.length})`),
    h(
      "p",
      {},
      ...Object.entries(counts).map(([k, v]) => h("span", { class: "mr8" }, badge(`${v} ${k}`, k))),
    ),
    h(
      "table",
      {},
      h("tr", {}, ...["Coin", "Value", "BTC", "XBT", "ECX", "Status"].map((t) => h("th", {}, t))),
      ...s.coins.map((c) =>
        h(
          "tr",
          {},
          h(
            "td",
            { class: "mono" },
            short(c.txid, c.vout),
            c.address ? h("div", { class: "muted" }, c.address) : null,
          ),
          h("td", {}, btc(c.value)),
          h(
            "td",
            {},
            obsCell(c.observations.btc, s.tips.btc, c.classification.status === "shared"),
          ),
          h(
            "td",
            {},
            obsCell(c.observations.xbt, s.tips.xbt, c.classification.status === "shared"),
          ),
          h(
            "td",
            {},
            obsCell(c.observations.ecx, s.tips.ecx, c.classification.status === "shared"),
          ),
          h(
            "td",
            {},
            badge(
              c.classification.status === "shared"
                ? `shared ${c.classification.unspentOn.join("+").toUpperCase()}`
                : c.classification.status,
              c.classification.status,
            ),
            c.classification.reasons.length || c.classification.nextSteps.length
              ? h(
                "details",
                {},
                h("summary", {}, "details"),
                ...c.classification.reasons.map((r) => h("div", { class: "note" }, r)),
                ...c.classification.nextSteps.map((n, i) =>
                  h("div", { class: "note" }, `${i + 1}. ${n}`)
                ),
              )
              : null,
          ),
        )
      ),
    ),
  ));
  return view;
}

function readFileB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function download(planId, file, format) {
  const res = await api(
    `/api/plans/${planId}/download?file=${encodeURIComponent(file)}&format=${format}`,
  );
  const blob = await res.blob();
  const a = h("a", {
    href: URL.createObjectURL(blob),
    download: `${planId}-${file.replace("/", "-")}${format === "binary" ? "" : ".txt"}`,
  });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

function viewPlans() {
  const o = state.overview;
  const signer = h(
    "select",
    {},
    h("option", { value: "" }, "— no XBT signer (plan ECX only) —"),
    ...Object.entries(o.xbtSigners).map(([k, v]) =>
      h("option", { value: k }, `${v.label}${v.experimental ? " (experimental)" : ""}`)
    ),
  );
  const batch = h(
    "select",
    {},
    ...[["coin", "one coin per transaction (unlinked)"], ["address", "group by address"], [
      "all",
      "all coins in one transaction (links them)",
    ]].map(([v, t]) => h("option", { value: v }, t)),
  );
  const feeEcx = h("input", { placeholder: "auto", class: "w80" });
  const feeXbt = h("input", { placeholder: "auto", class: "w80" });
  const create = () => {
    const chains = signer.value ? "ecx,xbt" : "ecx";
    const args = ["plan", "--chains", chains, "--batch", batch.value];
    if (signer.value) args.push("--xbt-signer", signer.value);
    const fees = [
      feeEcx.value.trim() ? `ecx=${feeEcx.value.trim()}` : "",
      signer.value && feeXbt.value.trim() ? `xbt=${feeXbt.value.trim()}` : "",
    ].filter(Boolean);
    if (fees.length) args.push("--fee-rate", fees.join(","));
    run(args);
  };
  const view = [h(
    "div",
    { class: "card" },
    h("h2", {}, "New plan (guided route: forks first, BTC untouched)"),
    h(
      "p",
      { class: "note" },
      "ECX splits get nLockTime 499,999,998 and can be signed by any wallet. XBT splits need SIGHASH_ALL|UNIFIED (0x21) signatures, which stock hardware wallets can't make; pick the signer you'll use.",
    ),
    h(
      "div",
      { class: "row" },
      h("label", {}, "XBT signer", signer),
      h("label", {}, "Batching", batch),
      h("label", {}, "ECX fee (sat/vB)", feeEcx),
      h("label", {}, "XBT fee (sat/vB)", feeXbt),
      h("button", { onclick: create }, "Create plan"),
    ),
  )];
  for (const p of state.plans?.plans ?? []) {
    const rows = p.transactions.map((t) => {
      const fileInput = h("input", { type: "file", class: "mw190" });
      const upload = async () => {
        const f = fileInput.files?.[0];
        if (!f) return alert("Choose the signed file first.");
        try {
          const r = await api(`/api/plans/${p.id}/upload`, {
            method: "POST",
            body: JSON.stringify({ file: t.file, content: await readFileB64(f) }),
          });
          logLine(`Saved signed file as ${r.saved}`);
          await refresh();
        } catch (e) {
          logLine(`Upload failed: ${e.message}`, "err");
        }
      };
      const pr = t.progress;
      return h(
        "tr",
        {},
        h(
          "td",
          {},
          t.chain.toUpperCase(),
          " #",
          String(t.order),
          t.testFirst ? h("div", {}, badge("TEST FIRST", "test")) : null,
        ),
        h(
          "td",
          {},
          `${t.inputs} in · ${btc(t.value)}`,
          h("div", { class: "muted" }, `fee ${t.fee} @ ${t.feeRate}`),
        ),
        h("td", { class: "mono" }, t.output.address),
        h(
          "td",
          {},
          h(
            "button",
            { class: "small secondary", onclick: () => download(p.id, t.file, "binary") },
            ".psbt",
          ),
          " ",
          h(
            "button",
            { class: "small secondary", onclick: () => download(p.id, t.file, "base64") },
            "base64",
          ),
        ),
        h(
          "td",
          {},
          fileInput,
          h("button", { class: "small secondary", onclick: upload }, "Upload signed"),
        ),
        h(
          "td",
          {},
          pr.verified ? badge("verified", "verified") : badge("not verified", ""),
          pr.broadcast ? h("div", {}, badge(pr.broadcast.status, pr.broadcast.status)) : null,
          pr.confirmations ? h("div", { class: "muted" }, `${pr.confirmations.depth} conf`) : null,
        ),
      );
    });
    view.push(h(
      "div",
      { class: "card" },
      h("h2", {}, `Plan ${p.id}`),
      h(
        "p",
        { class: "note" },
        `XBT signer: ${p.xbtSigner ?? "none"} · signed files: ${p.signedFiles.length}`,
      ),
      ...p.warnings.map((w) => h("div", { class: "note" }, `⚠ ${w}`)),
      h(
        "table",
        {},
        h(
          "tr",
          {},
          ...["Tx", "Inputs", "Destination", "Unsigned PSBT", "Signed file", "Status"].map((x) =>
            h("th", {}, x)
          ),
        ),
        ...rows,
      ),
      h(
        "div",
        { class: "row" },
        h("button", { onclick: () => run(["verify", p.id]) }, "Verify signed files"),
        h("button", { onclick: () => run(["broadcast", p.id]) }, "Broadcast verified"),
        h("button", {
          class: "danger",
          onclick: () =>
            confirm(
              "Broadcast everything now, without waiting for the TEST FIRST transactions to confirm?",
            ) && run(["broadcast", p.id, "--all"]),
        }, "Broadcast all now…"),
        h(
          "button",
          { class: "secondary", onclick: () => run(["track", p.id]) },
          "Track confirmations",
        ),
      ),
    ));
  }
  return view;
}

function render() {
  headerPills();
  const view = document.getElementById("view");
  view.replaceChildren();
  if (!token) {
    view.append(
      h(
        "div",
        { class: "banner bad" },
        "No access token. Open the exact URL printed by `forksplit ui`.",
      ),
    );
    return;
  }
  if (!state.overview) return;
  const content = {
    network: viewNetwork,
    wallet: viewWallet,
    coins: viewCoins,
    plans: viewPlans,
  }[state.tab]();
  view.append(...[content].flat());
  setBusy(!!(state.job && !state.job.done));
}

for (const b of document.querySelectorAll("#tabs button")) {
  b.addEventListener("click", () => {
    state.tab = b.dataset.tab;
    for (const x of document.querySelectorAll("#tabs button")) {
      x.classList.toggle("active", x === b);
    }
    render();
  });
}

setInterval(async () => {
  if (!state.overview || !token) return;
  try {
    state.overview.tor.status = await api("/api/tor");
    headerPills();
  } catch { /* ignore */ }
}, 2000);

(async () => {
  if (!token) return render();
  await refresh();
  const current = await api("/api/jobs/current").catch(() => null);
  if (current && !current.done) {
    state.job = current;
    state.after = 0;
    setBusy(true);
    pollJob();
  }
})();
