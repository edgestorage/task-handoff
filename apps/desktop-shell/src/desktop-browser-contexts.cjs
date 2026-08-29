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
    this.contexts = new Map();
    this.contextCreations = new Map();
    this.references = new Map();
  }

  async prepare(input) {
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
    const key = `${controlPlaneId}\0${input.instanceId}`;
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
    const contextId = `browser_context_${crypto.randomUUID().replace(/-/g, "")}`;
    context.references += 1;
    this.references.set(contextId, { key, senderId: input.senderId });
    return { contextId, partition: context.partition };
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
      return { ...input, partition, browserSession, channel, socks, downloadHandler, references: 0 };
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
    const context = this.contexts.get(reference.key);
    if (!context) return true;
    context.references -= 1;
    if (context.references > 0) return true;
    this.contexts.delete(reference.key);
    await this.disposeContext(context);
    return true;
  }

  async releaseSender(senderId) {
    const ids = [...this.references].filter(([, reference]) => reference.senderId === senderId).map(([id]) => id);
    await Promise.all(ids.map((id) => this.release(id, senderId)));
  }

  async close() {
    await Promise.all([...new Set([...this.references.values()].map((reference) => reference.senderId))].map((senderId) => this.releaseSender(senderId)));
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
