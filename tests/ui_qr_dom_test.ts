import { assert, assertEquals } from "./assert.ts";
import { psbtToUr } from "../src/core/ur.ts";

/** Just enough DOM for src/ui/static/qr.js to run: elements, text, a recording 2d context. */
class El {
  children: (El | string)[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, (() => void)[]> = {};
  className = "";
  textContent = "";
  width = 0;
  height = 0;
  value = "";
  fills = 0;
  constructor(readonly tag: string) {}
  append(...c: (El | string)[]) {
    this.children.push(...c);
    // A <select> takes the value of its selected option.
    for (const o of c) {
      if (o instanceof El && o.tag === "option" && "selected" in o.attrs) {
        this.value = o.attrs.value;
      }
    }
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(k: string, f: () => void) {
    (this.listeners[k] ??= []).push(f);
  }
  remove() {}
  getContext() {
    const self = this;
    return {
      fillStyle: "",
      fillRect() {
        self.fills++;
      },
    };
  }
}

Deno.test("UI QR (browser module): the export view draws frames with the API the UI really has", async () => {
  const g = globalThis as Record<string, unknown>;
  const module = { exports: {} as unknown };
  new Function("module", "exports", await Deno.readTextFile("src/ui/static/vendor/qrcode.js"))(
    module,
    module.exports,
  );
  g.qrcode = module.exports;
  const canvases: El[] = [];
  g.document = {
    createElement: (tag: string) => {
      const e = new El(tag);
      if (tag === "canvas") canvases.push(e);
      return e;
    },
    createTextNode: (t: string) => t,
    body: new El("body"),
  };
  // As in app.js: JSON responses come back already parsed (not as a Response).
  const psbt = new Uint8Array(400).map((_, i) => i & 255);
  const calls: string[] = [];
  const api = (path: string) => {
    calls.push(path);
    return Promise.resolve(psbtToUr(psbt, 100));
  };
  const h = (tag: string, attrs: Record<string, unknown> = {}, ...kids: unknown[]) => {
    const e = new El(tag);
    if (tag === "canvas") canvases.push(e);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v as () => void);
      else if (k === "class") e.className = String(v);
      else e.setAttribute(k, String(v));
    }
    for (const c of kids.flat()) {
      if (c !== null && c !== undefined && c !== false) e.append(c as El);
    }
    return e;
  };
  const { showPsbtQr } = await import("../src/ui/static/qr.js");
  // deno-lint-ignore no-explicit-any
  await (showPsbtQr as any)({ api, h, planId: "p1", file: "ecx/001-aa.psbt", label: "ECX #1" });
  assertEquals(calls.length, 1);
  assert(calls[0].includes("/api/plans/p1/qr?file=ecx%2F001-aa.psbt&size=100"), calls[0]);
  const canvas = canvases[0] ?? (() => {
    throw new Error("no canvas");
  })();
  assert(canvas.fills > 200, `the QR code was drawn (${canvas.fills} modules)`);
  assert(canvas.width > 100 && canvas.width === canvas.height);
  // Stop the animation timer the module started.
  const close = (g.document as { body: El }).body.children
    .flatMap((w) => (w instanceof El ? w.children : []))
    .flatMap((b) => (b instanceof El ? b.children : []))
    .flatMap((x) => (x instanceof El ? x.children : []))
    .find((x) => x instanceof El && x.tag === "button") as El | undefined;
  close?.listeners.click?.[0]();
});
