import { scanSignedPsbt, showPsbtQr } from "./qr.js";
import { walletQrImport } from "./wallet_qr.js";
import {
  bumpable,
  bumpQuestion,
  coinPlanSummary,
  depthText,
  isOpenAlert,
  reorgAlerts,
} from "./plan_status.js";
// splayed web UI. Every action runs a splayed CLI command on the local server (same checks,
// same prompts). Text from the server is only ever inserted with textContent.

// The access token: from the URL fragment (`splayed ui` prints such a link), or typed into the
// sign-in form. Kept for this tab only (sessionStorage), sent only as a bearer header.
let token = (() => {
  const m = /token=([\w-]+)/.exec(location.hash);
  if (m) {
    sessionStorage.setItem("splayed-token", m[1]);
    history.replaceState(null, "", location.pathname);
    return m[1];
  }
  return sessionStorage.getItem("splayed-token");
})();

// Theme: dark by default; "light" is remembered in this browser only.
function applyTheme(light) {
  document.documentElement.classList.toggle("light", light);
  document.getElementById("theme-toggle").textContent = light ? "Go back" : "Burn eyes";
}
let lightTheme = false;
try {
  lightTheme = localStorage.getItem("splayed-theme") === "light";
} catch { /* storage unavailable: stay dark */ }
applyTheme(lightTheme);
document.getElementById("theme-toggle").addEventListener("click", () => {
  lightTheme = !lightTheme;
  applyTheme(lightTheme);
  try {
    localStorage.setItem("splayed-theme", lightTheme ? "light" : "dark");
  } catch { /* not persisted */ }
});

const state = {
  tab: "network",
  overview: null,
  status: null,
  plans: null,
  donors: null,
  donorSel: new Set(),
  /** Coins picked in the New plan form ("txid:vout"); null = the default (not yet in a plan). */
  planSel: null,
  /** What was typed into the Donors tab's fields, so a re-render doesn't wipe it. */
  donorForm: {},
  /** The plan whose Broadcast/Track/Fee bump button was used last (dev mining tracks it). */
  lastPlan: null,
  job: null,
  after: 0,
};

// Advanced routes (the donor wallet) are hidden until switched on; remembered in this browser only.
let advanced = false;
try {
  advanced = localStorage.getItem("splayed-advanced") === "on";
} catch { /* storage unavailable: stay off */ }
function applyAdvanced() {
  document.getElementById("donors-tab").classList.toggle("hidden", !advanced);
  document.getElementById("advanced-toggle").textContent = `Advanced: ${advanced ? "on" : "off"}`;
  if (!advanced && state.tab === "donors") selectTab("plans");
}
document.getElementById("advanced-toggle").addEventListener("click", () => {
  advanced = !advanced;
  try {
    localStorage.setItem("splayed-advanced", advanced ? "on" : "off");
  } catch { /* not persisted */ }
  applyAdvanced();
  render();
});

// The setup guide (a checklist above every tab) is on until hidden; remembered in this browser.
let guideOn = true;
try {
  guideOn = localStorage.getItem("splayed-guide") !== "hidden";
} catch { /* storage unavailable: keep it on */ }
function applyGuide() {
  document.getElementById("guide-toggle").textContent = `Guide: ${guideOn ? "on" : "off"}`;
}
function setGuide(on) {
  guideOn = on;
  try {
    localStorage.setItem("splayed-guide", on ? "shown" : "hidden");
  } catch { /* not persisted */ }
  applyGuide();
  render();
}
document.getElementById("guide-toggle").addEventListener("click", () => setGuide(!guideOn));
// "Burn history" is the CLI's `wipe`: it lists what goes, then asks (No is the default button).
document.getElementById("wipe-all").addEventListener("click", () => run(["wipe"]));

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
    if (res.status === 401 && token) {
      // The token was replaced (e.g. "Reset UI token"): sign in again.
      signOut();
    }
    throw new Error(msg);
  }
  return res.headers.get("content-type")?.includes("json") ? res.json() : res;
}

// ---------- sign in ----------

function signOut() {
  token = null;
  try {
    sessionStorage.removeItem("splayed-token");
  } catch { /* nothing stored */ }
  state.overview = null;
  render();
}

