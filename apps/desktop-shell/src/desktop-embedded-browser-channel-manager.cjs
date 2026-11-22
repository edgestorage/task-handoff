const crypto = require("node:crypto");
const {
  EMBEDDED_BROWSER_MAX_PAGES_PER_SOURCE,
  EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK,
  EmbeddedBrowserSourceConnectionSchema,
  EmbeddedBrowserSourceSnapshotCommitSchema,
} = loadEmbeddedBrowserProtocol();
const { EmbeddedBrowserChannelClient } = require("./embedded-browser-channel.cjs");

function loadEmbeddedBrowserProtocol() {
  try {
    return require("../../../dist/embedded-browser-control.js");
  } catch {
    // The packaged runtime builds dist first; source tests resolve the workspace export.
    return require("@task-handoff/protocol/embedded-browser-control");
  }
}

class DesktopEmbeddedBrowserChannelManager {
  constructor(options = {}) {
    this.fetch = options.fetch;
    this.WebSocket = options.WebSocket;
    this.registry = options.registry;
    this.ChannelClient = options.ChannelClient || EmbeddedBrowserChannelClient;
    this.logInfo = options.logInfo || (() => undefined);
    this.logError = options.logError || (() => undefined);
    this.sessions = new Map();
    this.closed = false;
  }

  async ensureSource(input) {
    if (this.closed) throw browserChannelError("BROWSER_CONTROL_UNSUPPORTED", "Browser control is shutting down.");
    const key = sessionKey(input.senderId, input.instanceId);
    const existing = this.sessions.get(key);
    if (existing && !existing.closed && existing.controlPlaneUrl === input.controlPlaneUrl) return existing;
    if (existing) await this.releaseKey(key);
    const session = {
      key,
      controlPlaneUrl: input.controlPlaneUrl,
      instanceId: input.instanceId,
      senderId: input.senderId,
      host: input.host,
      hostLabel: input.hostLabel,
      pageHost: input.pageHost,
      pageHostCapabilities: input.pageHostCapabilities,
      sourceRef: undefined,
      generation: undefined,
      registryEpoch: undefined,
      registryRevision: 0,
      revision: 1,
      pending: new Map(),
      pendingCreatedNotices: new Map(),
      leases: new Map(),
      flushPromise: undefined,
      channel: undefined,
      ready: false,
      closed: false,
    };
    this.sessions.set(key, session);
    try {
      await this.connectSession(session);
      return session;
    } catch (error) {
      await this.releaseKey(key);
      throw error;
    }
  }

  async connectSession(session) {
    const registration = await this.request(session, `/api/controlled-instances/${encodeURIComponent(session.instanceId)}/browser-control/sources`, {
      method: "POST",
      body: {
        displayName: "TaskHandoff Desktop",
        hostLabel: session.hostLabel || `Desktop window ${session.senderId}`,
        publisherRef: `desktop:${session.senderId}:${session.instanceId}`,
        rendererHostBinding: `renderer-host:${crypto.randomUUID()}`,
        pageHost: session.pageHost,
        pageHostCapabilities: session.pageHostCapabilities,
      },
    });
    const { source, connection } = EmbeddedBrowserSourceConnectionSchema.parse(registration);
    session.sourceRef = source.sourceRef;
    session.generation = source.generation;
    session.registryEpoch = connection.registryEpoch;
    session.registryRevision = connection.registryRevision;

    const pages = this.registryPages(session);
    const commit = await this.commitSnapshot(session, pages);
    session.registryEpoch = commit.registryEpoch;
    session.registryRevision = commit.registryRevision;
    session.revision = commit.sourceRevision;

    const relayUrl = new URL(connection.relayPath, session.controlPlaneUrl);
    relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
    const channel = new this.ChannelClient({
      url: relayUrl.toString(),
      token: connection.token,
      WebSocket: this.WebSocket,
      sourceRef: session.sourceRef,
      generation: session.generation,
      registryEpoch: session.registryEpoch,
      registryRevision: session.registryRevision,
      pageHost: session.pageHost,
      pageHostCapabilities: session.pageHostCapabilities,
      adapter: this.channelAdapter(session),
      logInfo: this.logInfo,
      logError: this.logError,
    });
    session.channel = channel;
    channel.on("sync-required", () => { void this.flush(session, [], [], true); });
    channel.on("closed", () => {
      session.ready = false;
      if (!session.closed) this.logError(`[desktop-shell] browser control channel closed source=${session.sourceRef} generation=${session.generation}`);
    });
    await channel.connect();
    if (session.closed) {
      channel.close();
      return;
    }
    session.ready = true;
    this.logInfo(`[desktop-shell] browser control channel ready source=${session.sourceRef} generation=${session.generation} tabs=${pages.length}`);
    await this.flush(session, [], []);
    this.flushCreatedNotices(session);
  }

