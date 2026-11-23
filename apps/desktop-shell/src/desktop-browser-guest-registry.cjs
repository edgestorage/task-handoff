const crypto = require("node:crypto");
const { assertEmbeddedBrowserCdpMethod } = require("./embedded-browser-cdp-policy.cjs");

class DesktopBrowserGuestRegistry {
  constructor(options = {}) {
    this.createId = options.createId || (() => `browser_tab_${crypto.randomUUID().replace(/-/g, "")}`);
    this.onRemoved = options.onRemoved;
    this.onChanged = options.onChanged;
    this.onCdpEvent = options.onCdpEvent;
    this.onDebuggerDetached = options.onDebuggerDetached;
    this.captureSurface = options.captureSurface;
    this.captureTimeoutMs = Number.isFinite(options.captureTimeoutMs) ? Math.max(1, options.captureTimeoutMs) : 8_000;
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
      guestId: guest.id,
      guestDestroyed: false,
      removed: false,
      partition: String(partition || ""),
      tabRef: undefined,
      creationRef: undefined,
      instanceId: optionalString(instanceId, 160) || undefined,
      sessionKey: undefined,
      title: "",
      url: "about:blank",
      state: "attached",
      debuggerAttached: false,
      debuggerApi: undefined,
      backgroundThrottled: undefined,
      captureSurface: this.captureSurface,
      captureTimeoutMs: this.captureTimeoutMs,
    };
    this.byGuestId.set(guest.id, entry);
    guest.once?.("destroyed", () => {
      entry.guestDestroyed = true;
      this.removeEntry(entry, "destroyed");
    });
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

  setBackgroundThrottled({ webContentsId, senderId, throttled }) {
    const entry = this.byGuestId.get(Number(webContentsId));
    if (!entry || (senderId !== undefined && entry.host.id !== senderId)) return false;
    entry.backgroundThrottled = Boolean(throttled);
    if (typeof entry.guest.setBackgroundThrottling === "function" && !entry.guestDestroyed) {
      entry.guest.setBackgroundThrottling(entry.backgroundThrottled);
    }
    return true;
  }

  async close({ tabRef, senderId }) {
    const entry = this.requireEntry(tabRef, senderId);
    entry.guestDestroyed = true;
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
    entry.debuggerApi = debuggerApi;
    entry.debuggerAttached = true;
    const onDetach = (_event, reason) => {
      detachGuestDebugger(entry, { alreadyDetached: true });
      if (this.byGuestId.get(entry.guest.id) !== entry) return;
      try { this.onDebuggerDetached?.({ ...this.publicEntry(entry), reason: String(reason || "detached") }); } catch { /* observer is best effort */ }
    };
    const onMessage = (_event, method, params) => {
      if (this.byGuestId.get(entry.guest.id) !== entry || !entry.tabRef) return;
      try { this.onCdpEvent?.({ tabRef: entry.tabRef, method: String(method || ""), params }); } catch { /* observer is best effort */ }
    };
    entry.debuggerDetachHandler = onDetach;
    entry.debuggerMessageHandler = onMessage;
    debuggerApi.on?.("detach", onDetach);
    debuggerApi.on?.("message", onMessage);
    return this.publicEntry(entry);
  }

  detachDebugger({ tabRef, senderId }) {
    const entry = this.requireEntry(tabRef, senderId);
    if (!entry.debuggerAttached) return false;
    detachGuestDebugger(entry);
    return true;
  }