/** Asks for the access token when the page has none (proxied mode, or a new tab). */
function signInForm() {
  const input = h("input", {
    type: "password",
    autocomplete: "off",
    placeholder: "access token",
    class: "grow",
  });
  const status = h("p", { class: "note" });
  const submit = async () => {
    const value = input.value.trim();
    if (!value) return;
    status.textContent = "Checking…";
    const res = await fetch("/api/overview", { headers: { Authorization: `Bearer ${value}` } })
      .catch((e) => ({ ok: false, status: 0, json: () => ({ error: e.message }) }));
    if (!res.ok) {
      let msg = res.status === 401 ? "Wrong access token." : `HTTP ${res.status}`;
      try {
        if (res.status !== 401) msg = (await res.json()).error ?? msg;
      } catch { /* not json */ }
      status.textContent = msg;
      return;
    }
    token = value;
    try {
      sessionStorage.setItem("splayed-token", value);
    } catch { /* this tab only, in memory */ }
    await start();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  return h(
    "div",
    { class: "card signin" },
    h("h2", {}, "Sign in"),
    h(
      "p",
      { class: "note" },
      "Enter the access token for this splayed UI. It is in the token file the server was started with (Docker: the path it printed; StartOS: the “Show UI token” action). It is kept for this browser tab only.",
    ),
    h("div", { class: "row" }, input, h("button", { onclick: submit }, "Sign in")),
    status,
  );
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
    `$ splayed ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`,
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

/** What the auto-advance below compares before and after a command. */
function progressMarks() {
  const o = state.overview ?? {};
  const dests = o.destinations ?? {};
  return {
    confirmed: !!o.confirmed,
    walletReady: (o.descriptors ?? []).length > 0 && !!dests.ecx && !!dests.xbt,
    plans: (state.plans?.plans ?? []).length,
  };
}

/**
 * Moves to the next tab when a step has just been completed from its own tab: Network → Wallet
 * once the settings are confirmed, Wallet → Coins once a wallet is imported and both fork
 * destinations are set. Only on the transition, so revisiting a tab later doesn't bounce you.
 */
function autoAdvance(job, before, after) {
  if (job.exitCode !== 0) return;
  if (state.tab === "network" && job.args[0] === "init" && !before.confirmed && after.confirmed) {
    selectTab("wallet");
    flash("Network settings confirmed. Next: import your wallet.");
  } else if (
    state.tab === "wallet" && ["dest", "import"].includes(job.args[0]) &&
    !before.walletReady && after.walletReady
  ) {
    selectTab("coins");
    flash("Wallet and both fork destinations are set. Next: scan for your coins.");
  }
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
  showProgress(job);
  if (job.done) {
    logLine(`(exit ${job.exitCode})`, job.exitCode ? "err" : "muted");
    setBusy(false);
    const before = progressMarks();
    await refresh();
    const after = progressMarks();
    if (job.args[0] === "plan" && after.plans > before.plans) {
      // The new plan took the picked coins: back to the default (coins not in a plan yet).
      state.planSel = null;
      render();
    }
    autoAdvance(job, before, after);
    if (job.args[0] === "wipe" && job.exitCode === 0 && before.confirmed && !after.confirmed) {
      // Started over: back to the first step with the guide showing.
      state.planSel = null;
      setGuide(true);
      selectTab("network");
      flash("History burned. Start again: confirm the network settings.");
    }
    return;
  }
  setTimeout(pollJob, 400);
}

function ask(question) {
  questionShown = question.id;
  const modal = document.getElementById("modal");
  document.getElementById("modal-text").textContent = question.text;
  // Yes would skip a safety step: No is the default (focused, primary) button.
  const risky = question.recommend === "no";
  document.getElementById("modal-yes").className = risky ? "secondary" : "";
  document.getElementById("modal-no").className = risky ? "" : "secondary";
  modal.classList.remove("hidden");
  if (risky) document.getElementById("modal-no").focus();
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

// Mirrors describeProgress() in src/core/progress.ts.
function describeProgress(p) {
  const chain = p.chain ? `${p.chain.toUpperCase()}: ` : "";
  const label = {
    tor: "Tor",
    identity: "checking server",
    discovery: "addresses checked",
    crosscheck: "cross-checking coins",
  }[p.phase] ?? p.phase;
  let counts = "";
  if (p.done !== undefined) {
    counts = p.phase === "tor"
      ? ` ${p.done}%`
      : p.total !== undefined
      ? ` (${p.done} of ${p.total})`
      : ` (${p.done})`;
  }
  return `${chain}${p.detail ?? label}${counts}`;
}

function elapsed(since) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The "what's happening now" line under the activity header, while a command runs. */
function showProgress(job) {
  const box = document.getElementById("job-progress");
  if (!box) return;
  if (!job || job.done) {
    box.classList.add("hidden");
    for (const el of document.querySelectorAll(".inline-progress")) el.classList.add("hidden");
    return;
  }
  document.getElementById("job-progress-text").textContent = progressText(job);
  box.classList.remove("hidden");
  for (const el of document.querySelectorAll(".inline-progress")) {
    const mine = el.getAttribute("data-cmd") === job.args[0];
    el.classList.toggle("hidden", !mine);
    if (mine) el.querySelector(".inline-progress-text").textContent = progressText(job);
  }
}

function progressText(job) {
  const what = job.progress ? describeProgress(job.progress) : `running ${job.args[0]}`;
  const wait = job.question ? " · waiting for your answer" : "";
  return `${what} · ${elapsed(job.startedAt)}${wait}`;
}

function setBusy(busy) {
  document.getElementById("job-state").textContent = busy ? "running…" : "idle";
  if (!busy) showProgress(null);
  // A button marked data-blocked (e.g. "Create plan" with no coins picked) stays disabled.
  for (const b of document.querySelectorAll("section#view button")) {
    b.disabled = busy || b.hasAttribute("data-blocked");
  }
}

// ---------- data ----------

/** A short message at the top of the page, so an action's result is seen without the log. */
function flash(text) {
  const el = document.getElementById("flash") ??
    document.body.appendChild(h("div", { id: "flash" }));
  el.textContent = text;
  el.className = "flash show";
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => (el.className = "flash"), 6000);
}

async function refresh() {
  try {
    const [overview, status, plans, dev, donors] = await Promise.all([
      api("/api/overview"),
      api("/api/status"),
      api("/api/plans"),
      api("/api/dev"),
      api("/api/donors"),
    ]);
    Object.assign(state, { overview, status, plans, dev, donors });
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
  const fresh = newSharedAfterPlans();
  const pill = document.getElementById("new-shared-pill");
  pill.classList.toggle("hidden", !fresh.length);
  pill.textContent = `${fresh.length} new shared coin${fresh.length === 1 ? "" : "s"}`;
}

/** Coins that turned up shared since an earlier scan (scan.json `newShared`). */
function newShared() {
  return state.status?.scan?.newShared ?? [];
}

/** The same, but only once a split plan exists: that's when spending BTC becomes likely. */
function newSharedAfterPlans() {
  return (state.plans?.plans ?? []).length ? newShared() : [];
}

// ---------- views ----------

/**
 * A progress box shown inside a tab while `cmd` runs. showProgress() fills it on every poll; the
 * view isn't re-rendered while a job runs, so the element stays put.
 */
function inlineProgress(cmd, note) {
  const running = state.job && !state.job.done && state.job.args[0] === cmd;
  return h(
    "div",
    { class: `inline-progress${running ? "" : " hidden"}`, "data-cmd": cmd },
    h(
      "div",
      { class: "row" },
      h("span", { class: "spinner", "aria-hidden": "true" }),
      h("strong", { class: "inline-progress-text" }, running ? progressText(state.job) : ""),
    ),
    h("p", { class: "note" }, note),
  );
}

function scanSettingsCard(o) {
  const st = o.scanSettings ?? { gapLimit: 20, jitterMinMs: 150, jitterMaxMs: 900 };
  const num = (value, min, max) =>
    h("input", { type: "number", min: String(min), max: String(max), value: String(value) });
  const gap = num(st.gapLimit, 1, 1000);
  const jMin = num(st.jitterMinMs, 0, 60000);
  const jMax = num(st.jitterMaxMs, 0, 60000);
  const branches = (o.descriptors ?? []).reduce((n, d) => n + d.firstAddresses.length, 0);
  const estimate = h("p", { class: "note" });
  const updateEstimate = () => {
    const g = Number(gap.value) || 0;
    estimate.textContent = branches
      ? `With ${branches} address branch(es) imported, a scan looks up at least ${
        g * branches
      } addresses per chain on a remote backend, plus every used address.`
      : `Each address branch (receive, change) costs at least ${g} lookups per chain on a remote backend.`;
  };
  gap.addEventListener("input", updateEstimate);
  updateEstimate();
  return h(
    "div",
    { class: "card" },
    h("h2", {}, "Scan settings"),
    h(
      "p",
      { class: "note" },
      "Gap limit: how many unused addresses are checked past the last used one before a branch counts as finished. Raise it if your wallet skipped addresses. Jitter: a random pause between lookups on remote backends, so they don't arrive as one burst. Local nodes ignore both. Saving re-locks importing and scanning until you confirm the network settings again.",
    ),
    h(
      "div",
      { class: "row" },
      h("label", {}, "Gap limit", gap),
      h("label", {}, "Jitter min (ms)", jMin),
      h("label", {}, "Jitter max (ms)", jMax),
      h("button", {
        class: "secondary",
        onclick: () =>
          run([
            "config",
            "scan",
            "--gap-limit",
            String(gap.value).trim(),
            "--jitter",
            `${String(jMin.value).trim()}-${String(jMax.value).trim()}`,
          ]),
      }, "Save scan settings"),
    ),
    estimate,
  );
}

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
    inlineProgress(
      "init",
      "Connecting over Tor can take a minute or more, especially the first time. Each step is listed under Activity.",
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
      "auto: use a Tor already running (or the Tor Browser), else start splayed's own. managed: always start our own. system: only a Tor you run, never start one.",
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

  view.push(scanSettingsCard(o));

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
  // detect: ask the backend which chain it follows and add it there (the chain field is ignored).
  const add = (detect = false) => {
    const args = [
      "config",
      "backend",
      ...(detect ? ["detect"] : ["add", f.chain.value]),
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
    if (detect) args.push("--add");
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
    h(
      "div",
      { class: "row" },
      h("button", { onclick: () => add() }, "Add backend"),
      h("button", {
        class: "secondary",
        title:
          "Ask the backend which chain it follows (checkpoint hashes only) and add it to that chain",
        onclick: () => add(true),
      }, "Detect chain & add"),
    ),
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
    h("h2", {}, "Wallet descriptors (public keys only)"),
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
              h("div", { class: "wallet-summary" }, d.summary),
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
        class: "secondary",
        onclick: () =>
          walletQrImport({
            api,
            h,
            purpose: "import",
            title: "Import a wallet by QR code",
            onUse: (text) => (desc.value = text),
          }),
      }, "Scan QR"),
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
  const destCards = ["ecx", "xbt", ...(advanced || o.destinations.btc ? ["btc"] : [])].map(
    (chain) => {
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
            class: "secondary",
            onclick: () =>
              walletQrImport({
                api,
                h,
                purpose: "dest",
                title: `${chain.toUpperCase()} destination by QR code`,
                onUse: (text) => (input.value = text),
              }),
          }, "Scan QR"),
          h("button", {
            onclick: () =>
              run(["dest", "set", chain, input.value.trim(), "--start-index", start.value || "0"]),
          }, "Set destination"),
        ),
      );
    },
  );
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