  async commitSnapshot(session, entries) {
    if (entries.length > EMBEDDED_BROWSER_MAX_PAGES_PER_SOURCE) {
      throw browserChannelError("BROWSER_LIMIT_EXCEEDED", "Too many browser tabs to publish.");
    }
    const snapshotRef = `snapshot_${crypto.randomUUID().replace(/-/g, "")}`;
    const pages = entries.map((entry) => this.pageForEntry(session, entry, 1));
    const chunks = pages.length
      ? Array.from({ length: Math.ceil(pages.length / EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK) }, (_, index) => pages.slice(
        index * EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK,
        (index + 1) * EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK,
      ))
      : [[]];
    let commit;
    for (let index = 0; index < chunks.length; index += 1) {
      commit = await this.request(session, `/api/controlled-instances/${encodeURIComponent(session.instanceId)}/browser-control/sources/${encodeURIComponent(session.sourceRef)}/snapshot`, {
        method: "PUT",
        body: {
          sourceRef: session.sourceRef,
          generation: session.generation,
          sourceRevision: 1,
          registryEpoch: session.registryEpoch,
          snapshotRef,
          chunkIndex: index,
          chunkCount: chunks.length,
          complete: index === chunks.length - 1,
          pages: chunks[index],
        },
      });
    }
    return EmbeddedBrowserSourceSnapshotCommitSchema.parse(commit);
  }

  handleRegistryChange(change) {
    if (this.closed || !change?.entry?.instanceId) return;
    const session = this.sessions.get(sessionKey(change.senderId, change.entry.instanceId));
    if (!session || session.closed) return;
    const tabRef = change.entry.tabRef;
    const existing = session.pending.get(tabRef);
    // A page can emit `registered` and then `updated` before the first delta
    // is acknowledged. Keep the creation notice until the registered delta is
    // committed so the instance can still complete the exact creationRef.
    const type = existing?.type === "registered" && change.type === "updated"
      ? "registered"
      : change.type;
    session.pending.set(tabRef, {
      type,
      reason: change.reason ?? existing?.reason,
      entry: change.entry,
      ...(change.creationRef || existing?.creationRef
        ? { creationRef: change.creationRef || existing.creationRef }
        : {}),
    });
    void this.flush(session, [], []);
  }

