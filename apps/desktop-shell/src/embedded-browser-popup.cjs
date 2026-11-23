const DEFAULT_POPUP_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PENDING_TABS_PER_GUEST = 16;
const TAB_DISPOSITIONS = new Set(["foreground-tab", "background-tab"]);
const STANDARD_FRAME_NAMES = new Set(["", "_blank", "_self", "_parent", "_top"]);

function embeddedBrowserPopupKind(details = {}) {
  const disposition = String(details.disposition || "").toLowerCase();
  const frameName = String(details.frameName || "").toLowerCase();
  const hasPostBody = Array.isArray(details.postBody) ? details.postBody.length > 0 : details.postBody != null;
  if (!TAB_DISPOSITIONS.has(disposition) || hasPostBody) return "popup";
  if (!STANDARD_FRAME_NAMES.has(frameName)) return "popup";
  return "tab";
}

class DesktopEmbeddedBrowserPopupController {
  constructor(options = {}) {
    if (typeof options.isAllowedUrl !== "function") throw new TypeError("isAllowedUrl is required");
    if (typeof options.sendNewTab !== "function") throw new TypeError("sendNewTab is required");
    this.isAllowedUrl = options.isAllowedUrl;
    this.sendNewTab = options.sendNewTab;
    this.logInfo = options.logInfo || (() => undefined);
    this.logError = options.logError || (() => undefined);
    this.popupTimeoutMs = Number.isFinite(options.popupTimeoutMs) ? Math.max(1, options.popupTimeoutMs) : DEFAULT_POPUP_TIMEOUT_MS;
    this.maxPendingTabsPerGuest = Number.isInteger(options.maxPendingTabsPerGuest) && options.maxPendingTabsPerGuest > 0
      ? options.maxPendingTabsPerGuest
      : DEFAULT_MAX_PENDING_TABS_PER_GUEST;
    this.pendingTabCounts = new WeakMap();
  }

  windowOpenResponse({ guest, details = {}, parentWindow } = {}) {
    const url = String(details.url || "");
    if (!this.isAllowedUrl(url)) {
      this.logInfo(`[desktop-shell] browser webview popup denied guest=${guest?.id || "unknown"} url=${popupDiagnosticUrl(url)}`);
      return { action: "deny" };
    }
    const kind = embeddedBrowserPopupKind(details);
    if (kind === "tab") {
      if (this.pendingTabCount(guest) >= this.maxPendingTabsPerGuest) {
        this.logInfo(`[desktop-shell] browser webview popup denied guest=${guest?.id || "unknown"} reason=pending-limit url=${popupDiagnosticUrl(url)}`);
        return { action: "deny" };
      }
      this.reservePendingTab(guest);
    }
    this.logInfo(`[desktop-shell] browser webview popup guest=${guest?.id || "unknown"} kind=${kind} disposition=${details.disposition || ""} frameName=${details.frameName || ""} postBody=${details.postBody != null} url=${popupDiagnosticUrl(url)}`);
    return {
      action: "allow",
      outlivesOpener: false,
      overrideBrowserWindowOptions: kind === "tab"
        ? { show: false, skipTaskbar: true }
        : popupWindowOptions(parentWindow),
    };
  }

  handleCreatedWindow({ guest, window, details = {}, host, instanceId } = {}) {
    const webContents = window?.webContents;
    if (!webContents || typeof webContents.on !== "function") {
      this.releasePendingTab(guest);
      try { window?.destroy?.(); } catch { /* the popup is already gone */ }
      return;
    }
    const kind = embeddedBrowserPopupKind(details);
    this.logInfo(`[desktop-shell] browser webview popup created guest=${guest?.id || "unknown"} popup=${webContents.id || "unknown"} kind=${kind}`);
    if (kind === "tab") this.trackTabWindow({ guest, window, details, host, instanceId });
    else this.trackPopupWindow({ guest, window, details, host, instanceId });
  }