const PREVIOUSLY = {
  absent: "not in the previous scan",
  separated: "was separated before: a split left the chain?",
  pending: "was pending before: a split left the chain?",
  spent: "was spent everywhere before",
  unverified: "was unverified before (a chain couldn't be asked)",
};

/** The "coins that turn up later" banner at the top of the Coins tab. */
function newSharedBanner(coins) {
  const n = coins.length;
  const toPlan = newSharedToPlan(plannableCoins());
  return h(
    "div",
    { class: "banner bad new-shared", role: "alert" },
    h(
      "h2",
      {},
      `${n} new shared coin${n === 1 ? "" : "s"} turned up since an earlier scan`,
    ),
    h(
      "p",
      {},
      "These coins are still unspent on two or more chains, so one transaction spending them is valid on each of those chains. Don't spend them on BTC until they are split, even if your other coins are done: that spend would replay onto the forks and you could lose those copies.",
    ),
    h(
      "ul",
      { class: "new-shared-list" },
      ...coins.map((c) =>
        h(
          "li",
          {},
          h("div", { class: "mono" }, `${c.txid}:${c.vout}`),
          h("span", {}, `${btc(c.value)} · unspent on ${c.unspentOn.join("+").toUpperCase()} · `),
          h("span", { class: "muted" }, PREVIOUSLY[c.previously] ?? c.previously),
          h("span", { class: "muted" }, ` · first seen ${new Date(c.firstSeen).toLocaleString()}`),
          " ",
          c.plannedIn?.length
            ? c.broadcastIn?.includes(c.plannedIn[0])
              ? badge(`in plan ${c.plannedIn[0]} · broadcast`, "accepted")
              : badge(`in plan ${c.plannedIn[0]} · not broadcast`, "pending")
            : badge("not in a plan yet", "shared"),
        )
      ),
    ),
    h(
      "p",
      { class: "note" },
      "Next: plan them, then sign, verify and broadcast as before. “Plan these coins” opens the New plan form with only these coins ticked (those already in a plan are left out); “Go to Plans” leaves the form's selection as it is (by default, every shared coin not in a plan yet). Expected after importing another wallet or raising the gap limit; a deposit to an old address or a split that left the chain also shows up here.",
    ),
    h(
      "div",
      { class: "row" },
      toPlan.size ? h("button", { onclick: () => planNewShared(toPlan) }, "Plan these coins") : h(
        "span",
        { class: "muted" },
        "Nothing here to plan again: each coin is in a plan already, or wasn't checked on every chain (scan again).",
      ),
      h("button", { class: "secondary", onclick: () => selectTab("plans") }, "Go to Plans"),
    ),
  );
}

/** "Plan these coins": the New plan form with exactly these coins ticked. */
function planNewShared(keys) {
  state.planSel = new Set(keys);
  selectTab("plans");
  flash(
    `${keys.size} new shared coin${
      keys.size === 1 ? "" : "s"
    } selected in the New plan form. Pick the XBT signer and fees, then Create plan.`,
  );
}

function viewCoins() {
  const s = state.status?.scan;
  const fresh = newShared();
  const isNew = new Set(fresh.map((c) => `${c.txid}:${c.vout}`));
  const view = fresh.length ? [newSharedBanner(fresh)] : [];
  view.push(h(
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
    inlineProgress(
      "scan",
      "Scanning over Tor is slow: every address is looked up separately, with pauses in between. A re-scan after a split takes as long as the first one.",
    ),
    s && s.warnings.length
      ? h("div", { class: "banner bad" }, ...s.warnings.map((w) => h("div", {}, w)))
      : null,
  ));
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
      h(
        "tr",
        {},
        ...["Coin", "Value", "BTC", "XBT", "ECX", "Status", "Split"].map((t) => h("th", {}, t)),
      ),
      ...s.coins.map((c) =>
        h(
          "tr",
          { class: isNew.has(`${c.txid}:${c.vout}`) ? "new-shared-row" : null },
          h(
            "td",
            { class: "mono" },
            short(c.txid, c.vout),
            isNew.has(`${c.txid}:${c.vout}`) ? [" ", badge("new", "new")] : null,
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
                : c.classification.chainSpecific
                ? `${c.classification.chainSpecific.chain.toUpperCase()} only`
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
          h("td", {}, ...splitCell(c, s.confirmations)),
        )
      ),
    ),
    h(
      "p",
      { class: "note" },
      "Split: how far each plan spending the coin has got on each chain (planned, signed, verified, sent, confirmed), from the plan's own records. Click one to open Plans; Track there refreshes the depths.",
    ),
  ));
  return view;
}