  async flush(session, upserts, removes, force = false) {
    if (session.closed || !session.sourceRef) return;
    if (session.flushPromise) {
      await session.flushPromise.catch(() => undefined);
      return this.flush(session, [], [], force);
    }
    const created = [];
    const removed = [];
    for (const [tabRef, change] of session.pending) {
      session.pending.delete(tabRef);
      if (change.type === "removed") {
        removes.push(tabRef);
        removed.push({ tabRef, reason: change.reason, creationRef: change.creationRef });
        session.pendingCreatedNotices.delete(tabRef);
      } else {
        const page = this.pageForEntry(session, change.entry, session.revision + 1);
        upserts.push(page);
        if (change.type === "registered") created.push({ page, creationRef: change.creationRef });
      }
    }
    if (!upserts.length && !removes.length && !force) return;
    const release = { upserts, removes };
    const revision = session.revision + 1;
    session.flushPromise = this.request(session, `/api/controlled-instances/${encodeURIComponent(session.instanceId)}/browser-control/sources/${encodeURIComponent(session.sourceRef)}/deltas`, {
      method: "POST",
      body: {
        sourceRef: session.sourceRef,
        generation: session.generation,
        baseRevision: session.revision,
        revision,
        upserts: release.upserts.map((page) => ({ ...page, revision })),
        removes: release.removes,
      },
    }).then(() => {
      session.revision = revision;
      for (const entry of created) this.queueCreatedNotice(session, entry);
      this.flushCreatedNotices(session);
      if (session.channel?.state === "ready") {
        for (const entry of removed) {
          session.channel.notifyTabDestroyed(entry.tabRef, entry.reason || "tab-destroyed", entry.creationRef);
        }
      }
    }).catch((error) => {
      for (const page of release.upserts) {
        const current = session.pending.get(page.tabRef);
        if (!current) {
          const createdEntry = created.find((entry) => entry.page.tabRef === page.tabRef);
          session.pending.set(page.tabRef, {
            type: createdEntry ? "registered" : "updated",
            entry: page,
            ...(createdEntry?.creationRef ? { creationRef: createdEntry.creationRef } : {}),
          });
        }
      }
      for (const tabRef of release.removes) {
        if (!session.pending.has(tabRef)) {
          const removedEntry = removed.find((entry) => entry.tabRef === tabRef);
          session.pending.set(tabRef, {
            type: "removed",
            entry: { tabRef },
            ...(removedEntry?.creationRef ? { creationRef: removedEntry.creationRef } : {}),
          });
        }
      }
      this.logError(`[desktop-shell] browser source delta failed source=${session.sourceRef} generation=${session.generation} error=${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      session.flushPromise = undefined;
    });
    await session.flushPromise;
    if (session.pending.size) return this.flush(session, [], []);
  }

  queueCreatedNotice(session, { page, creationRef }) {
    session.pendingCreatedNotices.set(page.tabRef, { page, ...(creationRef ? { creationRef } : {}) });
  }

  flushCreatedNotices(session) {
    if (session.closed || session.channel?.state !== "ready") return;
    for (const [tabRef, notice] of session.pendingCreatedNotices) {
      if (session.channel.notifyTabCreated(notice.page, notice.creationRef)) {
        session.pendingCreatedNotices.delete(tabRef);
      }
    }
  }

  channelAdapter(session) {
    return {
      openTab: async (params) => {
        if (!session.host || session.host.isDestroyed?.()) throw browserChannelError("BROWSER_WINDOW_UNAVAILABLE", "Desktop window is unavailable.");
        if (!browserPageUrlAllowed(params.url)) throw browserChannelError("BROWSER_OPERATION_UNSUPPORTED", "Browser URL is not allowed.");
        session.host.send("task-handoff:browser-new-tab", {
          url: params.url,
          title: params.title,
          instanceId: session.instanceId,
          creationRef: params.creationRef,
        });
        return { accepted: true };
      },
      attachTarget: async (params) => {
        const tab = this.registry.attachDebugger({ tabRef: params.tabRef, senderId: session.senderId });
        session.leases.set(params.leaseRef, { tabRef: params.tabRef, generation: params.generation });
        return { attached: true, tab };
      },
      detachTarget: async (params) => {
        session.leases.delete(params.leaseRef);
        return { detached: Boolean(this.registry.detachDebugger({ tabRef: params.tabRef, senderId: session.senderId })) };
      },
      sendCdp: async (params) => {
        const lease = session.leases.get(params.leaseRef);
        if (!lease || lease.generation !== session.generation) throw browserChannelError("BROWSER_LEASE_STALE", "Browser lease is stale.");
        if (params.frameSessionRef) throw browserChannelError("BROWSER_OPERATION_UNSUPPORTED", "Descendant CDP sessions are not supported yet.");
        return this.registry.sendCommand({ tabRef: lease.tabRef, senderId: session.senderId, method: params.method, params: params.params });
      },
      closeTab: async (params) => {
        const tabRef = String(params?.tabRef || "").trim();
        if (!tabRef) throw browserChannelError("BROWSER_TAB_NOT_FOUND", "Browser tab was not found.");
        await this.registry.close({ tabRef, senderId: session.senderId });
        return { closed: true };
      },
      cancelRequest: async () => ({}),
    };
  }

  handleCdpEvent({ tabRef, method, params }) {
    for (const session of this.sessions.values()) {
      for (const [leaseRef, lease] of session.leases) {
        if (lease.tabRef === tabRef && session.channel?.state === "ready") {
          session.channel.notifyCdpEvent({ leaseRef, tabRef, method, params });
          return;
        }
      }
    }
  }

  handleTargetDetached({ tabRef, reason }) {
    for (const session of this.sessions.values()) {
      for (const [leaseRef, lease] of session.leases) {
        if (lease.tabRef !== tabRef) continue;
        session.leases.delete(leaseRef);
        if (session.channel?.state === "ready") session.channel.notifyTargetDetached(leaseRef, tabRef, String(reason || "detached"));
      }
    }
  }

  infoFor(senderId, instanceId) {
    const session = this.sessions.get(sessionKey(senderId, instanceId));
    if (!session || session.closed) return undefined;
    return {
      sourceRef: session.sourceRef,
      generation: session.generation,
      pageHost: session.pageHost,
      pageHostCapabilities: session.pageHostCapabilities,
      ready: session.ready,
    };
  }

  registryPages(session) {
    return this.registry.list({ senderId: session.senderId, instanceId: session.instanceId });
  }

  pageForEntry(session, entry, revision) {
    return {
      sourceRef: session.sourceRef,
      generation: session.generation,
      tabRef: entry.tabRef,
      instanceId: session.instanceId,
      pageHost: session.pageHost,
      pageHostCapabilities: session.pageHostCapabilities,
      title: entry.title || "",
      url: entry.url || "about:blank",
      state: entry.state || "attached",
      revision,
    };
  }

  async releaseSender(senderId) {
    const keys = [...this.sessions.values()].filter((session) => session.senderId === senderId).map((session) => session.key);
    await Promise.all(keys.map((key) => this.releaseKey(key)));
  }

  async releaseKey(key) {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    session.closed = true;
    session.ready = false;
    session.channel?.close();
    if (session.sourceRef) {
      await this.request(session, `/api/controlled-instances/${encodeURIComponent(session.instanceId)}/browser-control/sources/${encodeURIComponent(session.sourceRef)}`, { method: "DELETE" })
        .catch((error) => this.logInfo?.(`[desktop-shell] browser source revoke failed source=${session.sourceRef} error=${error instanceof Error ? error.message : String(error)}`));
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.sessions.keys()].map((key) => this.releaseKey(key)));
  }

  async request(session, path, init = {}) {
    const headers = { ...(init.headers || {}) };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetch(new URL(path, session.controlPlaneUrl).toString(), {
      method: init.method || "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw browserChannelError(
        payload?.error?.code || "BROWSER_CONTROL_UNSUPPORTED",
        payload?.error?.message || `Browser control request failed with HTTP ${response.status}.`,
      );
    }
    return payload.data ?? payload;
  }
}

function sessionKey(senderId, instanceId) {
  return `${senderId}\0${instanceId}`;
}

function browserPageUrlAllowed(value) {
  try {
    const url = new URL(String(value));
    return url.href === "about:blank" || url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function browserChannelError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = { DesktopEmbeddedBrowserChannelManager };
