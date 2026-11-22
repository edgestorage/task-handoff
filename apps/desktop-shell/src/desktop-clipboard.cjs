const MAX_CLIPBOARD_TEXT_BYTES = 32 * 1024;

function createDesktopClipboardBridge(options) {
  const {
    clipboard,
    broadcast,
    pollIntervalMs = 250,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;
  let timer;
  let lastText = "";
  let started = false;

  function readText() {
    try {
      const text = clipboard.readText();
      return typeof text === "string" ? text : "";
    } catch {
      return "";
    }
  }

  function writeText(text) {
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_CLIPBOARD_TEXT_BYTES || text.includes("\0")) {
      return { ok: false, code: "REMOTE_DESKTOP_CLIPBOARD_INVALID" };
    }
    try {
      clipboard.writeText(text);
      // The watcher must treat a controller-originated write as already
      // synchronized, otherwise the same text would be echoed back.
      lastText = text;
      return { ok: true };
    } catch {
      return { ok: false, code: "REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE" };
    }
  }

  function schedule() {
    timer = setTimeoutFn(poll, pollIntervalMs);
    timer?.unref?.();
  }

  function poll() {
    timer = undefined;
    if (!started) return;
    const text = readText();
    if (text && text !== lastText) {
      lastText = text;
      broadcast({ text });
    } else if (!text) {
      lastText = "";
    }
    schedule();
  }

  function start() {
    if (started) return;
    started = true;
    // Clipboard APIs expose no portable change notification. Seed the current
    // value so enabling a viewer never uploads clipboard content from before
    // the subscription, then notify only later changes.
    lastText = readText();
    schedule();
  }

  function stop() {
    started = false;
    if (timer) clearTimeoutFn(timer);
    timer = undefined;
  }

  return { pollNow: poll, readText, start, stop, writeText };
}

module.exports = { MAX_CLIPBOARD_TEXT_BYTES, createDesktopClipboardBridge };
