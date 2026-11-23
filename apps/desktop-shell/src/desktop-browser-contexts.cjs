const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { BrowserTunnelChannel } = require("./browser-tunnel-channel.cjs");
const { BrowserSocksServer } = require("./browser-socks-server.cjs");

class DesktopBrowserContextManager {
  constructor(options) {
    this.fetch = options.fetch;
    this.WebSocket = options.WebSocket;
    this.session = options.session;
    this.chooseDownloadPath = options.chooseDownloadPath;
    this.defaultDownloadPath = options.defaultDownloadPath;
    this.BrowserTunnelChannel = options.BrowserTunnelChannel || BrowserTunnelChannel;
    this.BrowserSocksServer = options.BrowserSocksServer || BrowserSocksServer;
    this.logInfo = options.logInfo;
    this.logError = options.logError;
    this.userAgent = options.userAgent;
    this.onBrowserFailure = options.onBrowserFailure;
    this.onDownloadEvent = options.onDownloadEvent;
    this.now = options.now || Date.now;
    this.leaseTimeoutMs = options.leaseTimeoutMs ?? 60_000;
    this.contexts = new Map();
    this.contextCreations = new Map();
    this.contextDisposals = new Map();
    this.references = new Map();
    this.pendingPrepares = new Map();
    this.senderGenerations = new Map();
    this.closed = false;
    const reapIntervalMs = options.reapIntervalMs ?? 30_000;
    this.reapIntervalMs = reapIntervalMs;
    this.lastScheduledReapAt = this.now();
    this.reapTimer = reapIntervalMs > 0
      ? setInterval(() => { void this.runScheduledReap().catch((error) => this.logError?.(`[desktop-shell] browser context lease sweep failed error=${error instanceof Error ? error.message : String(error)}`)); }, reapIntervalMs)
      : undefined;
    this.reapTimer?.unref?.();
  }

  async prepare(input) {
    if (this.closed) throw browserContextCancelled();
    const senderGeneration = this.senderGenerations.get(input.senderId) ?? 0;
    this.senderGenerations.set(input.senderId, senderGeneration);
    const origin = canonicalOrigin(input.controlPlaneUrl);
    const identity = await responseData(await this.fetch(new URL("/api/control-plane/identity", origin).toString(), { method: "GET" }));
    // The public identity endpoint is a direct document; accept the historical
    // nested test/adapter shape while normalizing at this boundary.
    const controlPlaneId = String(
      identity?.controlPlaneId
      || identity?.payload?.controlPlaneId
      || identity?.identity?.controlPlaneId
      || identity?.identity?.payload?.controlPlaneId
      || "",
    );
    if (!controlPlaneId) throw new Error("Control Plane identity is unavailable.");
    if (this.closed || this.senderGenerations.get(input.senderId) !== senderGeneration) throw browserContextCancelled();
    const key = `${controlPlaneId}\0${input.instanceId}`;
    this.pendingPrepares.set(key, (this.pendingPrepares.get(key) ?? 0) + 1);
    try {
      await this.contextDisposals.get(key);
      if (this.closed || this.senderGenerations.get(input.senderId) !== senderGeneration) throw browserContextCancelled();
      let context = this.contexts.get(key);
      if (!context) {
        let creation = this.contextCreations.get(key);
        if (!creation) {
          creation = this.createContext({ key, controlPlaneId, instanceId: input.instanceId, origin })
            .then((created) => {
              this.contexts.set(key, created);
              return created;
            })
            .finally(() => this.contextCreations.delete(key));
          this.contextCreations.set(key, creation);
        }
        context = await creation;
      }
      context.senderIds.add(input.senderId);
      if (this.closed || this.senderGenerations.get(input.senderId) !== senderGeneration) throw browserContextCancelled();
      const contextId = `browser_context_${crypto.randomUUID().replace(/-/g, "")}`;
      this.references.set(contextId, { key, senderId: input.senderId, lastSeenAt: this.now() });
      return { contextId, partition: context.partition };
    } finally {
      const pending = (this.pendingPrepares.get(key) ?? 1) - 1;
      if (pending > 0) this.pendingPrepares.set(key, pending);
      else this.pendingPrepares.delete(key);
      await this.disposeIfUnused(key);
    }
  }

