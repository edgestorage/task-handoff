const crypto = require("node:crypto");
const { assertEmbeddedBrowserCdpMethod } = require("./embedded-browser-cdp-policy.cjs");

class DesktopBrowserGuestRegistry {
  constructor(options = {}) {
    this.createId = options.createId || (() => `browser_tab_${crypto.randomUUID().replace(/-/g, "")}`);
    this.onRemoved = options.onRemoved;
    this.onChanged = options.onChanged;
    this.onCdpEvent = options.onCdpEvent;
    this.onDebuggerDetached = options.onDebuggerDetached;
    this.logInfo = options.logInfo;
    this.pageHost = options.pageHost || "renderer-webview";
    this.pageHostCapabilities = options.pageHostCapabilities || Object.freeze({
      backgroundCreation: false,
      surviveHostWindowClose: false,
      crossWindowAdopt: false,
    });
    this.byGuestId = new Map();
    this.byTabRef = new Map();
    this.bySessionKey = new Map();
  }

  addGuest({ host, guest, partition, instanceId }) {
    if (!host || !guest || !Number.isInteger(guest.id)) throw browserGuestError("BROWSER_GUEST_INVALID");
    const existing = this.byGuestId.get(guest.id);
    if (existing) return existing;
    const entry = {
      host,
      guest,
      partition: String(partition || ""),
      tabRef: undefined,
      creationRef: undefined,
      instanceId: optionalString(instanceId, 160) || undefined,
      sessionKey: undefined,
      title: "",
      url: "about:blank",
      state: "attached",
      debuggerAttached: false,
    };
    this.byGuestId.set(guest.id, entry);
    guest.once?.("destroyed", () => this.removeGuest(guest, "destroyed"));
    return entry;
  }

  register({ senderId, webContentsId, instanceId, sessionKey, partition, title, url, state, creationRef }) {
    const entry = this.byGuestId.get(webContentsId);
    if (!entry || entry.host.id !== senderId) throw browserGuestError("BROWSER_GUEST_NOT_FOUND");
    if (!entry.partition || (partition && entry.partition !== partition)) throw browserGuestError("BROWSER_GUEST_PARTITION_MISMATCH");
    const normalizedInstanceId = requiredString(instanceId, "BROWSER_INSTANCE_ID_INVALID", 160);
    if (entry.instanceId && entry.instanceId !== normalizedInstanceId) throw browserGuestError("BROWSER_GUEST_PARTITION_MISMATCH");
    const normalizedSessionKey = requiredString(sessionKey, "BROWSER_SESSION_KEY_INVALID", 320);
    const sessionKeyId = `${normalizedInstanceId}\0${normalizedSessionKey}`;
    const previous = this.bySessionKey.get(sessionKeyId);
    if (previous && previous !== entry) throw browserGuestError("BROWSER_SESSION_KEY_CONFLICT");
    if (entry.tabRef && (entry.instanceId !== normalizedInstanceId || entry.sessionKey !== normalizedSessionKey)) {
      throw browserGuestError("BROWSER_GUEST_ALREADY_REGISTERED");
    }
    entry.tabRef ||= this.createId();
    entry.creationRef ||= optionalString(creationRef, 240) || undefined;
    entry.instanceId = normalizedInstanceId;
    entry.sessionKey = normalizedSessionKey;
    entry.title = optionalString(title, 512) || entry.title;
    entry.url = optionalString(url, 4_096) || entry.url;
    entry.state = optionalString(state, 40) || entry.state;
    this.byTabRef.set(entry.tabRef, entry);
    this.bySessionKey.set(sessionKeyId, entry);
    this.notifyChanged("registered", entry);
    return this.publicEntry(entry);
  }

  update({ senderId, tabRef, title, url, state }) {
    const entry = this.requireEntry(tabRef, senderId);
    if (title !== undefined) entry.title = optionalString(title, 512);
    if (url !== undefined) entry.url = optionalString(url, 4_096) || "about:blank";
    if (state !== undefined) entry.state = optionalString(state, 40) || "attached";
    this.notifyChanged("updated", entry);
    return this.publicEntry(entry);
  }

  unregister({ senderId, webContentsId }) {
    const entry = this.byGuestId.get(webContentsId);
    if (!entry || entry.host.id !== senderId) return false;
    this.removeEntry(entry, "unregistered");
    return true;
  }

  list({ senderId, instanceId } = {}) {
    return [...this.byTabRef.values()]
      .filter((entry) => senderId === undefined || entry.host.id === senderId)
      .filter((entry) => !instanceId || entry.instanceId === instanceId)
      .map((entry) => this.publicEntry(entry));
  }

  listForRenderer({ senderId, instanceId } = {}) {
    return [...this.byTabRef.values()]
      .filter((entry) => senderId === undefined || entry.host.id === senderId)
      .filter((entry) => !instanceId || entry.instanceId === instanceId)
      .map((entry) => Object.freeze({
        ...this.publicEntry(entry),
        sessionKey: entry.sessionKey,
      }));
  }

  get(tabRef) {
    const entry = this.byTabRef.get(String(tabRef || ""));
    return entry ? this.publicEntry(entry) : undefined;
  }

  getInternal(tabRef, senderId) {
    const entry = this.byTabRef.get(String(tabRef || ""));
    if (!entry || (senderId !== undefined && entry.host.id !== senderId)) return undefined;
    return entry;
  }

  getByGuestId(webContentsId, senderId) {
    const entry = this.byGuestId.get(Number(webContentsId));
    if (!entry || (senderId !== undefined && entry.host.id !== senderId)) return undefined;
    return entry;
  }

