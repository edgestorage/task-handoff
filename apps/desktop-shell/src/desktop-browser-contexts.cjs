const crypto = require("node:crypto");
const { BrowserTunnelChannel } = require("./browser-tunnel-channel.cjs");
const { BrowserSocksServer } = require("./browser-socks-server.cjs");

class DesktopBrowserContextManager {
  constructor(options) {
    this.fetch = options.fetch;
    this.WebSocket = options.WebSocket;
    this.session = options.session;
    this.chooseDownloadPath = options.chooseDownloadPath;
    this.BrowserTunnelChannel = options.BrowserTunnelChannel || BrowserTunnelChannel;
    this.BrowserSocksServer = options.BrowserSocksServer || BrowserSocksServer;
    this.logInfo = options.logInfo;
    this.logError = options.logError;
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
      socks = new this.BrowserSocksServer(channel);
      const address = await socks.start();
      const partition = partitionName(input.controlPlaneId, input.instanceId);
      browserSession = this.session.fromPartition(partition, { cache: true });
      await browserSession.setProxy({
        mode: "fixed_servers",
        proxyRules: `socks5://${address.host}:${address.port}`,
        proxyBypassRules: "<-loopback>",
      });
      browserSession.setPermissionCheckHandler?.(() => false);
      browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      const downloadHandler = (_event, item) => {
        const savePath = this.chooseDownloadPath?.(item.getFilename());
        if (savePath) item.setSavePath(savePath);
        else item.cancel();
      };
      browserSession.on("will-download", downloadHandler);
      return { ...input, partition, browserSession, channel, socks, downloadHandler };
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