  async createContext(input) {
    const handshake = await responseData(await this.fetch(new URL(`/api/controlled-instances/${encodeURIComponent(input.instanceId)}/browser-access`, input.origin).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    const relayUrl = new URL(handshake.relayPath, input.origin);
    relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
    const channel = new this.BrowserTunnelChannel({
      url: relayUrl.toString(),
      token: handshake.token,
      WebSocket: this.WebSocket,
      logInfo: this.logInfo,
      logError: this.logError,
    });
    let socks;
    let browserSession;
    try {
      await channel.connect();
      socks = new this.BrowserSocksServer(channel, {
        logError: this.logError,
        onFailure: (failure) => {
          try { this.onBrowserFailure?.({ instanceId: input.instanceId, ...failure }); } catch { /* the host listener must never break the tunnel */ }
        },
      });
      const address = await socks.start();
      const partition = partitionName(input.controlPlaneId, input.instanceId);
      browserSession = this.session.fromPartition(partition, { cache: true });
      if (this.userAgent) browserSession.setUserAgent?.(this.userAgent);
      await browserSession.setProxy({
        mode: "fixed_servers",
        proxyRules: `socks5://${address.host}:${address.port}`,
        proxyBypassRules: "<-loopback>",
      });
      browserSession.setPermissionCheckHandler?.(() => false);
      browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      const context = {
        ...input,
        controlPlaneUrl: input.origin,
        partition,
        browserSession,
        channel,
        socks,
        senderIds: new Set(),
        downloadConfig: { behavior: "default", eventsEnabled: false },
        activeDownloads: new Map(),
        downloadHandler: undefined,
      };
      context.downloadHandler = (event, item, webContents) => {
        this.handleDownload(context, event, item, webContents);
      };
      browserSession.on("will-download", context.downloadHandler);
      return context;
    } catch (error) {
      channel.close();
      await socks?.close().catch(() => undefined);
      await browserSession?.closeAllConnections().catch(() => undefined);
      throw error;
    }
  }

  allows(senderId, partition) {
    for (const reference of this.references.values()) {
      if (reference.senderId !== senderId) continue;
      if (this.contexts.get(reference.key)?.partition === partition) return true;
    }
    return false;
  }

  instanceIdForPartition(senderId, partition) {
    for (const reference of this.references.values()) {
      if (reference.senderId !== senderId) continue;
      const context = this.contexts.get(reference.key);
      if (context?.partition === partition) return context.instanceId;
    }
    return undefined;
  }

  instanceIdForSession(senderId, session) {
    if (!session) return undefined;
    for (const reference of this.references.values()) {
      if (reference.senderId !== senderId) continue;
      const context = this.contexts.get(reference.key);
      if (context?.browserSession === session) return context.instanceId;
    }
    return undefined;
  }

  configureDownloads({ senderId, instanceId, behavior, downloadPath, eventsEnabled }) {
    const context = this.contextForSenderInstance(senderId, instanceId);
    if (!context) throw browserContextError("BROWSER_SOURCE_NOT_FOUND", "The browser context for downloads is unavailable.");
    if (!["default", "deny", "allow", "allowAndName"].includes(behavior)) {
      throw browserContextError("BROWSER_OPERATION_UNSUPPORTED", "The download behavior is not supported.");
    }
    let resolvedDownloadPath;
    if (behavior === "allow" || behavior === "allowAndName") {
      resolvedDownloadPath = downloadPath || this.defaultDownloadPath;
      if (!resolvedDownloadPath || !path.isAbsolute(resolvedDownloadPath) || resolvedDownloadPath.includes("\0")) {
        throw browserContextError("BROWSER_OPERATION_UNSUPPORTED", "CDP downloads require an absolute downloadPath.");
      }
    }
    context.downloadConfig = {
      behavior,
      eventsEnabled: eventsEnabled === true,
      ...(resolvedDownloadPath ? { downloadPath: resolvedDownloadPath } : {}),
    };
    return {};
  }

  cancelDownload({ senderId, instanceId, guid }) {
    const context = this.contextForSenderInstance(senderId, instanceId);
    if (!context) throw browserContextError("BROWSER_SOURCE_NOT_FOUND", "The browser context for downloads is unavailable.");
    const download = context.activeDownloads.get(guid);
    if (!download) return {};
    try { download.item.cancel(); } catch { /* The download may have already finished. */ }
    context.activeDownloads.delete(guid);
    return {};
  }

  handleDownload(context, _event, item, webContents) {
    const config = context.downloadConfig ?? { behavior: "default", eventsEnabled: false };
    if (config.behavior === "deny") {
      item.cancel();
      return;
    }
    const guid = crypto.randomUUID();
    const suggestedFilename = item.getFilename();
    if (config.behavior === "allowAndName") {
      fs.mkdirSync(config.downloadPath, { recursive: true });
      item.setSavePath(path.join(config.downloadPath, guid));
    } else if (config.behavior === "allow") {
      fs.mkdirSync(config.downloadPath, { recursive: true });
      item.setSavePath(path.join(config.downloadPath, safeDownloadFilename(suggestedFilename)));
    } else {
      const savePath = this.chooseDownloadPath?.(suggestedFilename);
      if (savePath) item.setSavePath(savePath);
      else item.cancel();
    }
    context.activeDownloads.set(guid, { item, webContentsId: webContents?.id, guid });
    const send = (method, params) => {
      try {
        this.onDownloadEvent?.({
          controlPlaneUrl: context.controlPlaneUrl,
          instanceId: context.instanceId,
          senderIds: [...context.senderIds],
          webContentsId: webContents?.id,
          method,
          params: { guid, ...params },
        });
      } catch { /* Download observers must not affect the download itself. */ }
    };
    if (config.eventsEnabled) {
      send("Browser.downloadWillBegin", {
        url: item.getURL(),
        suggestedFilename,
      });
    }
    item.on?.("updated", (_downloadEvent, state) => {
      if (!config.eventsEnabled || state !== "progressing") return;
      send("Browser.downloadProgress", {
        totalBytes: Math.max(0, Number(item.getTotalBytes()) || 0),
        receivedBytes: Math.max(0, Number(item.getReceivedBytes()) || 0),
        state: "inProgress",
      });
    });
    item.once?.("done", (_downloadEvent, state) => {
      if (config.eventsEnabled) {
        send("Browser.downloadProgress", {
          totalBytes: Math.max(0, Number(item.getTotalBytes()) || 0),
          receivedBytes: Math.max(0, Number(item.getReceivedBytes()) || 0),
          state: state === "completed" ? "completed" : "canceled",
        });
      }
      context.activeDownloads.delete(guid);
    });
  }

  contextForSenderInstance(senderId, instanceId) {
    for (const [key, context] of this.contexts) {
      if (context.instanceId !== instanceId) continue;
      if ([...this.references.values()].some((reference) => reference.key === key && reference.senderId === senderId)) return context;
    }
    return undefined;
  }

  async release(contextId, senderId) {
    const reference = this.references.get(contextId);
    if (!reference || reference.senderId !== senderId) return false;
    this.references.delete(contextId);
    await this.disposeIfUnused(reference.key);
    return true;
  }

  touch(contextId, senderId) {
    const reference = this.references.get(contextId);
    if (!reference || reference.senderId !== senderId) return false;
    reference.lastSeenAt = this.now();
    return true;
  }

  async reapStaleReferences(now = this.now()) {
    const stale = [...this.references]
      .filter(([, reference]) => now - reference.lastSeenAt >= this.leaseTimeoutMs)
      .map(([contextId, reference]) => ({ contextId, senderId: reference.senderId }));
    if (stale.length) this.logInfo?.(`[desktop-shell] reclaiming ${stale.length} stale browser context lease(s)`);
    await Promise.all(stale.map(({ contextId, senderId }) => this.release(contextId, senderId)));
    return stale.length;
  }

  async runScheduledReap() {
    const now = this.now();
    const delayedBy = now - this.lastScheduledReapAt - this.reapIntervalMs;
    this.lastScheduledReapAt = now;
    if (delayedBy >= this.leaseTimeoutMs) {
      for (const reference of this.references.values()) reference.lastSeenAt = now;
      this.logInfo?.("[desktop-shell] browser context lease sweep resumed after timer suspension; leases renewed once");
      return 0;
    }
    return this.reapStaleReferences(now);
  }

  async releaseSender(senderId) {
    this.senderGenerations.set(senderId, (this.senderGenerations.get(senderId) ?? 0) + 1);
    const ids = [...this.references].filter(([, reference]) => reference.senderId === senderId).map(([id]) => id);
    await Promise.all(ids.map((id) => this.release(id, senderId)));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.reapTimer) clearInterval(this.reapTimer);
    for (const senderId of this.senderGenerations.keys()) {
      this.senderGenerations.set(senderId, (this.senderGenerations.get(senderId) ?? 0) + 1);
    }
    await Promise.allSettled([...this.contextCreations.values()]);
    await Promise.all([...new Set([...this.references.values()].map((reference) => reference.senderId))].map((senderId) => this.releaseSender(senderId)));
    await Promise.all([...this.contexts.keys()].map((key) => this.disposeIfUnused(key)));
    await Promise.allSettled([...this.contextDisposals.values()]);
  }

  async disposeIfUnused(key) {
    if (this.pendingPrepares.get(key)) return false;
    if ([...this.references.values()].some((reference) => reference.key === key)) return false;
    const existingDisposal = this.contextDisposals.get(key);
    if (existingDisposal) {
      await existingDisposal;
      return false;
    }
    const context = this.contexts.get(key);
    if (!context) return false;
    this.contexts.delete(key);
    const disposal = this.disposeContext(context)
      .finally(() => {
        if (this.contextDisposals.get(key) === disposal) this.contextDisposals.delete(key);
      });
    this.contextDisposals.set(key, disposal);
    await disposal;
    return true;
  }

  async disposeContext(context) {
    for (const download of context.activeDownloads?.values?.() ?? []) {
      try { download.item.cancel(); } catch { /* The download may have already finished. */ }
    }
    context.activeDownloads?.clear?.();
    context.channel.close();
    await context.socks.close();
    context.browserSession.removeListener?.("will-download", context.downloadHandler);
    context.browserSession.setPermissionCheckHandler?.(null);
    context.browserSession.setPermissionRequestHandler(null);
    await context.browserSession.closeAllConnections();
  }
}

function browserContextCancelled() {
  return Object.assign(new Error("Browser context preparation was cancelled because its renderer is no longer active."), { code: "BROWSER_CONTEXT_CANCELLED" });
}

function browserContextError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function safeDownloadFilename(value) {
  const name = path.basename(String(value || "").replace(/\0/g, "")).trim();
  return name && name !== "." && name !== ".." ? name.slice(0, 255) : "download";
}

function canonicalOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Control Plane URL must use HTTP(S).");
  return url.origin;
}

function partitionName(controlPlaneId, instanceId) {
  const digest = crypto.createHash("sha256").update(`${controlPlaneId}\0${instanceId}`).digest("hex").slice(0, 32);
  return `persist:task-handoff-browser-${digest}`;
}

async function responseData(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body?.error?.message || `Browser access failed with HTTP ${response.status}.`), { code: body?.error?.code });
  return body.data ?? body;
}

module.exports = { DesktopBrowserContextManager, partitionName };