  async close({ tabRef, senderId }) {
    const entry = this.requireEntry(tabRef, senderId);
    if (typeof entry.guest.close === "function") {
      entry.guest.close();
    } else {
      entry.guest.destroy?.();
    }
    this.removeEntry(entry, "closed");
    return true;
  }

  attachDebugger({ tabRef, senderId, protocolVersion = "1.3" }) {
    const entry = this.requireEntry(tabRef, senderId);
    const debuggerApi = entry.guest.debugger;
    if (!debuggerApi || typeof debuggerApi.attach !== "function" || typeof debuggerApi.sendCommand !== "function") {
      throw browserGuestError("BROWSER_CDP_UNAVAILABLE");
    }
    if (entry.debuggerAttached) return this.publicEntry(entry);
    if (debuggerApi.isAttached?.()) throw browserGuestError("BROWSER_TARGET_BUSY");
    debuggerApi.attach(protocolVersion);
    entry.debuggerAttached = true;
    debuggerApi.on?.("detach", (_event, reason) => {
      if (this.byGuestId.get(entry.guest.id) !== entry) return;
      entry.debuggerAttached = false;
      try { this.onDebuggerDetached?.({ ...this.publicEntry(entry), reason: String(reason || "detached") }); } catch { /* observer is best effort */ }
    });
    debuggerApi.on?.("message", (_event, method, params) => {
      if (this.byGuestId.get(entry.guest.id) !== entry || !entry.tabRef) return;
      try { this.onCdpEvent?.({ tabRef: entry.tabRef, method: String(method || ""), params }); } catch { /* observer is best effort */ }
    });
    return this.publicEntry(entry);
  }

  detachDebugger({ tabRef, senderId }) {
    const entry = this.requireEntry(tabRef, senderId);
    if (!entry.debuggerAttached) return false;
    entry.guest.debugger?.detach?.();
    entry.debuggerAttached = false;
    return true;
  }

  async sendCommand({ tabRef, senderId, method, params }) {
    const entry = this.requireEntry(tabRef, senderId);
    if (!entry.debuggerAttached) throw browserGuestError("BROWSER_TARGET_NOT_ATTACHED");
    const normalizedMethod = assertEmbeddedBrowserCdpMethod(method);
    // Electron's renderer-webview debugger applies Page.reload to the embedding
    // renderer, which reloads the Control Plane UI and releases every browser
    // context. Use the guest WebContents API so reload stays scoped to the page.
    if (normalizedMethod === "Page.reload") {
      if (params?.ignoreCache === true && typeof entry.guest.reloadIgnoringCache === "function") {
        entry.guest.reloadIgnoringCache();
      } else if (typeof entry.guest.reload === "function") {
        entry.guest.reload();
      } else {
        const url = entry.guest.getURL?.() || entry.url;
        if (!url || url === "about:blank") throw browserGuestError("BROWSER_OPERATION_UNSUPPORTED");
        return entry.guest.debugger.sendCommand("Page.navigate", { url });
      }
      return {};
    }
    return entry.guest.debugger.sendCommand(normalizedMethod, params);
  }

  removeHost(host) {
    for (const entry of [...this.byGuestId.values()]) {
      if (entry.host === host || entry.host.id === host?.id) this.removeEntry(entry, "host-destroyed");
    }
  }

  removeGuest(guest, reason = "guest-destroyed") {
    const entry = this.byGuestId.get(guest?.id);
    if (entry) this.removeEntry(entry, reason);
  }

  removeEntry(entry, reason) {
    if (entry.debuggerAttached) {
      try { entry.guest.debugger?.detach?.(); } catch { /* debugger is already gone */ }
      entry.debuggerAttached = false;
    }
    this.byGuestId.delete(entry.guest.id);
    if (entry.tabRef) this.byTabRef.delete(entry.tabRef);
    if (entry.instanceId && entry.sessionKey) this.bySessionKey.delete(`${entry.instanceId}\0${entry.sessionKey}`);
    try {
      this.onRemoved?.({ ...this.publicEntry(entry), reason });
      this.notifyChanged("removed", entry, reason);
    } catch (error) {
      this.logInfo?.(`[desktop-shell] browser guest removal callback failed error=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  publicEntry(entry) {
    return Object.freeze({
      tabRef: entry.tabRef,
      instanceId: entry.instanceId,
      pageHost: this.pageHost,
      pageHostCapabilities: this.pageHostCapabilities,
      url: entry.url,
      title: entry.title,
      state: entry.state,
    });
  }

  requireEntry(tabRef, senderId) {
    const entry = this.byTabRef.get(String(tabRef || ""));
    if (!entry) throw browserGuestError("BROWSER_TAB_NOT_FOUND");
    if (senderId !== undefined && entry.host.id !== senderId) throw browserGuestError("BROWSER_TAB_NOT_FOUND");
    return entry;
  }

  notifyChanged(type, entry, reason) {
    if (!entry.tabRef || !entry.instanceId) return;
    try {
      this.onChanged?.({
        type,
        reason,
        entry: this.publicEntry(entry),
        senderId: entry.host.id,
        ...(entry.creationRef ? { creationRef: entry.creationRef } : {}),
      });
    } catch (error) {
      this.logInfo?.(`[desktop-shell] browser guest change callback failed error=${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function requiredString(value, code, maxLength) {
  const normalized = optionalString(value, maxLength);
  if (!normalized) throw browserGuestError(code);
  return normalized;
}

function optionalString(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function browserGuestError(code) {
  return Object.assign(new Error(code), { code });
}

module.exports = { DesktopBrowserGuestRegistry };