/** The Coins tab's Split cell: one badge per chain the coin is planned on. */
function splitCell(c, required) {
  const entries = coinPlanSummary(c.planTxs, required);
  if (!entries.length) {
    return c.classification.status === "shared"
      ? [h("span", { class: "muted" }, "not planned")]
      : [];
  }
  return entries.map((e) =>
    h(
      "div",
      {},
      h("span", {
        class: `badge ${e.cls} link`,
        title: e.title,
        role: "button",
        tabindex: "0",
        onclick: () => selectTab("plans"),
        onkeydown: (ev) => {
          if (ev.key === "Enter") selectTab("plans");
        },
      }, e.text),
    )
  );
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

/** Asks for the new rate, showing each transaction's current rate and the least it can be. */
function bump(planId, scope, txs) {
  state.lastPlan = planId;
  const rate = prompt(bumpQuestion(txs), "");
  if (rate === null) return;
  const args = ["bump", planId, ...scope];
  if (rate.trim()) {
    if (!/^\d+(\.\d+)?$/u.test(rate.trim())) return logLine("Fee rate must be a number", "err");
    const chains = scope[0] === "--chains" ? [scope[1]] : ["ecx", "xbt"];
    args.push("--fee-rate", chains.map((c) => `${c}=${rate.trim()}`).join(","));
  }
  run(args);
}

async function mineBlocks(chain, blocks) {
  try {
    const r = await api("/api/dev/mine", {
      method: "POST",
      body: JSON.stringify({ chain, blocks }),
    });
    logLine(`Mined ${blocks} on ${chain}: ${JSON.stringify(r.heights)}`);
    flash(`Mined ${blocks} block(s) on ${chain === "all" ? "every chain" : chain.toUpperCase()}.`);
    await refresh();
    // The plan last worked on (its Broadcast/Track/Fee bump buttons), else the newest sent one.
    const sent = (p) => !p.archivedAt && p.transactions.some((t) => t.progress.broadcast);
    const plans = state.plans?.plans ?? [];
    const latest = plans.find((p) => p.id === state.lastPlan && sent(p)) ?? plans.find(sent);
    if (latest) run(["track", latest.id]);
  } catch (e) {
    logLine(`Mining failed: ${e.message}`, "err");
  }
}

function devCard() {
  if (!state.dev?.enabled) return null;
  const heights = state.dev.heights;
  const counts = [1, 6];
  return h(
    "div",
    { class: "card" },
    h("h2", {}, "Regtest tools (test environment only)"),
    h(
      "p",
      { class: "note" },
      "Heights: " +
        Object.entries(heights).map(([c, n]) => `${c.toUpperCase()} ${n}`).join(" · ") +
        ". After mining, the newest broadcast plan is tracked for you.",
    ),
    ...[...Object.keys(heights), "all"].map((c) =>
      h(
        "div",
        { class: "row" },
        h("span", { class: "mono" }, c === "all" ? "ALL" : c.toUpperCase()),
        ...counts.map((n) =>
          h("button", { class: "small secondary", onclick: () => mineBlocks(c, n) }, `Mine ${n}`)
        ),
      )
    ),
  );
}

// Fee boxes: "auto" asks the backend for an estimate. A regtest node has none, so in the
// playground they start at 2 sat/vB instead of failing with "No fee estimate".
function feeInput() {
  const dev = state.dev?.enabled;
  return h("input", {
    placeholder: "auto",
    class: "w80",
    value: dev ? "2" : undefined,
    title: dev ? "Regtest nodes have no fee estimates, so this starts at 2 sat/vB" : undefined,
  });
}

/**
 * Keeps a Donors-tab field's value in state.donorForm[key] across re-renders (ticking a donor,
 * or a job finishing, rebuilds the view).
 */
function keepValue(key, el) {
  const form = state.donorForm;
  const box = el.type === "checkbox";
  if (form[key] !== undefined) {
    if (box) el.checked = form[key];
    else el.value = form[key];
  }
  const save = () => (form[key] = box ? el.checked : el.value);
  el.addEventListener("input", save);
  el.addEventListener("change", save);
  return el;
}

function viewDonors() {
  const d = state.donors ?? { descriptors: [], scan: null };
  // A donor import that went through clears the pasted descriptor; a refused one keeps it.
  const job = state.job;
  if (
    job?.done && job.exitCode === 0 && job.args[0] === "donor" && job.args[1] === "import" &&
    state.donorForm.clearedFor !== job.id && job.args[2] === state.donorForm.desc?.trim()
  ) {
    state.donorForm.clearedFor = job.id;
    state.donorForm.desc = "";
    state.donorForm.label = "";
  }
  const desc = keepValue(
    "desc",
    h("input", { placeholder: "donor wallet descriptor", class: "grow" }),
  );
  const label = keepValue("label", h("input", { placeholder: "label (optional)", class: "w160" }));
  const importIt = () => {
    if (!desc.value.trim()) return alert("Paste the donor wallet descriptor first.");
    const args = ["donor", "import", desc.value.trim()];
    if (label.value.trim()) args.push("--label", label.value.trim());
    run(args);
  };
  const coins = d.scan?.coins ?? [];
  const selected = [...state.donorSel].filter((k) =>
    coins.some((c) => `${c.txid}:${c.vout}` === k && c.eligible)
  );
  const rows = coins.map((c) => {
    const key = `${c.txid}:${c.vout}`;
    const box = h("input", {
      type: "checkbox",
      disabled: !c.eligible,
      onchange: (e) => {
        if (e.target.checked) state.donorSel.add(key);
        else state.donorSel.delete(key);
        render();
      },
    });
    box.checked = state.donorSel.has(key) && c.eligible;
    return h(
      "tr",
      {},
      h("td", {}, box),
      h("td", { class: "mono" }, short(c.txid, c.vout)),
      h("td", {}, btc(c.value)),
      h("td", { class: "mono" }, c.address ?? ""),
      h(
        "td",
        {},
        `${(c.home ?? "xbt").toUpperCase()} · ${c.provenance}`,
        c.funding ? h("div", { class: "muted" }, c.funding) : null,
      ),
      h(
        "td",
        {},
        c.eligible ? badge("usable", "verified") : badge("not usable", "rejected"),
        c.eligible ? null : h("div", { class: "muted" }, c.reasons.join("; ")),
      ),
    );
  });

  const outputs = keepValue("outputs", h("input", { value: "3", class: "w60" }));
  const each = keepValue("each", h("input", { placeholder: "even split", class: "w120" }));
  const feeXbt = keepValue("feeFanout", feeInput());
  const homes = new Set(
    selected.map((k) => coins.find((c) => `${c.txid}:${c.vout}` === k).home ?? "xbt"),
  );
  const home = homes.size === 1 ? [...homes][0] : null;
  const fanout = () => {
    if (!home) return alert("Fan out donors of one chain at a time (XBT donors, or BTC donors).");
    const args = ["donor", "fanout", "--outputs", outputs.value.trim() || "3"];
    for (const k of selected) args.push("--donor", k);
    if (each.value.trim()) args.push("--value", each.value.trim());
    if (feeXbt.value.trim()) args.push("--fee-rate", `${home}=${feeXbt.value.trim()}`);
    run(args);
  };
  const batch = keepValue(
    "batch",
    h(
      "select",
      {},
      ...[["coin", "one coin per transaction (needs one donor each)"], [
        "all",
        "all coins in one transaction (one donor, links the coins)",
      ]].map(([v, t]) => h("option", { value: v }, t)),
    ),
  );
  const alsoEcx = h("input", { type: "checkbox" });
  alsoEcx.checked = true;
  keepValue("alsoEcx", alsoEcx);
  const feeXbt2 = keepValue("feePlan", feeInput());
  const planWith = () => {
    if (!home) return alert("Select donors of one chain: XBT donors, or BTC donors.");
    const args = ["plan", "--batch", batch.value];
    const rate = feeXbt2.value.trim();
    if (home === "btc") {
      // BTC-first: BTC with the donor, ECX with its locktime, then XBT plain and held back.
      args.push("--btc-first", "--chains", alsoEcx.checked ? "btc,ecx,xbt" : "btc,xbt");
      if (rate) args.push("--fee-rate", ["btc", "ecx", "xbt"].map((c) => `${c}=${rate}`).join(","));
    } else {
      args.push("--chains", alsoEcx.checked ? "ecx,xbt" : "xbt");
      if (rate) args.push("--fee-rate", `xbt=${rate}`);
    }
    for (const k of selected) args.push("--donor", k);
    run(args);
  };

  return [
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Advanced: donor routes"),
      h(
        "p",
        { class: "note" },
        "A donor is a coin that exists on ONE chain only, so a transaction that also spends it can't be valid on the others. That lets your shared coins be signed with a plain SIGHASH_ALL signature (stock hardware wallets can do that) instead of needing a special signer.",
      ),
      h(
        "p",
        { class: "note" },
        "XBT donors (forks first): the XBT split spends an XBT-only donor, which replaces the 0x21 signer. ECX keeps its locktime and BTC is left alone until the forks are split.",
      ),
      h(
        "p",
        { class: "note" },
        "BTC donors (BTC first): your BTC copy is moved first, with a BTC-only donor next to it. Then ECX, then XBT with a plain signature; the XBT files are held back until the coin is spent and confirmed on BTC and ECX. This needs a BTC destination: set it in Wallet. Tick BTC donors below and “Create plan with donors” builds this route.",
      ),
      h(
        "p",
        { class: "note" },
        "A donor must be absent from the other chains and have a provable origin: a coinbase of its chain, an output of a split this tool verified, or a donor funded elsewhere whose funding transaction can be traced on chain. Every donor you spend publicly links the donor wallet to the coins it is spent with, and its value ends up at the destination on that chain.",
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Donor wallet"),
      ...d.descriptors.map((x, i) =>
        h(
          "div",
          { class: "row" },
          h(
            "span",
            { class: "mono" },
            `${i + 1}. ${x.label ? `[${x.label}] ` : ""}${x.descriptor}`,
          ),
          h("span", { class: "muted" }, `next fan-out index ${x.nextIndex}`),
          h("button", {
            class: "small secondary",
            onclick: () =>
              confirm("Remove this donor wallet?") && run(["donor", "forget", String(i + 1)]),
          }, "Remove"),
        )
      ),
      d.descriptors.length ? null : h("p", { class: "muted" }, "No donor wallet imported yet."),
      h(
        "div",
        { class: "row" },
        desc,
        label,
        h("button", { onclick: importIt }, "Import donor wallet"),
        d.descriptors.length
          ? h("button", { onclick: () => run(["donor", "scan"]) }, "Scan donors")
          : null,
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Donor coins"),
      d.scan
        ? h(
          "p",
          { class: "note" },
          `Scanned ${new Date(d.scan.scannedAt).toLocaleString()}. Tick the donors to use.`,
        )
        : h("p", { class: "muted" }, "Not scanned yet."),
      ...(d.scan?.warnings ?? []).map((w) => h("div", { class: "note" }, `⚠ ${w}`)),
      coins.length
        ? h(
          "table",
          {},
          h(
            "tr",
            {},
            ...["", "Donor", "Value", "Address", "Origin", "Status"].map((x) => h("th", {}, x)),
          ),
          ...rows,
        )
        : null,
      h("p", { class: "note" }, `${selected.length} donor(s) selected.`),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Fan out the selected donors"),
      h(
        "p",
        { class: "note" },
        "Splits each selected donor into smaller donors of your donor wallet, one transaction per donor so donors stay unlinked. Sign the result with the donor wallet (plain SIGHASH_ALL), then verify and broadcast it in Plans, and scan donors again.",
      ),
      h(
        "div",
        { class: "row" },
        h("label", {}, "New donors each", outputs),
        h("label", {}, "Sats per new donor", each),
        h("label", {}, "Fee (sat/vB)", feeXbt),
        // data-blocked keeps it disabled when setBusy(false) re-enables the other buttons.
        h("button", {
          disabled: !selected.length,
          "data-blocked": !selected.length,
          title: selected.length ? undefined : "Tick at least one usable donor above",
          onclick: fanout,
        }, "Create fan-out PSBT(s)…"),
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Plan the splits with the selected donors"),
      h(
        "p",
        { class: "note" },
        home === "btc"
          ? "BTC-first route (BTC donors): your BTC copy is split first with a BTC-only donor, ECX with its locktime, and XBT last with a plain signature. The XBT files are held back until the coin is spent and confirmed on BTC and ECX. Set a BTC destination first (Destinations, in Advanced). Each BTC transaction uses one selected donor."
          : "Replaces the XBT signer: no 0x21 needed. Each XBT transaction uses one selected donor, so pick as many as the batching needs. Your signer must sign the donor input too.",
      ),
      h(
        "div",
        { class: "row" },
        h("label", {}, "Batching", batch),
        h("label", {}, "Fee (sat/vB)", feeXbt2),
        h("label", { class: "check" }, alsoEcx, " also plan ECX"),
        h("button", {
          disabled: !selected.length,
          "data-blocked": !selected.length,
          title: selected.length ? undefined : "Tick at least one usable donor above",
          onclick: planWith,
        }, "Create plan with donors"),
      ),
    ),
  ];
}

/** Archived plans: still on disk (donor records and fee-bump links read them), just out of the way. */
function archivedPlansCard(plans) {
  return h(
    "div",
    { class: "card" },
    h(
      "details",
      {},
      h("summary", {}, `Archived plans (${plans.length})`),
      h(
        "p",
        { class: "note" },
        "Archived plans are hidden here but kept on disk. Deleting is refused while a plan has transactions that were sent and aren't confirmed yet.",
      ),
      h(
        "table",
        {},
        h(
          "tr",
          {},
          ...["Plan", "Created", "Archived", "Transactions", ""].map((x) => h("th", {}, x)),
        ),
        ...plans.map((p) =>
          h(
            "tr",
            {},
            h("td", { class: "mono" }, p.id),
            h("td", {}, new Date(p.createdAt).toLocaleString()),
            h("td", {}, p.archivedAt === "unknown" ? "" : new Date(p.archivedAt).toLocaleString()),
            h("td", {}, String(p.transactions.length)),
            h(
              "td",
              {},
              h(
                "button",
                { class: "secondary", onclick: () => run(["plans", "unarchive", p.id]) },
                "Restore",
              ),
              " ",
              h(
                "button",
                { class: "danger", onclick: () => run(["plans", "delete", p.id]) },
                "Delete…",
              ),
            ),
          )
        ),
      ),
    ),
  );
}

const outpoint = (c) => `${c.txid}:${c.vout}`;

/**
 * Coins a new guided plan could take: still shared per the last scan and unspent on a fork (the
 * planner's own candidates, before its live re-check). `forks` = the chains to split it from.
 */
function plannableCoins() {
  return (state.status?.scan?.coins ?? [])
    .filter((c) => c.classification.status === "shared")
    .map((c) => ({ ...c, forks: c.classification.unspentOn.filter((ch) => ch !== "btc") }))
    .filter((c) => c.forks.length);
}

/** The default pick: every plannable coin that no plan (archived ones aside) spends yet. */
function defaultPlanSelection(coins) {
  return new Set(coins.filter((c) => !c.plannedIn?.length).map(outpoint));
}

/** New shared coins (see the Coins tab banner) that can be planned and aren't in a plan yet. */
function newSharedToPlan(coins) {
  const fresh = new Set(newShared().map(outpoint));
  return new Set(
    coins.filter((c) => fresh.has(outpoint(c)) && !c.plannedIn?.length).map(outpoint),
  );
}

/** The coins picked now: the user's choice (minus coins no longer plannable), or the default. */
function planSelection(coins) {
  if (!state.planSel) return defaultPlanSelection(coins);
  const keys = new Set(coins.map(outpoint));
  return new Set([...state.planSel].filter((k) => keys.has(k)));
}

/** Coins per plan the form can pass: one `--coin txid:vout` each, within the job's arg limit. */
const MAX_PICKED_COINS = 250;

/**
 * The "Coins" part of the New plan form. The selection lives in state.planSel, so it survives the
 * re-render after every job; ticking a box only updates the summary, not the whole view.
 */
function coinPicker(coins, signer, onCreate) {
  const fresh = new Set(newShared().map(outpoint));
  const somePlanned = coins.some((c) => c.plannedIn?.length);
  /** CLI args for the picked coins: none when that is every coin and none was planned before. */
  const coinArgs = () => {
    const picked = planSelection(coins);
    if (picked.size === coins.length && !somePlanned) return [];
    return coins.filter((c) => picked.has(outpoint(c))).flatMap((c) => ["--coin", outpoint(c)]);
  };
  const boxes = new Map();
  const summary = h("span", { class: "muted" });
  const reason = h("span", { class: "picker-reason" });
  const createBtn = h("button", { onclick: () => onCreate(coinArgs()) }, "Create plan");
  const update = () => {
    const sel = planSelection(coins);
    const picked = coins.filter((c) => sel.has(outpoint(c)));
    const total = picked.reduce((sum, c) => sum + c.value, 0);
    summary.textContent = coins.length
      ? `${picked.length} of ${coins.length} coin${coins.length === 1 ? "" : "s"} selected · ${
        btc(total)
      }`
      : "";
    const xbtOnly = picked.filter((c) => !c.forks.includes("ecx")).length;
    let why = "";
    if (!state.status?.scan) why = "Scan first (Coins tab): a plan uses the last scan.";
    else if (!coins.length) why = "No shared coins left to split, per the last scan.";
    else if (!picked.length) why = "Select at least one coin.";
    else if (picked.length > MAX_PICKED_COINS && coinArgs().length) {
      why = `Select at most ${MAX_PICKED_COINS} coins per plan (or all of them).`;
    } else if (!signer.value && xbtOnly === picked.length) {
      why = "The selected coins are only shared with XBT: pick an XBT signer.";
    }
    reason.textContent = why ||
      (!signer.value && xbtOnly
        ? `${xbtOnly} selected coin${
          xbtOnly === 1 ? " is" : "s are"
        } only shared with XBT and left out without an XBT signer.`
        : "");
    reason.className = why ? "picker-reason bad" : "picker-reason muted";
    createBtn.toggleAttribute("data-blocked", !!why);
    createBtn.disabled = !!why || !!(state.job && !state.job.done);
    createBtn.title = why;
  };
  const choose = (keys) => {
    state.planSel = new Set(keys);
    for (const [k, box] of boxes) box.checked = state.planSel.has(k);
    update();
  };
  signer.addEventListener("change", update);
  const sel = planSelection(coins);
  const rows = coins.map((c) => {
    const k = outpoint(c);
    const box = h("input", {
      type: "checkbox",
      "aria-label": `Include ${k}`,
      onchange: () => {
        const next = planSelection(coins);
        if (box.checked) next.add(k);
        else next.delete(k);
        state.planSel = next;
        update();
      },
    });
    box.checked = sel.has(k);
    boxes.set(k, box);
    const latest = c.plannedIn?.[0];
    const unconfirmed = c.forks.some((ch) => c.observations[ch]?.createdHeight === undefined);
    return h(
      "tr",
      { class: fresh.has(k) ? "new-shared-row" : null },
      h("td", {}, h("label", { class: "inline mono" }, box, short(c.txid, c.vout))),
      h("td", {}, btc(c.value)),
      h("td", {}, c.forks.join("+").toUpperCase()),
      h(
        "td",
        {},
        fresh.has(k) ? [badge("new", "new"), " "] : null,
        latest
          ? h(
            "span",
            {
              class: `badge ${c.broadcastIn?.includes(latest) ? "accepted" : "pending"}`,
              title: c.plannedIn.length > 1 ? `Also in: ${c.plannedIn.slice(1).join(", ")}` : null,
            },
            `in plan ${latest} · ${
              c.broadcastIn?.includes(latest) ? "broadcast" : "not broadcast"
            }${c.plannedIn.length > 1 ? ` (+${c.plannedIn.length - 1} more)` : ""}`,
          )
          : null,
        unconfirmed
          ? h("div", { class: "muted" }, "unconfirmed: the plan skips it until it confirms")
          : null,
      ),
    );
  });
  const someNew = newSharedToPlan(coins).size > 0;
  const section = coins.length
    ? [
      h("h3", {}, "Coins"),
      h(
        "p",
        { class: "note" },
        "Coins still shared per the last scan, and the forks each one is split from. Coins already in a plan start unticked: planning them again makes a second transaction spending the same coin, and only one of the two can confirm.",
      ),
      h(
        "div",
        { class: "row" },
        h("button", {
          class: "small secondary",
          onclick: () => choose(coins.map(outpoint)),
        }, "Select all"),
        h("button", { class: "small secondary", onclick: () => choose([]) }, "Select none"),
        someNew
          ? h("button", {
            class: "small secondary",
            onclick: () => choose(newSharedToPlan(coins)),
          }, "Only new shared coins")
          : null,
        somePlanned
          ? h("button", {
            class: "small secondary",
            onclick: () => choose(defaultPlanSelection(coins)),
          }, "Only coins not in a plan")
          : null,
      ),
      h(
        "div",
        { class: "coin-picker" },
        h(
          "table",
          {},
          h("tr", {}, ...["Coin", "Value", "Split from", ""].map((t) => h("th", {}, t))),
          ...rows,
        ),
      ),
    ]
    : [];
  update();
  return { section, footer: h("div", { class: "row" }, createBtn, summary, reason) };
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
  const feeEcx = feeInput();
  const feeXbt = feeInput();
  const picker = coinPicker(plannableCoins(), signer, (coinArgs) => {
    const chains = signer.value ? "ecx,xbt" : "ecx";
    const args = ["plan", "--chains", chains, "--batch", batch.value];
    if (signer.value) args.push("--xbt-signer", signer.value);
    const fees = [
      feeEcx.value.trim() ? `ecx=${feeEcx.value.trim()}` : "",
      signer.value && feeXbt.value.trim() ? `xbt=${feeXbt.value.trim()}` : "",
    ].filter(Boolean);
    if (fees.length) args.push("--fee-rate", fees.join(","));
    run([...args, ...coinArgs]);
  });
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
    ),
    // After the signer and fee fields: docs_screenshots.ts finds those as the tab's first select
    // and first input.
    ...picker.section,
    picker.footer,
  )];
  const allPlans = state.plans?.plans ?? [];
  // "1 of 2 signatures": a multisig's cosigners each sign the same PSBT and upload it.
  const sigText = (sg) => sg ? `${sg.have} of ${sg.need} signature${sg.need === 1 ? "" : "s"}` : "";
  const sigNext = (sg) =>
    sg && sg.have < sg.need
      ? ` Needs ${sg.need - sg.have} more: sign it with another cosigner and upload that too.`
      : " Press Verify next.";
  for (const p of allPlans.filter((x) => !x.archivedAt)) {
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
          flash(
            `Signed file received for ${t.chain.toUpperCase()} #${t.order} (${
              sigText(r.signatures)
            }).${sigNext(r.signatures)}`,
          );
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
        h(
          "td",
          { class: "mono" },
          t.outputs > 1
            ? `${t.outputs} donor outputs, first: ${t.output.address}`
            : t.output.address,
          t.donor
            ? h("div", {}, badge("donor", "test"), ` ${short(t.donor.txid, t.donor.vout)}`)
            : null,
          t.gate ? h("div", { class: "muted" }, "held back until BTC and ECX are confirmed") : null,
        ),
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
          " ",
          h(
            "button",
            {
              class: "small secondary",
              title: "Show this PSBT as animated QR codes for an air-gapped signer",
              onclick: () =>
                showPsbtQr({
                  api,
                  h,
                  planId: p.id,
                  file: t.file,
                  label: `${t.chain.toUpperCase()} #${t.order}`,
                }),
            },
            "QR",
          ),
        ),
        h(
          "td",
          {},
          t.signedUpload
            ? h(
              "div",
              { class: "note" },
              `✓ received ${t.signedUpload.at ? t.signedUpload.at.slice(11, 19) + " UTC" : ""}` +
                (t.signedUpload.signatures ? `, ${sigText(t.signedUpload.signatures)}` : ""),
              h("div", { class: "muted mono" }, t.signedUpload.name),
            )
            : null,
          fileInput,
          h("button", { class: "small secondary", onclick: upload }, "Upload signed"),
          " ",
          h(
            "button",
            {
              class: "small secondary",
              title: "Read the signed PSBT from your signer's animated QR codes",
              onclick: () =>
                scanSignedPsbt({
                  api,
                  h,
                  planId: p.id,
                  file: t.file,
                  label: `${t.chain.toUpperCase()} #${t.order}`,
                  onSaved: async (r) => {
                    await refresh();
                    flash(
                      `Signed PSBT received for ${t.chain.toUpperCase()} #${t.order} (${
                        sigText(r?.signatures)
                      }).${sigNext(r?.signatures)}`,
                    );
                  },
                }),
            },
            "Scan signed",
          ),
        ),
        h(
          "td",
          {},
          pr.verified ? badge("verified", "verified") : t.signedUpload?.signatures &&
              t.signedUpload.signatures.have < t.signedUpload.signatures.need
            ? badge(
              `needs ${
                t.signedUpload.signatures.need - t.signedUpload.signatures.have
              } more signature(s)`,
              "pending",
            )
            : t.signedUpload
            ? badge("signed file uploaded: press Verify", "pending")
            : badge("not verified", ""),
          pr.broadcast ? h("div", {}, badge(pr.broadcast.status, pr.broadcast.status)) : null,
          depthText(pr) ? h("div", { class: "muted" }, depthText(pr)) : null,
          t.replaces
            ? h(
              "div",
              { class: "muted" },
              `replaces ${t.replaces.txid.slice(0, 8)}… in ${t.replaces.plan}`,
            )
            : null,
          pr.replacedBy
            ? h("div", { class: "muted" }, `replaced by plan ${pr.replacedBy.plan}`)
            : null,
          pr.supersededBy
            ? h(
              "div",
              { class: "muted" },
              `superseded by plan ${pr.supersededBy.plan}: it spent this coin first`,
            )
            : null,
          pr.pendingBump
            ? h(
              "div",
              { class: "muted" },
              `bump written: plan ${pr.pendingBump.plan} (not sent yet)`,
            )
            : null,
          pr.reorgs?.length
            ? h(
              "div",
              { class: "muted" },
              pr.reorgs.some(isOpenAlert)
                ? `${pr.reorgs.length} alert(s), see above`
                : `${pr.reorgs.length} alert(s), resolved or acknowledged`,
            )
            : null,
          t.chain !== "btc" && bumpable(pr)
            ? h("button", {
              class: "small secondary nowrap",
              onclick: () => bump(p.id, ["--chains", t.chain, "--tx", String(t.order)], [t]),
            }, "Fee bump…")
            : null,
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
      ...reorgAlerts(p.transactions).map((a) =>
        h("div", { class: a.active ? "alert" : "alert resolved" }, a.text)
      ),
      reorgAlerts(p.transactions).some((a) => a.active)
        ? h(
          "div",
          { class: "row" },
          h(
            "button",
            {
              class: "small secondary",
              title:
                "Mute these alerts once you have dealt with them, or decided to leave them. They stay on record. Track asks first.",
              onclick: () => run(["track", p.id, "--ack"]),
            },
            "Acknowledge alerts…",
          ),
        )
        : null,
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
        h("button", {
          onclick: () => {
            state.lastPlan = p.id;
            run(["broadcast", p.id]);
          },
        }, "Broadcast verified"),
        h("button", {
          class: "danger",
          onclick: () =>
            confirm(
              "Broadcast everything now, without waiting for the TEST FIRST transactions to confirm?",
            ) && run(["broadcast", p.id, "--all"]),
        }, "Broadcast all now…"),
        h(
          "button",
          {
            class: "secondary",
            onclick: () => {
              state.lastPlan = p.id;
              run(["track", p.id]);
            },
          },
          "Track confirmations",
        ),
        p.transactions.some((t) => t.chain !== "btc" && bumpable(t.progress))
          ? h(
            "button",
            {
              class: "secondary",
              onclick: () =>
                bump(
                  p.id,
                  [],
                  p.transactions.filter((t) => t.chain !== "btc" && bumpable(t.progress)),
                ),
            },
            "Fee bump all unconfirmed…",
          )
          : null,
        h("span", { class: "grow" }),
        h(
          "button",
          { class: "secondary", onclick: () => run(["plans", "archive", p.id]) },
          "Archive",
        ),
        h(
          "button",
          { class: "danger", onclick: () => run(["plans", "delete", p.id]) },
          "Delete…",
        ),
      ),
    ));
  }
  const archived = allPlans.filter((x) => x.archivedAt);
  if (archived.length) view.push(archivedPlansCard(archived));
  const dev = devCard();
  if (dev) view.push(dev);
  return view;
}