  async sendCommand({ tabRef, senderId, method, params }) {
    const entry = this.requireEntry(tabRef, senderId);
    if (!entry.debuggerAttached) throw browserGuestError("BROWSER_TARGET_NOT_ATTACHED");
    const normalizedMethod = assertEmbeddedBrowserCdpMethod(method);
    if (normalizedMethod === "Page.captureScreenshot") {
      return capturePageScreenshot(entry, params);
    }
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
    if (entry.removed) return;
    entry.removed = true;
    detachGuestDebugger(entry);
    this.byGuestId.delete(entry.guestId);
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

function browserGuestError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function detachGuestDebugger(entry, options = {}) {
  let debuggerApi = entry.debuggerApi;
  if (!debuggerApi) {
    try {
      debuggerApi = entry.guest?.debugger;
    } catch {
      debuggerApi = undefined;
    }
  }
  if (entry.debuggerMessageHandler) {
    try { debuggerApi?.removeListener?.("message", entry.debuggerMessageHandler); } catch { /* debugger is already gone */ }
  }
  if (entry.debuggerDetachHandler) {
    try { debuggerApi?.removeListener?.("detach", entry.debuggerDetachHandler); } catch { /* debugger is already gone */ }
  }
  entry.debuggerMessageHandler = undefined;
  entry.debuggerDetachHandler = undefined;
  entry.debuggerApi = undefined;
  if (!options.alreadyDetached && !entry.guestDestroyed && entry.debuggerAttached) {
    try { debuggerApi?.detach?.(); } catch { /* debugger is already gone */ }
  }
  entry.debuggerAttached = false;
}

async function capturePageScreenshot(entry, params) {
  if (typeof entry.guest.capturePage !== "function") throw browserGuestError("BROWSER_OPERATION_UNSUPPORTED");
  const input = params && typeof params === "object" ? params : {};
  const format = input.format === undefined ? "png" : input.format;
  if (format !== "png" && format !== "jpeg") throw browserGuestError("BROWSER_OPERATION_UNSUPPORTED");
  const clip = input.clip && typeof input.clip === "object" ? input.clip : undefined;
  const rect = clip
    ? {
      x: Math.max(0, Math.floor(Number(clip.x) || 0)),
      y: Math.max(0, Math.floor(Number(clip.y) || 0)),
      width: Math.max(1, Math.ceil(Number(clip.width) || 1)),
      height: Math.max(1, Math.ceil(Number(clip.height) || 1)),
    }
    : undefined;
  const width = Math.max(rect ? rect.x + rect.width : 0, 1280);
  const height = Math.max(rect ? rect.y + rect.height : 0, 720);
  const previousThrottled = typeof entry.backgroundThrottled === "boolean" ? entry.backgroundThrottled : undefined;
  let surfaceToken;
  let captured;
  try {
    // Chromium only produces frames for webviews that are laid out inside the
    // visible window. Ask the renderer to expose an invisible (opacity: 0)
    // capture surface at the page's natural size before reading pixels.
    if (typeof entry.guest.setBackgroundThrottling === "function" && !entry.guestDestroyed) {
      entry.guest.setBackgroundThrottling(false);
    }
    surfaceToken = await entry.captureSurface?.prepare?.({ entry, width, height });
    captured = await withCaptureTimeout(
      entry.guest.capturePage(rect, { stayHidden: true, stayAwake: true }),
      entry.captureTimeoutMs,
    );
  } catch (error) {
    if (error?.code) throw error;
    throw browserGuestError("BROWSER_CDP_ERROR", `Screenshot capture failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      await entry.captureSurface?.release?.({ entry, token: surfaceToken });
    } catch { /* releasing the capture surface is best effort */ }
    if (previousThrottled !== undefined && typeof entry.guest.setBackgroundThrottling === "function" && !entry.guestDestroyed) {
      try { entry.guest.setBackgroundThrottling(previousThrottled); } catch { /* guest is already gone */ }
    }
  }
  if (!captured || typeof captured.isEmpty !== "function" || captured.isEmpty()) {
    throw browserGuestError("BROWSER_CDP_ERROR", "Screenshot capture returned an empty image.");
  }
  const scale = clip ? Number(clip.scale) : Number.NaN;
  const image = Number.isFinite(scale) && scale > 0 && scale !== 1 && typeof captured.resize === "function"
    ? captured.resize({
      width: Math.max(1, Math.round(rect.width * scale)),
      height: Math.max(1, Math.round(rect.height * scale)),
      quality: "best",
    })
    : captured;
  const quality = Math.max(0, Math.min(100, Math.round(Number(input.quality ?? 100)) || 100));
  const data = format === "jpeg" ? image.toJPEG(quality) : image.toPNG();
  return { data: data.toString("base64") };
}

function withCaptureTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(browserGuestError("BROWSER_CDP_ERROR", `Screenshot capture timed out after ${timeoutMs}ms.`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

module.exports = { DesktopBrowserGuestRegistry };
