// Air-gapped signing in the browser: show a PSBT as animated QR codes (UR "crypto-psbt"), and read
// the signed PSBT back from the signer's animated QR codes through the camera.
// `qrcode` (drawing) and `jsQR` (reading) are the vendored libraries in /vendor/.
// The UR coding itself happens on the server; this file only draws, scans and passes frames on.

/* global qrcode, jsQR */

function drawQr(canvas, text) {
  const qr = qrcode(0, "L");
  qr.addData(text.toUpperCase(), "Alphanumeric");
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const cell = Math.max(3, Math.floor(360 / (n + quiet * 2)));
  const size = (n + quiet * 2) * cell;
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, size, size);
  g.fillStyle = "#000";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) g.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
    }
  }
}

function overlay(h, title, onClose) {
  const box = h("div", { class: "modal-box qr-box" });
  const wrap = h("div", { class: "modal qr-modal" }, box);
  const close = () => {
    onClose?.();
    wrap.remove();
  };
  box.append(
    h(
      "div",
      { class: "qr-head" },
      h("strong", {}, title),
      h("button", { class: "small secondary", onclick: close }, "Close"),
    ),
  );
  document.body.append(wrap);
  return { box, close };
}

/** Plays the unsigned PSBT as a looping animation of QR codes. */
export async function showPsbtQr({ api, h, planId, file, label }) {
  let timer;
  const { box } = overlay(h, `Show to your signer: ${label}`, () => clearInterval(timer));
  const status = h("p", { class: "note" }, "Preparing…");
  const canvas = h("canvas", { class: "qr-canvas" });
  const sizeSel = h(
    "select",
    {},
    ...[["60", "Small frames (tiny screens, slow)"], ["100", "Medium frames (default)"], [
      "200",
      "Large frames (fast, needs a good camera)",
    ]]
      .map(([v, t]) => h("option", { value: v, ...(v === "100" ? { selected: true } : {}) }, t)),
  );
  const speedSel = h(
    "select",
    {},
    ...[["400", "Slow"], ["250", "Normal"], ["120", "Fast"]]
      .map(([v, t]) => h("option", { value: v, ...(v === "250" ? { selected: true } : {}) }, t)),
  );
  let frames = [];
  let i = 0;
  const play = () => {
    clearInterval(timer);
    if (!frames.length) return;
    const tick = () => {
      drawQr(canvas, frames[i % frames.length]);
      status.textContent = frames.length === 1
        ? "One QR code: point your signer at it."
        : `Frame ${
          (i % frames.length) + 1
        } of ${frames.length} (it loops). Keep the signer scanning until it says it has everything.`;
      i++;
    };
    tick();
    if (frames.length > 1) timer = setInterval(tick, Number(speedSel.value));
  };
  const load = async () => {
    try {
      const r = await api(
        `/api/plans/${planId}/qr?file=${encodeURIComponent(file)}&size=${sizeSel.value}`,
      );
      frames = r.frames;
      i = 0;
      play();
    } catch (e) {
      status.textContent = `Couldn't prepare the QR codes: ${e.message}`;
    }
  };
  sizeSel.addEventListener("change", load);
  speedSel.addEventListener("change", play);
  box.append(
    h(
      "p",
      { class: "note" },
      "Your signer must support animated UR QR codes (crypto-psbt): Keystone, Passport, Jade, SeedSigner, and others. After signing it shows its own animated QR codes: close this and press “Scan signed PSBT”.",
    ),
    canvas,
    status,
    h(
      "div",
      { class: "row" },
      h("label", {}, "Frame size", sizeSel),
      h("label", {}, "Speed", speedSel),
    ),
  );
  await load();
}

/** Reads the signer's animated QR codes through the camera and hands the frames to the server. */
export async function scanSignedPsbt({ api, h, planId, file, label, onSaved }) {
  let stream;
  let stopped = false;
  const stop = () => {
    stopped = true;
    stream?.getTracks().forEach((t) => t.stop());
  };
  const { box, close } = overlay(h, `Scan the signed PSBT: ${label}`, stop);
  const status = h("p", { class: "note" }, "Starting the camera…");
  const bar = h("progress", { max: "100", value: "0", class: "qr-progress" });
  const video = h("video", { class: "qr-video", playsinline: true, muted: true });
  box.append(
    h(
      "p",
      { class: "note" },
      "On the signer, choose to export the signed transaction as a QR code, then hold it in front of the camera. Frames are read here in your browser; only their text goes to splayed on this machine.",
    ),
    video,
    bar,
    status,
  );
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.isSecureContext) {
    status.textContent =
      "The camera needs a secure page: open the UI at http://127.0.0.1 or localhost on the machine with the camera (a LAN address over plain http is blocked by the browser). You can also upload the signed file instead.";
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch (e) {
    status.textContent = `No camera access: ${e.message}`;
    return;
  }
  video.srcObject = stream;
  await video.play();
  status.textContent = "Looking for QR codes…";
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d", { willReadFrequently: true });
  const seen = new Set();
  let queue = [];
  let sending = false;
  const flush = async () => {
    if (sending || !queue.length || stopped) return;
    sending = true;
    const frames = queue;
    queue = [];
    try {
      const r = await api(`/api/plans/${planId}/qr`, {
        method: "POST",
        body: JSON.stringify({ file, frames }),
      });
      if (r.complete) {
        stop();
        status.textContent = `Got it. Saved as ${r.saved}.`;
        bar.value = 100;
        await onSaved?.(r);
        setTimeout(close, 800);
        return;
      }
      bar.value = r.progress?.percent ?? 0;
      status.textContent =
        `Reading… ${r.progress?.known ?? 0} of ${r.progress?.fragments || "?"} pieces` +
        (r.rejected ? ` (${r.rejected} unreadable frame(s) skipped)` : "");
    } catch (e) {
      status.textContent = e.message;
      if (/another transfer|Start the scan again/u.test(e.message)) seen.clear();
    } finally {
      sending = false;
    }
  };
  const loop = () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      g.drawImage(video, 0, 0);
      const img = g.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      const text = code?.data?.trim();
      if (text && /^ur:/iu.test(text) && !seen.has(text)) {
        seen.add(text);
        queue.push(text);
        flush();
      }
    }
    setTimeout(loop, 60);
  };
  loop();
  setInterval(() => (stopped ? undefined : flush()), 500);
}