function render() {
  headerPills();
  const view = document.getElementById("view");
  view.replaceChildren();
  if (!token) {
    view.append(signInForm());
    return;
  }
  if (!state.overview) return;
  const content = {
    network: viewNetwork,
    wallet: viewWallet,
    coins: viewCoins,
    plans: viewPlans,
    donors: viewDonors,
  }[state.tab]();
  const guide = guideOn ? setupGuide() : null;
  view.append(...(guide ? [guide] : []), ...[content].flat());
  setBusy(!!(state.job && !state.job.done));
}

/**
 * The first-run guide: the steps of the guided route, each ticked off from the real state (not
 * from clicks), with the next one explained and a button to its tab.
 */
function guideSteps() {
  const o = state.overview ?? {};
  const dests = o.destinations ?? {};
  const plans = (state.plans?.plans ?? []).filter((p) => !p.archivedAt);
  const newest = plans[0];
  const sent = (t) => ["accepted", "replaced"].includes(t.progress?.broadcast?.status);
  return [
    {
      tab: "network",
      title: "Confirm the network settings",
      done: !!o.confirmed,
      help:
        "Check where each chain's queries go (Tor by default), then press “Check servers & confirm”. Nothing about your coins is sent before that.",
    },
    {
      tab: "wallet",
      title: "Import your wallet",
      done: (o.descriptors ?? []).length > 0,
      help:
        "Add the watch-only descriptor of the wallet holding the coins: Scan QR reads your signer's xpub export (multisig: scan each cosigner), or paste the descriptor. Keys never leave your signer.",
    },
    {
      tab: "wallet",
      title: "Set the ECX and XBT destinations",
      done: !!dests.ecx && !!dests.xbt,
      help:
        "Where each fork's split coins go. Best: a new seed for each fork, so the copies never share keys again.",
    },
    {
      tab: "coins",
      title: "Scan for your coins",
      done: !!state.status?.scan,
      help:
        "Finds your coins on all three chains and shows which are still shared. Over Tor this takes a while.",
    },
    {
      tab: "plans",
      title: "Create a plan",
      done: plans.length > 0,
      help:
        "Pick the signer for XBT (it must make SIGHASH_UNIFIED signatures) and how to batch coins. splayed writes unsigned PSBTs; start with one small coin.",
    },
    {
      tab: "plans",
      title: "Sign, verify and broadcast",
      done: !!newest && newest.transactions.every(sent),
      help:
        "Sign each PSBT in your wallet (QR or file), upload it, then Verify and Broadcast. The TEST FIRST transaction goes alone; then Track confirmations until both forks are deep. BTC stays untouched.",
    },
  ];
}