  trackTabWindow({ guest, window, details, host, instanceId }) {
    const webContents = window.webContents;
    let settled = false;
    let timer;
    try { window.hide?.(); } catch { /* hidden popup is already unavailable */ }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      this.releasePendingTab(guest);
      webContents.removeListener("will-navigate", onNavigate);
      webContents.removeListener("will-redirect", onNavigate);
      window.removeListener("closed", onClosed);
      guest?.removeListener?.("destroyed", onOpenerGone);
      host?.removeListener?.("destroyed", onOpenerGone);
    };
    const settle = (reason, targetUrl) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (targetUrl) this.forwardTab({ host, instanceId, url: targetUrl, details });
      this.logInfo(`[desktop-shell] browser webview popup tab ${reason} guest=${guest?.id || "unknown"} popup=${webContents.id || "unknown"}${targetUrl ? ` url=${popupDiagnosticUrl(targetUrl)}` : ""}`);
      setImmediate(() => {
        try { if (!window.isDestroyed?.()) window.destroy?.(); } catch { /* the popup is already gone */ }
      });
    };
    const onNavigate = (event, targetUrl) => {
      if (settled) return;
      const url = String(targetUrl || "");
      if (!url || url === "about:blank") return;
      event?.preventDefault?.();
      if (!this.isAllowedUrl(url)) {
        settle("blocked-navigation");
        return;
      }
      try { webContents.stop?.(); } catch { /* navigation is already stopping */ }
      settle("forwarded", url);
    };
    const onClosed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      this.logInfo(`[desktop-shell] browser webview popup tab closed-before-navigation guest=${guest?.id || "unknown"} popup=${webContents.id || "unknown"}`);
    };
    const onOpenerGone = () => settle("opener-closed");

    webContents.on("will-navigate", onNavigate);
    webContents.on("will-redirect", onNavigate);
    window.once("closed", onClosed);
    guest?.once?.("destroyed", onOpenerGone);
    host?.once?.("destroyed", onOpenerGone);
    timer = setTimeout(() => settle("navigation-timeout"), this.popupTimeoutMs);
    timer.unref?.();
  }

  trackPopupWindow({ guest, window, details, host, instanceId }) {
    const webContents = window.webContents;
    const onNavigate = (event, targetUrl) => {
      const url = String(targetUrl || "");
      if (!url || url === "about:blank" || this.isAllowedUrl(url)) return;
      event?.preventDefault?.();
      this.logInfo(`[desktop-shell] browser popup blocked navigation popup=${webContents.id || "unknown"} url=${popupDiagnosticUrl(url)}`);
    };
    const onChildCreated = (_event, childWindow, childDetails) => {
      this.handleCreatedWindow({ guest: webContents, window: childWindow, details: childDetails, host, instanceId });
    };
    const onOpenerGone = () => {
      try { if (!window.isDestroyed?.()) window.destroy?.(); } catch { /* the popup is already gone */ }
    };
    const cleanup = () => {
      webContents.removeListener("will-navigate", onNavigate);
      webContents.removeListener("will-redirect", onNavigate);
      webContents.removeListener("did-create-window", onChildCreated);
      host?.removeListener?.("destroyed", onOpenerGone);
    };

    webContents.on("will-navigate", onNavigate);
    webContents.on("will-redirect", onNavigate);
    webContents.on("did-create-window", onChildCreated);
    webContents.setWindowOpenHandler((childDetails) => this.windowOpenResponse({
      guest: webContents,
      details: childDetails,
      parentWindow: window,
    }));
    host?.once?.("destroyed", onOpenerGone);
    window.once?.("closed", cleanup);
  }

  forwardTab({ host, instanceId, url, details }) {
    if (!host || host.isDestroyed?.()) {
      this.logError(`[desktop-shell] browser webview popup tab forward failed reason=host-unavailable url=${popupDiagnosticUrl(url)}`);
      return false;
    }
    try {
      const accepted = this.sendNewTab({
        host,
        instanceId,
        url,
        disposition: details?.disposition,
      });
      return accepted !== false;
    } catch (error) {
      this.logError(`[desktop-shell] browser webview popup tab forward failed guest=${host.id || "unknown"} url=${popupDiagnosticUrl(url)} error=${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  pendingTabCount(guest) {
    if (!guest || (typeof guest !== "object" && typeof guest !== "function")) return 0;
    return this.pendingTabCounts.get(guest) || 0;
  }

  reservePendingTab(guest) {
    if (!guest || (typeof guest !== "object" && typeof guest !== "function")) return;
    this.pendingTabCounts.set(guest, this.pendingTabCount(guest) + 1);
  }

  releasePendingTab(guest) {
    if (!guest || (typeof guest !== "object" && typeof guest !== "function")) return;
    const remaining = Math.max(0, this.pendingTabCount(guest) - 1);
    if (remaining) this.pendingTabCounts.set(guest, remaining);
    else this.pendingTabCounts.delete(guest);
  }
}

function popupWindowOptions(parentWindow) {
  const options = { show: true, autoHideMenuBar: true };
  if (parentWindow && !parentWindow.isDestroyed?.()) options.parent = parentWindow;
  return options;
}

function popupDiagnosticUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol === "about:") return url.href.slice(0, 2_048);
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 2_048);
  } catch {
    return String(value || "").slice(0, 2_048);
  }
}

module.exports = { DesktopEmbeddedBrowserPopupController, embeddedBrowserPopupKind };
