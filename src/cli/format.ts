import type { OutputObservation } from "../backends/types.ts";
import type { BackendConfig } from "../core/config.ts";
import type { Route } from "../net/transport.ts";

export function sats(value: number): string {
  const whole = Math.floor(value / 100_000_000);
  const frac = String(value % 100_000_000).padStart(8, "0");
  return `${whole}.${frac}`;
}

export function shortOutpoint(txid: string, vout: number): string {
  return `${txid.slice(0, 8)}…${txid.slice(-4)}:${vout}`;
}

export function privacyLevel(backend: BackendConfig, route: Route): string {
  if (route.via === "direct") {
    if (route.hostClass === "loopback") return "local (this machine)";
    if (route.hostClass === "lan") return "self-hosted (local network)";
    return "PUBLIC CLEARNET - reveals your IP";
  }
  const viaTor = route.tor ? "Tor" : "custom SOCKS5";
  if (route.hostClass === "onion") {
    return backend.origin === "profile-default"
      ? `public onion service via ${viaTor}`
      : `onion service via ${viaTor}`;
  }
  return `public server via ${viaTor} exit`;
}

export function observationCell(obs: OutputObservation | undefined, tip?: number): string {
  if (!obs) return "-";
  switch (obs.state) {
    case "unspent":
      return obs.createdHeight === undefined
        ? "UNSPENT (unconf)"
        : `UNSPENT${tip !== undefined ? ` (${tip - obs.createdHeight + 1} conf)` : ""}`;
    case "spent":
      if (obs.spendHeight !== undefined && tip !== undefined) {
        return `spent (${tip - obs.spendHeight + 1} deep)`;
      }
      return obs.spendDetailKnown ? "spent (unconf)" : "spent (depth ?)";
    case "absent":
      return "absent";
    case "gone":
      return "spent/absent ?";
    case "unknown":
      return "UNKNOWN";
  }
}

export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  }
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd())
    .join("\n");
}