function setupGuide() {
  if (!state.overview || state.overview.configError) return null;
  const steps = guideSteps();
  const current = steps.findIndex((s) => !s.done);
  const tabLabel = { network: "Network", wallet: "Wallet", coins: "Coins", plans: "Plans" };
  const list = h(
    "ol",
    { class: "guide-steps" },
    ...steps.map((s, i) =>
      h(
        "li",
        { class: s.done ? "done" : i === current ? "current" : "" },
        h("span", { class: "guide-mark", "aria-hidden": "true" }, s.done ? "✓" : String(i + 1)),
        h("span", {}, s.title),
      )
    ),
  );
  const next = current === -1
    ? h(
      "p",
      { class: "note" },
      "All steps done for the newest plan. Keep tracking confirmations until both forks are deep; only then spend the BTC copies.",
    )
    : h(
      "div",
      { class: "guide-next" },
      h("strong", {}, `Next: ${steps[current].title}. `),
      h("span", {}, steps[current].help),
      state.tab === steps[current].tab ? null : h("button", {
        class: "secondary",
        onclick: () => selectTab(steps[current].tab),
      }, `Go to ${tabLabel[steps[current].tab]}`),
    );
  const fresh = newSharedAfterPlans();
  const alert = fresh.length
    ? h(
      "div",
      { class: "guide-alert" },
      h(
        "strong",
        {},
        `${fresh.length} new shared coin${
          fresh.length === 1 ? "" : "s"
        } turned up after you started splitting. `,
      ),
      h("span", {}, "Don't spend them on BTC until they're split: plan them like the others."),
      state.tab === "coins"
        ? null
        : h("button", { class: "secondary", onclick: () => selectTab("coins") }, "Show coins"),
    )
    : null;
  return h(
    "div",
    { class: "card guide" },
    h(
      "div",
      { class: "row guide-head" },
      h("h2", {}, "Setup guide"),
      h("span", { class: "grow" }),
      h("button", { class: "secondary", onclick: () => setGuide(false) }, "Hide guide"),
    ),
    list,
    alert,
    next,
  );
}

function selectTab(tab) {
  state.tab = tab;
  for (const x of document.querySelectorAll("#tabs button[data-tab]")) {
    x.classList.toggle("active", x.dataset.tab === tab);
  }
  render();
}
document.getElementById("new-shared-pill").addEventListener("click", () => selectTab("coins"));
for (const b of document.querySelectorAll("#tabs button[data-tab]")) {
  b.addEventListener("click", () => selectTab(b.dataset.tab));
}
applyAdvanced();
applyGuide();

setInterval(async () => {
  if (!state.overview || !token) return;
  try {
    state.overview.tor.status = await api("/api/tor");
    headerPills();
  } catch { /* ignore */ }
}, 2000);

async function start() {
  if (!token) return render();
  await refresh();
  const current = await api("/api/jobs/current").catch(() => null);
  if (current && !current.done) {
    state.job = current;
    state.after = 0;
    setBusy(true);
    pollJob();
  }
}
start();
